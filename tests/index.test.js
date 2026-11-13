const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPaySchedule } = require('../utils/payroll');
const store = require('../utils/store');
let definition;
global.Page = (page) => { definition = page; };
require('../pages/index/index');

function setup(patch = {}) {
  const data = {};
  const calls = { urls: [], toasts: [], calendars: [], modals: [] };
  const app = { globalData: {} };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => data[key] === undefined ? '' : JSON.parse(JSON.stringify(data[key])),
    setStorageSync: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); },
    removeStorageSync: (key) => { delete data[key]; },
    navigateTo: (value) => calls.urls.push(value.url),
    switchTab: (value) => calls.urls.push(value.url),
    showToast: (value) => calls.toasts.push(value),
    showModal: (value) => calls.modals.push(value),
    showLoading() {}, hideLoading() {},
  };
  const cfg = store.saveConfig(Object.assign({ startDate: '2026-10-01', cycleDays: 22, restWeekdays: [], followHoliday: false, recordStartCycle: 1 }, patch));
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values) { Object.assign(this.data, values); },
  });
  return { data, calls, cfg, page, app };
}

function record(cycle, plannedDate, actualDate = plannedDate) {
  return store.saveRecord({ cycle, plannedDate, actualDate, amount: 6500, note: '' });
}

test('过期未记录优先展示原周期，补记入口携带原期数和日期', () => {
  const { cfg, page, calls, app } = setup();
  const schedule = buildPaySchedule(cfg, {}, '2026-10-23');
  const status = page.computeStatus(cfg, schedule, '2026-10-23');
  assert.equal(schedule.cycleIndex, 2);
  assert.equal(status.key, 'overdue');
  assert.equal(status.cycle, 1);
  assert.equal(status.plannedDate, '2026-10-22');
  page.setData({ schedule, status });
  page.onStatusBtn();
  assert.equal(calls.urls[0], '/pages/records/records');
  assert.deepEqual(app.globalData.recordIntent, { cycle: 1, plannedDate: '2026-10-22' });
});

test('补记晚发薪不改变下一期，完成后撤销会重新出现待补记状态', () => {
  const { cfg, page } = setup();
  const before = buildPaySchedule(cfg, {}, '2026-10-23');
  const saved = record(1, '2026-10-22', '2026-10-23');
  const after = buildPaySchedule(store.loadConfig(), {}, '2026-10-23');
  assert.equal(after.nextSettlement, before.nextSettlement);
  assert.equal(page.computeStatus(cfg, after, '2026-10-23').key, 'pending');
  store.deleteRecord(saved.id);
  assert.equal(page.computeStatus(cfg, after, '2026-10-23').key, 'overdue');
});

test('未开启记录不判历史欠薪，从指定期开始时忽略更早的未记录期', () => {
  const { page, cfg } = setup({ recordStartCycle: 0 });
  const schedule = buildPaySchedule(cfg, {}, '2026-11-14');
  assert.equal(page.computeStatus(cfg, schedule, '2026-11-14').key, 'fresh');
  assert.equal(page.computeStatus({ ...cfg, recordStartCycle: 3 }, schedule, '2026-11-14').key, 'pending');
  assert.equal(page.computeStatus({ ...cfg, recordStartCycle: 2 }, schedule, '2026-11-14').cycle, 2);
});

test('当前期已提前记录也不会遮住更早的漏记周期', () => {
  const { page, cfg } = setup();
  record(3, '2026-12-05', '2026-11-14');
  const status = page.computeStatus(cfg, buildPaySchedule(cfg, {}, '2026-11-14'), '2026-11-14');
  assert.equal(status.key, 'overdue');
  assert.equal(status.cycle, 1);
  assert.match(status.desc, /共 2 期待补记/);
});

