/** 本地存储：配置、发薪记录、日历写入记录与备份。 */
const { normalizeSnapshot } = require('./payslip');
const STORAGE_KEY = 'payroll_config';
const CALENDAR_ADDED_KEY = 'calendar_added_dates';
const CALENDAR_REVIEW_KEY = 'calendar_review_required';
const RECORDS_KEY = 'pay_records';

const DEFAULT_CONFIG = {
  startDate: '',
  cycleDays: 22,
  restWeekdays: [],
  followHoliday: true,
  dayOverrides: {},
  anchorOverride: '',
  recordStartCycle: 0,
};
const BACKUP_APP_TAG = 'nanny-pay-reminder';
const BACKUP_VERSION = 1;

function storeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 检查真实日历日期，避免 Date 把 2 月 30 日自动变成 3 月。 */
function isDate(value, allowEmpty = false) {
  if (allowEmpty && value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function defaultConfig() {
  return Object.assign({}, DEFAULT_CONFIG, { restWeekdays: [], dayOverrides: {} });
}

function migrateConfig(saved) {
  const config = Object.assign(defaultConfig(), saved);
  if (!Object.prototype.hasOwnProperty.call(saved, 'restWeekdays') && saved.includeWeekend !== undefined) {
    config.restWeekdays = saved.includeWeekend ? [] : [0, 6];
  }
  delete config.includeWeekend;
  return config;
}

function loadConfig() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY) || {};
    return migrateConfig(saved);
  } catch (e) {
    return defaultConfig();
  }
}

/** 排序后比较语义，选中顺序或旧字段迁移不算规则变更。 */
function ruleSignature(config) {
  const cfg = migrateConfig(config);
  const overrides = cfg.dayOverrides || {};
  return JSON.stringify([
    cfg.startDate, cfg.cycleDays,
    Array.isArray(cfg.restWeekdays) ? cfg.restWeekdays.slice().sort() : cfg.restWeekdays,
    cfg.followHoliday, cfg.anchorOverride,
    Object.keys(overrides).sort().map((day) => [day, overrides[day]]),
  ]);
}

function saveConfig(patch) {
  const previous = loadConfig();
  const merged = Object.assign({}, previous, patch);
  if (ruleSignature(previous) !== ruleSignature(merged) && getCalendarAdded().length) {
    // 先标记，再保存规则；即使后一次写入失败也不会漏掉旧提醒的处理提示。
    wx.setStorageSync(CALENDAR_REVIEW_KEY, true);
  }
  wx.setStorageSync(STORAGE_KEY, merged);
  return merged;
}

/* ---------------- 发薪记录 ---------------- */

function normalizeRecord(record, allowMissingId = false) {
  if (!isObject(record)) throw new Error('发薪记录必须是完整对象');
  const missingId = record.id === undefined || record.id === '';
  if ((!allowMissingId || !missingId) && (typeof record.id !== 'string' || !record.id.trim())) {
    throw new Error('发薪记录编号无效');
  }
  if (!Number.isSafeInteger(record.cycle) || record.cycle < 1) throw new Error('发薪期数必须是正整数');
  if (!isDate(record.actualDate)) throw new Error('实际发薪日期无效');
  const plannedDate = record.plannedDate === undefined ? '' : record.plannedDate;
  if (!isDate(plannedDate, true)) throw new Error('应发日期无效');
  const amount = record.amount === undefined ? null : record.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER)) {
    throw new Error('发薪金额必须是有效的非负数字或留空');
  }
  const note = record.note === undefined ? '' : record.note;
  if (typeof note !== 'string') throw new Error('发薪备注必须是文字');
  const result = { id: missingId ? '' : record.id, cycle: record.cycle, plannedDate, actualDate: record.actualDate, amount, note };
  [['recipientName', 40, '称呼'], ['shareNote', 500, '给对方的说明']].forEach(([key, maxLength, label]) => {
    if (record[key] === undefined) return;
    if (typeof record[key] !== 'string' || record[key].length > maxLength) throw new Error(label + '必须是最多 ' + maxLength + ' 字的文字');
    result[key] = record[key].trim();
  });
  if (record.periodSnapshot !== undefined) {
    result.periodSnapshot = normalizeSnapshot(record.periodSnapshot);
    if (plannedDate && result.periodSnapshot.settlementDate !== plannedDate) throw new Error('发薪单结算日与记录不一致');
  }
  return result;
}

