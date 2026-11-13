const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../utils/store');
const { createSnapshot } = require('../utils/payslip');
const { buildCycleDetail } = require('../utils/payroll');

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mockStorage(initial = {}, failWrite = () => false) {
  const data = new Map(Object.entries(copy(initial)));
  const writes = [];
  global.wx = {
    getStorageSync(key) { return data.has(key) ? copy(data.get(key)) : ''; },
    getStorageInfoSync() { return { keys: Array.from(data.keys()) }; },
    setStorageSync(key, value) {
      writes.push([key, copy(value)]);
      if (failWrite(key, value, writes.length)) throw new Error('storage full');
      data.set(key, copy(value));
    },
    removeStorageSync(key) { data.delete(key); },
  };
  return { data, writes };
}

function record(patch = {}) {
  return Object.assign({ id: 'record_1', cycle: 1, plannedDate: '2026-10-22', actualDate: '2026-10-23', amount: 5000, note: '' }, patch);
}

function backup(patch = {}) {
  return Object.assign({
    app: 'nanny-pay-reminder', version: 1, exportedAt: '2026-10-30',
    config: Object.assign({}, store.DEFAULT_CONFIG, { startDate: '2026-10-01' }),
    records: [record()], calendarAdded: ['2026-11-13'],
  }, patch);
}

function parse(data) {
  return store.parseBackup(JSON.stringify(data));
}

test('有效备份预览不写入，同机恢复清空写入标记但保留旧事项待处理提示', () => {
  const { data, writes } = mockStorage({ calendar_review_required: true, calendar_added_dates: ['2026-12-01'] });
  const result = parse(backup());
  assert.equal(result.ok, true);
  assert.equal(result.summary.records, 1);
  assert.equal(writes.length, 0);
  store.applyBackup(result.data);
  assert.equal(data.get('payroll_config').cycleDays, 22);
  assert.deepEqual(data.get('pay_records'), [record()]);
  assert.deepEqual(data.get('calendar_added_dates'), []);
  assert.equal(data.get('calendar_review_required'), true);
});

test('新手机恢复不采纳备份日历状态，可直接重新添加提醒', () => {
  const { data } = mockStorage();
  store.applyBackup(backup({ calendarAdded: ['2026-11-13'] }));
  assert.deepEqual(data.get('calendar_added_dates'), []);
  assert.equal(data.get('calendar_review_required'), false);
});

test('同机恢复检测原写入日期或原待处理标记，备份无日历日期也不能绕过', () => {
  for (const initial of [
    { calendar_added_dates: ['2026-11-13'] },
    { calendar_added_dates: [], calendar_review_required: true },
  ]) {
    const { data } = mockStorage(initial);
    store.applyBackup(backup({ calendarAdded: [] }));
    assert.deepEqual(data.get('calendar_added_dates'), []);
    assert.equal(data.get('calendar_review_required'), true);
  }
});

test('无效JSON、应用标记和未知备份版本被拒绝', () => {
  mockStorage();
  assert.equal(store.parseBackup('not json').ok, false);
  for (const bad of [null, [], {}, backup({ app: 'another' }), backup({ version: 2 }), backup({ version: '1' }), backup({ version: undefined })]) {
    assert.equal(parse(bad).ok, false);
  }
});

test('拒绝不存在的日期，包括非闰年和世纪年2月29日', () => {
  mockStorage();
  for (const startDate of ['2026-02-29', '2100-02-29', '2026-04-31', '2026-00-10', '2026-13-10', '2026-10-00', '0000-01-01', '2026-1-01', null]) {
    assert.equal(parse(backup({ config: { ...backup().config, startDate } })).ok, false, String(startDate));
  }
  for (const startDate of ['2024-02-29', '2000-02-29', '2026-04-30', '']) {
    assert.equal(parse(backup({ config: { ...backup().config, startDate } })).ok, true, startDate);
  }
  assert.equal(parse(backup({ exportedAt: '2026-02-30' })).ok, false);
});

