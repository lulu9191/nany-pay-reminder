/**
 * 发薪日推算核心模块（v2）
 *
 * 周期语义：
 * - 从「结算起点」当天起算，数到第 N 个工作日（默认 22）= 该期发薪日
 * - 「工作日」由三个可配置因素决定（按优先级）：
 *   1. 临时标记 dayOverrides：某天手动标记上班/休息，最优先
 *   2. 法定节假日 followHoliday：开启时，节假日不计、调休补班日计入
 *   3. 每周休息日 restWeekdays：周一~周日任意组合，空数组=全周上班
 * - 记录已发薪「不改变」任何计算：晚几天转账，下一期仍按原计划滚动。
 *   只有「调整结算起点」（anchorOverride）才会让周期从新日期重新起算。
 */

const { parseDate, formatDate } = require('./holiday');

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 每期最多扫描 800 个自然日：覆盖 60 个工作日、每周仅上班一天的设置，
// 同时让全周休息等无法结算的配置及时返回，不限制累计历史期数。
const MAX_DAYS_PER_CYCLE = 800;

function isValidDate(dateStr) {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) &&
    formatDate(parseDate(dateStr)) === dateStr;
}

function weekdayLabel(dateStr) {
  return WEEKDAY_NAMES[parseDate(dateStr).getDay()];
}

/** 兼容旧配置字段，统一为 v2 结构 */
function normalizeCfg(config) {
  const cfg = config || {};
  let restWeekdays = cfg.restWeekdays;
  if (!Array.isArray(restWeekdays)) {
    restWeekdays = cfg.includeWeekend === false ? [0, 6] : [];
  }
  return {
    startDate: cfg.startDate || '',
    cycleDays: cfg.cycleDays === undefined ? 22 : cfg.cycleDays,
    restWeekdays,
    followHoliday: cfg.followHoliday !== false,
    dayOverrides: cfg.dayOverrides || {},
    anchorOverride: cfg.anchorOverride || '',
  };
}

function isValidConfig(cfg) {
  return isValidDate(cfg.startDate) &&
    Number.isInteger(cfg.cycleDays) && cfg.cycleDays >= 1 && cfg.cycleDays <= 60 &&
    cfg.restWeekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    (!cfg.anchorOverride || (isValidDate(cfg.anchorOverride) && cfg.anchorOverride >= cfg.startDate));
}

function nextDay(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + 1);
  const next = formatDate(d);
  return isValidDate(next) ? next : null;
}

/**
 * 判断某日是否计入周期（工作日）
 * @returns {boolean}
 */
function isWorkday(dateStr, cfg, holidayMap) {
  return dayInfo(dateStr, cfg, holidayMap).work;
}

/**
 * 某日的计入判定与原因（用于计算明细展示）
 * @returns {{work: boolean, label: string, overridden: boolean}}
 */
function dayInfo(dateStr, cfg, holidayMap) {
  const ov = cfg.dayOverrides ? cfg.dayOverrides[dateStr] : null;
  if (ov === 'work') return { work: true, label: '临时标记上班', overridden: true };
  if (ov === 'rest') return { work: false, label: '临时标记休息', overridden: true };

  const hol = holidayMap ? holidayMap[dateStr] : null;
  if (cfg.followHoliday && hol) {
    if (hol.holiday) return { work: false, label: '法定节假日', overridden: false };
    return { work: true, label: '调休补班日', overridden: false };
  }

  const wd = parseDate(dateStr).getDay();
  if (cfg.restWeekdays.indexOf(wd) !== -1) {
    return { work: false, label: '每周休息日', overridden: false };
  }
  return { work: true, label: '正常计入', overridden: false };
}

/**
 * 从 anchorDate（含当天）数第 n 个工作日的日期
 * @returns {string|null} 超出保护上限返回 null
 */