function newRecordId(usedIds) {
  const base = 'r' + Date.now() + Math.floor(Math.random() * 10000);
  let id = base;
  let suffix = 0;
  while (usedIds.has(id)) id = base + '_' + (++suffix);
  return id;
}

function normalizeRecords(records, allowMissingIds = false, allowDuplicateCycles = false) {
  if (!Array.isArray(records)) throw new Error('发薪记录必须是列表');
  const ids = new Set();
  const cycles = new Set();
  const normalized = records.map((record) => {
    const result = normalizeRecord(record, allowMissingIds);
    if (result.id && ids.has(result.id)) throw new Error('备份中存在重复的发薪记录编号');
    if (!allowDuplicateCycles && cycles.has(result.cycle)) throw new Error('第 ' + result.cycle + ' 期有重复发薪记录，请先整理后再恢复');
    if (result.id) ids.add(result.id);
    cycles.add(result.cycle);
    return result;
  });
  normalized.forEach((record) => {
    if (!record.id) {
      record.id = newRecordId(ids);
      ids.add(record.id);
    }
  });
  return normalized;
}

function getRecords() {
  let records;
  try {
    records = wx.getStorageSync(RECORDS_KEY);
  } catch (error) {
    throw storeError('RECORDS_READ_FAILED', '无法读取发薪记录，请重试；现有记录未被覆盖', error);
  }
  if (records === '' || records === undefined) return [];
  let normalized;
  try {
    // 历史重复期数保留供用户撤销，不能为了去重静默丢掉真实记录。
    normalized = normalizeRecords(records, true, true);
  } catch (error) {
    throw storeError('RECORDS_INVALID', '本地发薪记录格式异常，现有数据已保留：' + error.message, error);
  }
  if (records.some((record) => !record.id)) {
    try {
      wx.setStorageSync(RECORDS_KEY, normalized);
    } catch (error) {
      throw storeError('RECORDS_WRITE_FAILED', '无法修复旧记录编号，请重试', error);
    }
  }
  return normalized;
}

/** 新增同一期更新原记录并保留编号；编辑不能覆盖另一条记录。 */
function saveRecord(rec) {
  let incoming;
  try {
    incoming = normalizeRecord(rec, true);
  } catch (error) {
    throw storeError('RECORD_INVALID', error.message, error);
  }
  const records = getRecords();
  const editIndex = incoming.id ? records.findIndex((record) => record.id === incoming.id) : -1;
  if (incoming.id && editIndex < 0) throw storeError('RECORD_NOT_FOUND', '这条记录已不存在，请关闭表单后重试');
  const sameCycle = records.filter((record) => record.cycle === incoming.cycle);
  if (sameCycle.length > 1 || (incoming.id && sameCycle.some((record) => record.id !== incoming.id))) {
    throw storeError('RECORD_CONFLICT', '第 ' + incoming.cycle + ' 期已有其他记录，请先编辑或撤销原记录');
  }
  const existing = incoming.id ? records[editIndex] : sameCycle[0];
  const saved = Object.assign({}, existing, incoming, {
    id: existing ? existing.id : newRecordId(new Set(records.map((record) => record.id))),
  });
  // 旧调用方没有传分享字段时保留已保存的数据；合并后再次核对日期一致性。
  if (saved.periodSnapshot && saved.plannedDate && saved.periodSnapshot.settlementDate !== saved.plannedDate) {
    throw storeError('RECORD_INVALID', '发薪单结算日与记录不一致');
  }
  if (existing) records[records.findIndex((record) => record.id === existing.id)] = saved;
  else records.push(saved);
  records.sort((a, b) => a.actualDate.localeCompare(b.actualDate));
  try {
    wx.setStorageSync(RECORDS_KEY, records);
  } catch (error) {
    throw storeError('RECORDS_WRITE_FAILED', '发薪记录保存失败，请重试', error);
  }
  return saved;
}