test('周期范围、休息日、节假日及起点配置严格校验', () => {
  mockStorage();
  const invalidPatches = [
    { cycleDays: 0 }, { cycleDays: 61 }, { cycleDays: 1.5 }, { cycleDays: '22' },
    { restWeekdays: null }, { restWeekdays: [0, 7] }, { restWeekdays: [-1] },
    { restWeekdays: [1, 1] }, { restWeekdays: ['0'] }, { restWeekdays: [1.5] },
    { followHoliday: 'true' }, { includeWeekend: 1 }, { anchorOverride: '2026-09-30' },
    { anchorOverride: '2026-02-30' }, { recordStartCycle: -1 }, { recordStartCycle: 1.1 },
    { recordStartCycle: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const patch of invalidPatches) {
    assert.equal(parse(backup({ config: { ...backup().config, ...patch } })).ok, false, JSON.stringify(patch));
  }
});

test('临时日标记必须包含真实日期和work/rest值', () => {
  mockStorage();
  for (const dayOverrides of [null, [], { '2026-02-30': 'work' }, { '2026-10-31': true }, { wrong: 'rest' }]) {
    assert.equal(parse(backup({ config: { ...backup().config, dayOverrides } })).ok, false);
  }
  assert.equal(parse(backup({ config: { ...backup().config, dayOverrides: { '2026-10-31': 'rest' } } })).ok, true);
});

test('迁移旧版includeWeekend时保留原本的周末规则', () => {
  mockStorage();
  for (const includeWeekend of [false, true]) {
    const config = { startDate: '2026-10-01', cycleDays: 22, includeWeekend };
    const parsed = parse(backup({ config }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.config.restWeekdays, includeWeekend ? [] : [0, 6]);
    assert.equal(Object.hasOwn(parsed.data.config, 'includeWeekend'), false);
    store.applyBackup(parsed.data);
    assert.deepEqual(store.loadConfig().restWeekdays, includeWeekend ? [] : [0, 6]);
  }
});

test('发薪记录结构、日期、金额、期号、编号类型不合法时拒绝恢复', () => {
  mockStorage();
  const invalidRecords = [null, 'record', [], record({ id: '' }), record({ id: 1 }),
    record({ cycle: 0 }), record({ cycle: 1.5 }), record({ actualDate: '2026-02-30' }),
    record({ plannedDate: '2026-02-30' }), record({ amount: -1 }), record({ amount: '100' }),
    record({ note: [] })];
  for (const invalid of invalidRecords) assert.equal(parse(backup({ records: [invalid] })).ok, false, JSON.stringify(invalid));
  assert.equal(parse(backup({ records: null })).ok, false);
  assert.equal(parse(backup({ records: [record({ amount: null, plannedDate: '' })] })).ok, true);
  assert.throws(() => store.applyBackup(backup({ records: [record({ amount: Infinity })] })), { code: 'BACKUP_INVALID' });
});

test('重复记录编号、重复期号及无效日历日期拒绝恢复', () => {
  mockStorage();
  assert.equal(parse(backup({ records: [record(), record({ cycle: 2 })] })).ok, false);
  assert.equal(parse(backup({ records: [record(), record({ id: 'record_2' })] })).ok, false);
  for (const calendarAdded of [null, ['2026-02-30'], ['2026-11-13', '2026-11-13']]) {
    assert.equal(parse(backup({ calendarAdded })).ok, false);
  }
});

test('applyBackup重新校验，预览后被改坏的数据不能覆盖现有存储', () => {
  const initial = { payroll_config: { startDate: '2025-01-01' }, pay_records: [record()] };
  const { data, writes } = mockStorage(initial);
  const parsed = parse(backup());
  parsed.data.records = [null];
  assert.throws(() => store.applyBackup(parsed.data), { code: 'BACKUP_INVALID' });
  assert.equal(writes.length, 0);
  assert.deepEqual(Object.fromEntries(data), initial);
});

test('恢复任意步骤写入失败后还原配置、记录和日历状态', () => {
  const initial = {
    payroll_config: { startDate: '2025-01-01' }, pay_records: [record({ amount: 4000 })],
    calendar_added_dates: ['2025-01-22'], calendar_review_required: true,
  };
  for (const failAt of [1, 2, 3, 4]) {
    const { data } = mockStorage(initial, (key, value, count) => count === failAt);
    assert.throws(() => store.applyBackup(backup()), { code: 'BACKUP_WRITE_FAILED' });
    assert.deepEqual(Object.fromEntries(data), initial);
  }
});

test('恢复失败也还原原本不存在的键，读取失败时不开始写入', () => {
  let state = mockStorage({}, (key, value, count) => count === 3);
  assert.throws(() => store.applyBackup(backup()), { code: 'BACKUP_WRITE_FAILED' });
  assert.equal(state.data.size, 0);
  state = mockStorage();
  global.wx.getStorageSync = () => { throw new Error('read failed'); };
  assert.throws(() => store.applyBackup(backup()), { code: 'BACKUP_READ_FAILED' });
  assert.equal(state.writes.length, 0);
});

test('存储持续失败导致回滚不完整时明确报错', () => {
  mockStorage({ payroll_config: { startDate: '2025-01-01' } }, () => true);
  assert.throws(() => store.applyBackup(backup()), { code: 'BACKUP_ROLLBACK_FAILED' });
});

test('新增同一期时更新原记录，保留ID且累计金额不翻倍', () => {
  mockStorage({ pay_records: [record()] });
  const saved = store.saveRecord(record({ id: undefined, amount: 5100 }));
  assert.equal(saved.id, 'record_1');
  assert.equal(store.getRecords().length, 1);
  assert.equal(store.getRecords()[0].amount, 5100);
});

test('编辑另一条记录至已有期号或使用过期ID时拒绝保存', () => {
  const original = [record(), record({ id: 'record_2', cycle: 2 })];
  const { data, writes } = mockStorage({ pay_records: original });
  assert.throws(() => store.saveRecord(record({ id: 'record_2', cycle: 1 })), { code: 'RECORD_CONFLICT' });
  assert.throws(() => store.saveRecord(record({ id: 'missing', cycle: 3 })), { code: 'RECORD_NOT_FOUND' });
  assert.deepEqual(data.get('pay_records'), original);
  assert.equal(writes.length, 0);
});

test('旧的重复周期记录保持可读以便撤销，但不能追加覆盖', () => {
  const original = [record(), record({ id: 'record_2' })];
  mockStorage({ pay_records: original });
  assert.equal(store.getRecords().length, 2);
  assert.throws(() => store.saveRecord(record({ id: undefined })), { code: 'RECORD_CONFLICT' });
  store.deleteRecord('record_2');
  assert.equal(store.getRecords().length, 1);
});

test('损坏记录与读取异常不会静默变空，也不能被新增覆盖', () => {
  for (const broken of [null, [null], {}, false, [record({ actualDate: '2026-02-30' })]]) {
    const { data, writes } = mockStorage({ pay_records: broken });
    assert.throws(() => store.getRecords(), { code: 'RECORDS_INVALID' });
    assert.throws(() => store.saveRecord(record({ id: undefined })), { code: 'RECORDS_INVALID' });
    assert.deepEqual(data.get('pay_records'), broken);
    assert.equal(writes.length, 0);
  }
  mockStorage();
  global.wx.getStorageSync = () => { throw new Error('unreadable'); };
  assert.throws(() => store.getRecords(), { code: 'RECORDS_READ_FAILED' });
});

test('无ID旧记录只补编号且编号不重复，迁移写入失败不会丢记录', () => {
  const first = record({ id: undefined });
  const second = record({ id: undefined, cycle: 2 });
  let state = mockStorage({ pay_records: [first, second] });
  const records = store.getRecords();
  assert.ok(records[0].id);
  assert.notEqual(records[0].id, records[1].id);
  assert.equal(state.writes.length, 1);
  store.getRecords();
  assert.equal(state.writes.length, 1);
  state = mockStorage({ pay_records: [first] }, () => true);
  assert.throws(() => store.getRecords(), { code: 'RECORDS_WRITE_FAILED' });
  assert.deepEqual(state.data.get('pay_records'), [copy(first)]);
});

test('修改结算规则时标记旧提醒需要处理，记录起始期数不触发', () => {
  mockStorage({ payroll_config: backup().config, calendar_added_dates: ['2026-11-13'] });
  store.saveConfig({ recordStartCycle: 1 });
  assert.equal(store.getCalendarReviewRequired(), false);
  store.saveConfig({ cycleDays: 23 });
  assert.equal(store.getCalendarReviewRequired(), true);
  store.resetCalendarTracking();
  assert.equal(store.getCalendarReviewRequired(), false);
  assert.deepEqual(store.getCalendarAdded(), []);
});

test('休息日和临时标记排序变化、旧配置迁移不误报规则改变', () => {
  mockStorage({
    payroll_config: { startDate: '2026-10-01', cycleDays: 22, includeWeekend: false },
    calendar_added_dates: ['2026-11-13'],
  });
  store.saveConfig({ restWeekdays: [6, 0] });
  assert.equal(store.getCalendarReviewRequired(), false);
  store.saveConfig({ dayOverrides: { '2026-11-01': 'work', '2026-11-02': 'rest' } });
  wx.setStorageSync('calendar_review_required', false);
  store.saveConfig({ dayOverrides: { '2026-11-02': 'rest', '2026-11-01': 'work' } });
  assert.equal(store.getCalendarReviewRequired(), false);
});

test('没有添加过日历提醒时改变规则无需处理旧提醒', () => {
  mockStorage({ payroll_config: backup().config });
  store.saveConfig({ cycleDays: 23 });
  assert.equal(store.getCalendarReviewRequired(), false);
});

test('清除日历状态中途失败时保留原来的写入记录和待处理标记', () => {
  const initial = { calendar_added_dates: ['2026-11-13'], calendar_review_required: true };
  const { data } = mockStorage(initial, (key, value, count) => count === 2);
  assert.throws(() => store.resetCalendarTracking(), { code: 'CALENDAR_WRITE_FAILED' });
  assert.deepEqual(Object.fromEntries(data), initial);
});

function slipSnapshot() {
  return createSnapshot(buildCycleDetail({ startDate: '2026-10-01', cycleDays: 22, restWeekdays: [], followHoliday: false }, {}, '2026-10-22'));
}

test('发薪单字段随备份完整往返，旧版备份仍可读取', () => {
  const saved = record({ recipientName: '王阿姨', shareNote: '含补贴 300 元', periodSnapshot: slipSnapshot(), note: '私人备注' });
  mockStorage({ payroll_config: backup().config, pay_records: [saved] });
  const parsed = store.parseBackup(store.exportData());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.records, [saved]);
  store.applyBackup(parsed.data);
  assert.deepEqual(store.getRecords(), [saved]);
  assert.equal(parse(backup()).ok, true);
  assert.deepEqual(parse(backup()).data.records, [record()]);
});

test('旧调用方修改金额保留称呼、说明、日期快照，当前规则变化不影响旧快照', () => {
  const saved = record({ recipientName: '王阿姨', shareNote: '含补贴 300 元', periodSnapshot: slipSnapshot() });
  mockStorage({ pay_records: [saved], payroll_config: backup().config });
  store.saveConfig({ cycleDays: 25, dayOverrides: { '2026-10-16': 'rest' } });
  store.saveRecord(record({ amount: 6000 }));
  const result = store.getRecords()[0];
  assert.equal(result.amount, 6000);
  assert.equal(result.recipientName, '王阿姨');
  assert.equal(result.shareNote, '含补贴 300 元');
  assert.deepEqual(result.periodSnapshot, saved.periodSnapshot);
  store.saveRecord(record({ recipientName: '', shareNote: '' }));
  assert.equal(store.getRecords()[0].recipientName, '');
  assert.equal(store.getRecords()[0].shareNote, '');
});

test('拒绝损坏或超长分享字段及与记录应发日不同的快照', () => {
  mockStorage();
  const invalidPatches = [
    { recipientName: 42 }, { recipientName: '王'.repeat(41) },
    { shareNote: null }, { shareNote: '文'.repeat(501) },
    { periodSnapshot: null }, { periodSnapshot: {} },
    { periodSnapshot: { ...slipSnapshot(), days: [] } },
    { plannedDate: '2026-10-23', periodSnapshot: slipSnapshot() },
  ];
  invalidPatches.forEach((patch) => assert.equal(parse(backup({ records: [record(patch)] })).ok, false, JSON.stringify(patch)));
  mockStorage({ pay_records: [record({ periodSnapshot: slipSnapshot() })] });
  assert.throws(() => store.saveRecord(record({ plannedDate: '2026-10-23' })), { code: 'RECORD_INVALID' });
  assert.equal(store.getRecords()[0].plannedDate, '2026-10-22');
});