test('发薪当天可记录，零元记录仍显示金额并直接定位编辑', () => {
  const { page, cfg, calls, app } = setup();
  const schedule = buildPaySchedule(cfg, {}, '2026-10-22');
  assert.equal(page.computeStatus(cfg, schedule, '2026-10-22').key, 'today');
  store.saveRecord({ cycle: 1, plannedDate: '2026-10-22', actualDate: '2026-10-22', amount: 0 });
  const status = page.computeStatus(cfg, schedule, '2026-10-22');
  assert.equal(status.key, 'done');
  assert.match(status.desc, /¥0/);
  page.setData({ schedule, status });
  page.onStatusBtn();
  assert.equal(calls.urls[0], '/pages/records/records');
  assert.deepEqual(app.globalData.recordIntent, { cycle: 1, plannedDate: '2026-10-22' });
});

test('核对日期期间不能记录或把预览日期写进系统日历', () => {
  const { page, cfg, calls } = setup();
  const schedule = buildPaySchedule(cfg, {}, '2026-10-22');
  page.setData({ schedule, status: page.computeStatus(cfg, schedule, '2026-10-22'), scheduleLoading: true });
  wx.addPhoneCalendar = (options) => calls.calendars.push(options);
  page.onStatusBtn();
  page.onAddToCalendar();
  assert.equal(calls.urls.length, 0);
  assert.equal(calls.calendars.length, 0);
});

test('规则变化后提示处理旧提醒，确认前不会继续写入', () => {
  const { page, cfg, calls } = setup();
  store.addCalendarAdded(['2026-10-22']);
  const changed = store.saveConfig({ cycleDays: 23 });
  const schedule = buildPaySchedule(changed, {}, '2026-10-22');
  page.setData({ schedule });
  page.refreshCalendarState(schedule);
  assert.equal(page.data.calendarReviewRequired, true);
  wx.addPhoneCalendar = (options) => calls.calendars.push(options);
  page.onAddToCalendar();
  assert.equal(calls.calendars.length, 0);
  assert.equal(calls.modals.length, 1);
  calls.modals[0].success({ confirm: false });
  assert.equal(store.getCalendarReviewRequired(), true);
  calls.modals[0].success({ confirm: true });
  assert.equal(store.getCalendarReviewRequired(), false);
  assert.deepEqual(store.getCalendarAdded(), []);
});

test('拒绝日历权限后立即停止后续写入', () => {
  const { page, cfg, calls } = setup();
  page.setData({ schedule: buildPaySchedule(cfg, {}, '2026-10-22') });
  wx.addPhoneCalendar = (options) => {
    calls.calendars.push(options);
    options.fail({ errMsg: 'addPhoneCalendar:fail auth deny' });
    options.complete();
  };
  const originalError = console.error;
  console.error = () => {};
  try { page.onAddToCalendar(); } finally { console.error = originalError; }
  assert.equal(calls.calendars.length, 1);
  assert.deepEqual(store.getCalendarAdded(), []);
  assert.equal(page._addingCalendar, false);
});

test('提醒覆盖只统计当前未来计划，并提示未添加期数', () => {
  const { page, cfg } = setup();
  const schedule = buildPaySchedule(cfg, {}, '2026-10-23');
  store.addCalendarAdded(['2026-10-22', '2026-11-13']);
  page.refreshCalendarState(schedule);
  assert.equal(page.data.addedCount, 1);
  assert.match(page.data.calendarSummary, /还有 5 期未添加/);
});

test('日期计算出错后不能把保留的预览排期写入日历', () => {
  const { page, cfg, calls } = setup();
  page.setData({ schedule: buildPaySchedule(cfg, {}, '2026-10-22'), dataError: '日期计算失败' });
  wx.addPhoneCalendar = (options) => calls.calendars.push(options);
  page.onAddToCalendar();
  assert.equal(calls.calendars.length, 0);
});

test('日历状态读取失败会结束加载并保留可见错误，不产生未捕获异常', async () => {
  const { page, cfg } = setup();
  const readStorage = wx.getStorageSync;
  wx.getStorageSync = (key) => {
    if (key === store.CALENDAR_REVIEW_KEY) throw new Error('本地状态读取失败');
    return readStorage(key);
  };
  await page.computeSchedule(cfg);
  assert.equal(page.data.scheduleLoading, false);
  assert.equal(page.data.dataError, '本地状态读取失败');
});