function deleteRecord(id) {
  const records = getRecords().filter((record) => record.id !== id);
  wx.setStorageSync(RECORDS_KEY, records);
  return records;
}

function getRecordByCycle(cycle) {
  return getRecords().find((record) => record.cycle === cycle) || null;
}

function isRecording() {
  return !!loadConfig().recordStartCycle || getRecords().length > 0;
}

/* ---------------- 日历写入记录 ---------------- */

function getCalendarAdded() {
  try {
    const dates = wx.getStorageSync(CALENDAR_ADDED_KEY) || [];
    return Array.isArray(dates) ? dates.slice() : [];
  } catch (e) {
    return [];
  }
}

function getCalendarReviewRequired() {
  return wx.getStorageSync(CALENDAR_REVIEW_KEY) === true;
}

function addCalendarAdded(dates) {
  const set = new Set(getCalendarAdded().concat(dates));
  wx.setStorageSync(CALENDAR_ADDED_KEY, Array.from(set).sort());
}

/** 多项恢复写入前留存原值；中途失败逐项回滚，不把部分恢复报告为成功。 */
function writeWithRollback(entries, prefix, action) {
  let snapshots;
  try {
    const keys = typeof wx.getStorageInfoSync === 'function' ? wx.getStorageInfoSync().keys : null;
    snapshots = entries.map(([key]) => {
      const value = wx.getStorageSync(key);
      return { key, value, exists: keys ? keys.indexOf(key) !== -1 : value !== '' && value !== undefined };
    });
  } catch (error) {
    throw storeError(prefix + '_READ_FAILED', action + '失败：无法读取原数据，未做修改', error);
  }
  let attempted = 0;
  try {
    entries.forEach(([key, value]) => {
      attempted++;
      wx.setStorageSync(key, value);
    });
  } catch (error) {
    let rollbackFailed = false;
    snapshots.slice(0, attempted).reverse().forEach((snapshot) => {
      try {
        if (!snapshot.exists && typeof wx.removeStorageSync === 'function') wx.removeStorageSync(snapshot.key);
        else wx.setStorageSync(snapshot.key, snapshot.value);
      } catch (rollbackError) {
        rollbackFailed = true;
      }
    });
    if (rollbackFailed) {
      throw storeError(prefix + '_ROLLBACK_FAILED', action + '失败，且部分原数据未能还原。请保留备份文件，检查存储后重新恢复', error);
    }
    throw storeError(prefix + '_WRITE_FAILED', action + '失败，已还原原数据，请重试', error);
  }
}

/** 仅在用户确认已处理系统日历中的旧事项后调用。 */
function resetCalendarTracking() {
  writeWithRollback([[CALENDAR_ADDED_KEY, []], [CALENDAR_REVIEW_KEY, false]], 'CALENDAR', '重置日历记录');
}

/* ---------------- 备份与恢复 ---------------- */

function validateConfig(saved) {
  if (!isObject(saved)) throw new Error('备份缺少有效配置');
  if (!isDate(saved.startDate, true)) throw new Error('开始工作日期无效');
  if (!Number.isInteger(saved.cycleDays) || saved.cycleDays < 1 || saved.cycleDays > 60) {
    throw new Error('结算周期必须是 1 至 60 个工作日');
  }
  if (saved.includeWeekend !== undefined && typeof saved.includeWeekend !== 'boolean') throw new Error('旧版周末配置无效');
  const config = migrateConfig(saved);
  if (!Array.isArray(config.restWeekdays) || config.restWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(config.restWeekdays).size !== config.restWeekdays.length) {
    throw new Error('每周休息日必须是 0 至 6 且不重复的列表');
  }
  if (typeof config.followHoliday !== 'boolean') throw new Error('节假日设置无效');
  if (!isObject(config.dayOverrides)) throw new Error('临时上班和休息标记格式无效');
  const overrides = {};
  Object.keys(config.dayOverrides).forEach((day) => {
    const value = config.dayOverrides[day];
    if (!isDate(day) || (value !== 'work' && value !== 'rest')) throw new Error('临时上班和休息标记包含无效日期或类型');
    overrides[day] = value;
  });
  if (!isDate(config.anchorOverride, true)) throw new Error('调整结算起点日期无效');
  if (config.anchorOverride && (!config.startDate || config.anchorOverride < config.startDate)) throw new Error('结算起点不能早于开始工作日期');
  if (!Number.isSafeInteger(config.recordStartCycle) || config.recordStartCycle < 0) throw new Error('开始记录期数必须是非负整数');
  return {
    startDate: config.startDate, cycleDays: config.cycleDays,
    restWeekdays: config.restWeekdays.slice().sort(), followHoliday: config.followHoliday,
    dayOverrides: overrides, anchorOverride: config.anchorOverride, recordStartCycle: config.recordStartCycle,
  };
}