function nthWorkday(anchorDate, n, cfg, holidayMap, limitDays = MAX_DAYS_PER_CYCLE) {
  if (!isValidDate(anchorDate) || !Number.isInteger(n) || n < 1 ||
      !Number.isInteger(limitDays) || limitDays < 1) return null;
  let cursor = parseDate(anchorDate);
  let count = 0;
  for (let i = 0; i < limitDays; i++) {
    const ds = formatDate(cursor);
    if (!isValidDate(ds)) return null;
    if (isWorkday(ds, cfg, holidayMap)) {
      count++;
      if (count === n) return ds;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

/**
 * 从入职日依次生成周期，保留每一期的真实起点。
 * 调整起点前已完成的周期继续保留；跨越调整起点的未完成周期丢弃，
 * 从新起点续编号。没有累计期数上限，直到得到指定数量的未来周期。
 */
function buildPeriods(cfg, holidayMap, today, futureCount) {
  const periods = [];
  let anchor = cfg.startDate;
  let futurePeriods = 0;
  while (anchor) {
    const date = nthWorkday(anchor, cfg.cycleDays, cfg, holidayMap);
    if (cfg.anchorOverride && anchor < cfg.anchorOverride &&
        (!date || date >= cfg.anchorOverride)) {
      anchor = cfg.anchorOverride;
      continue;
    }
    if (!date) break;
    const isFuture = date >= today;
    periods.push({
      cycle: periods.length + 1,
      date,
      weekday: weekdayLabel(date),
      cycleStart: anchor,
      isNext: isFuture && futurePeriods === 0,
    });
    if (isFuture) futurePeriods++;
    if (futurePeriods >= futureCount) break;
    anchor = nextDay(date);
  }
  return periods;
}

/**
 * 构建发薪计划
 * @param {Object} config 配置（兼容 v1/v2 字段）
 * @param {Object|null} holidayMap
 * @param {string} today YYYY-MM-DD
 * @param {number} futureCount 往后列出多少个发薪日
 * @returns {Object|null} { nextSettlement, remainingNaturalDays, remainingWorkdays, doneWorkdays,
 *   progressPercent, cycleIndex, cycleStart, schedule: [...], periods: [...], isPaydayToday }
 * periods 包含历史和未来周期，schedule 只包含今天及以后的周期。
 */
function buildPaySchedule(config, holidayMap, today, futureCount = 6) {
  const cfg = normalizeCfg(config);
  if (!isValidConfig(cfg) || !isValidDate(today) ||
      !Number.isSafeInteger(futureCount) || futureCount < 1) return null;

  const periods = buildPeriods(cfg, holidayMap, today, futureCount);
  const schedule = periods.filter((period) => period.date >= today);
  if (!schedule.length) return null;

  const nextPeriod = schedule[0];
  const nextSettlement = nextPeriod.date;
  const cycleIndex = nextPeriod.cycle;
  const isPaydayToday = nextSettlement === today;

  // 剩余自然日
  const remainingNaturalDays = Math.round(
    (parseDate(nextSettlement) - parseDate(today)) / 86400000
  );

  // 尚未开始工作时，从本期起点数起，不把入职/调整起点之前的日期计入。
  let remainingWorkdays = 0;
  let cursor = parseDate(today > nextPeriod.cycleStart ? today : nextPeriod.cycleStart);
  const settlementDate = parseDate(nextSettlement);
  while (cursor <= settlementDate) {
    if (isWorkday(formatDate(cursor), cfg, holidayMap)) remainingWorkdays++;
    cursor.setDate(cursor.getDate() + 1);
  }

  // 本期进度：发薪日当天视为 100%（当天就是最后一天，不再是 21/22）
  const doneWorkdays = isPaydayToday
    ? cfg.cycleDays
    : Math.max(0, cfg.cycleDays - remainingWorkdays);
  const progressPercent = Math.min(100, Math.round((doneWorkdays / cfg.cycleDays) * 100));

  return {
    nextSettlement,
    nextWeekday: weekdayLabel(nextSettlement),
    remainingNaturalDays,
    remainingWorkdays,
    doneWorkdays,
    progressPercent,
    cycleIndex,
    cycleStart: nextPeriod.cycleStart,
    isPaydayToday,
    schedule,
    periods,
  };
}

/**
 * 本期计算明细：从本期起点到结算日，逐日给出计入/跳过及原因
 * @returns {Object|null}
 *   { cycleStart, settlementDate, totalWorkdays, skipped, days: [{date, weekday, work, label, count, isSettlement}] }
 */
function buildCycleDetail(config, holidayMap, cycleSettlement) {
  const cfg = normalizeCfg(config);
  if (!isValidConfig(cfg) || !isValidDate(cycleSettlement)) return null;
  const periods = buildPeriods(cfg, holidayMap, cycleSettlement, 1);
  const period = periods.find((item) => item.date === cycleSettlement);
  if (!period) return null;
  const cycleStart = period.cycleStart;

  const days = [];
  let count = 0;
  let skipped = 0;
  const cur = parseDate(cycleStart);
  while (true) {
    const ds = formatDate(cur);
    const info = dayInfo(ds, cfg, holidayMap);
    if (info.work) {
      count++;
      days.push({
        date: ds,
        weekday: weekdayLabel(ds),
        work: true,
        label: info.label,
        count,
        isSettlement: ds === cycleSettlement,
      });
    } else {
      skipped++;
      days.push({
        date: ds,
        weekday: weekdayLabel(ds),
        work: false,
        label: info.label,
        count: null,
        isSettlement: false,
      });
    }
    if (ds === cycleSettlement) break;
    cur.setDate(cur.getDate() + 1);
  }

  return {
    cycleStart,
    settlementDate: cycleSettlement,
    totalWorkdays: count,
    skipped,
    days,
  };
}

module.exports = {
  isWorkday,
  dayInfo,
  nthWorkday,
  buildPaySchedule,
  buildCycleDetail,
  weekdayLabel,
  normalizeCfg,
};