function validateBackup(data) {
  if (!isObject(data) || data.app !== BACKUP_APP_TAG) throw new Error('这不是本小程序的备份文件');
  if (data.version !== BACKUP_VERSION) throw new Error('备份版本不受支持，请使用兼容版本的小程序');
  if (data.exportedAt !== undefined && !isDate(data.exportedAt)) throw new Error('备份导出日期无效');
  const config = validateConfig(data.config);
  const records = normalizeRecords(data.records);
  const calendarAdded = data.calendarAdded === undefined ? [] : data.calendarAdded;
  if (!Array.isArray(calendarAdded) || calendarAdded.some((date) => !isDate(date)) || new Set(calendarAdded).size !== calendarAdded.length) {
    throw new Error('日历写入记录包含无效或重复日期');
  }
  return { app: BACKUP_APP_TAG, version: BACKUP_VERSION, exportedAt: data.exportedAt, config, records, calendarAdded: calendarAdded.slice() };
}

function exportData() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const exportedAt = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return JSON.stringify({
    app: BACKUP_APP_TAG, version: BACKUP_VERSION, exportedAt,
    config: loadConfig(), records: getRecords(), calendarAdded: getCalendarAdded(),
  }, null, 2);
}

/** 纯校验，不写存储；返回规范化且已迁移的预览数据。 */
function parseBackup(jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (error) {
    return { ok: false, error: '文件内容不是有效的 JSON' };
  }
  try {
    const normalized = validateBackup(data);
    return { ok: true, data: normalized, summary: { exportedAt: normalized.exportedAt || '未知日期', records: normalized.records.length } };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 重新校验再覆盖；清空写入标记，同机已有日历事项仍须由用户处理。 */
function applyBackup(data) {
  let normalized;
  try {
    normalized = validateBackup(data);
  } catch (error) {
    throw storeError('BACKUP_INVALID', error.message, error);
  }
  let reviewRequired;
  try {
    // 只看当前设备：旧设备备份里的写入记录不能证明本机存在日历事项。
    const localDates = wx.getStorageSync(CALENDAR_ADDED_KEY);
    reviewRequired = (Array.isArray(localDates) && localDates.length > 0) ||
      wx.getStorageSync(CALENDAR_REVIEW_KEY) === true;
  } catch (error) {
    throw storeError('BACKUP_READ_FAILED', '恢复备份失败：无法读取原日历状态，未做修改', error);
  }
  writeWithRollback([
    [STORAGE_KEY, normalized.config], [RECORDS_KEY, normalized.records],
    [CALENDAR_ADDED_KEY, []], [CALENDAR_REVIEW_KEY, reviewRequired],
  ], 'BACKUP', '恢复备份');
}

module.exports = {
  STORAGE_KEY, CALENDAR_ADDED_KEY, CALENDAR_REVIEW_KEY, RECORDS_KEY, DEFAULT_CONFIG,
  loadConfig, saveConfig, getRecords, saveRecord, deleteRecord, getRecordByCycle, isRecording,
  getCalendarAdded, addCalendarAdded, getCalendarReviewRequired, resetCalendarTracking,
  exportData, parseBackup, applyBackup,
};
