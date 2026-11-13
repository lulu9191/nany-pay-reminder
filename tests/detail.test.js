const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payroll = require('../utils/payroll');

const source = fs.readFileSync(path.join(__dirname, '../pages/detail/detail.js'), 'utf8');

function createPage(options = {}) {
  const state = {
    config: Object.assign({
      startDate: '2026-10-23', cycleDays: 22, restWeekdays: [],
      followHoliday: false, dayOverrides: {}, anchorOverride: '',
    }, options.config),
    today: options.today || '2026-10-30',
    sheets: [], switchedTabs: [], writes: [], toasts: [],
  };
  let definition;
  vm.runInNewContext(source, {
    Page: (page) => { definition = page; },
    require: (name) => {
      if (name.endsWith('/payroll')) return payroll;
      if (name.endsWith('/holiday')) return {
        todayStr: () => state.today,
        getBuiltinMap: () => ({}),
        getHolidayMap: options.getHolidayMap || (() => Promise.resolve({ days: {}, missingYears: [] })),
      };
      if (name.endsWith('/store')) return {
        loadConfig: () => state.config,
        saveConfig: (patch) => { state.writes.push(patch); state.config = Object.assign({}, state.config, patch); },
      };
      throw new Error('Unexpected import: ' + name);
    },
    wx: {
      showActionSheet: (sheet) => state.sheets.push(sheet),
      showToast: (toast) => state.toasts.push(toast),
      switchTab: ({ url }) => state.switchedTabs.push(url),
    },
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { page, state };
}

function render(page, state) {
  page.render(state.config, {}, state.today);
  page.setData({ loading: false });
}

function changeMonth(page, step) {
  page.onMonthChange({ currentTarget: { dataset: { step } } });
}

function cell(page, number) {
  return page.data.calendarMonth.cells.find((day) => day.number === number);
}

test('跨月周期按周一排布，月初空位正确，周期外日期不可点', () => {
  const { page, state } = createPage();
  render(page, state);
  assert.deepEqual(Array.from(page.data.calendarMonths), ['2026-10', '2026-11']);
  assert.equal(page.data.calendarMonth.title, '2026 年 10 月');
  assert.deepEqual(Array.from(page.data.calendarMonth.cells.slice(0, 3), (day) => day.kind), ['empty', 'empty', 'empty']);
  assert.equal(page.data.calendarMonth.cells[3].number, 1);
  assert.equal(cell(page, 22).kind, 'outside');
  assert.equal(cell(page, 22).date, '');
  assert.equal(cell(page, 23).kind, 'work');
  assert.equal(cell(page, 23).date, '2026-10-23');
  assert.equal(page.data.monthDays.length, 9);
});

test('只能在周期覆盖月份内切换，末月显示发薪日并保留完整星期行', () => {
  const { page, state } = createPage();
  render(page, state);
  changeMonth(page, -1);
  assert.equal(page.data.calendarMonth.key, '2026-10');
  assert.equal(page.data.calendarMonth.canPrevious, false);
  changeMonth(page, 1);
  assert.equal(page.data.calendarMonth.key, '2026-11');
  assert.equal(page.data.calendarMonth.canNext, false);
  assert.equal(page.data.calendarMonth.cells.length, 42);
  assert.equal(page.data.calendarMonth.cells[6].number, 1);
  assert.equal(cell(page, 13).kind, 'payday');
  assert.equal(cell(page, 13).label, '发薪');
  assert.equal(cell(page, 14).kind, 'outside');
  assert.equal(page.data.monthDays.length, 13);
  assert.equal(page.data.monthDays[12].count, 22);
  changeMonth(page, 1);
  assert.equal(page.data.calendarMonth.key, '2026-11');
});

test('月历和逐日明细区分跨月休息日、计入日及发薪日', () => {
  const { page, state } = createPage({ config: { startDate: '2026-10-30', cycleDays: 3, restWeekdays: [0, 6] } });
  render(page, state);
  assert.equal(page.data.detail.totalWorkdays, 3);
  assert.equal(page.data.detail.skipped, 2);
  assert.equal(cell(page, 30).kind, 'work');
  assert.equal(cell(page, 31).kind, 'rest');
  assert.equal(cell(page, 31).label, '休息');
  changeMonth(page, 1);
  assert.equal(cell(page, 1).kind, 'rest');
  assert.equal(cell(page, 2).kind, 'work');
  assert.equal(cell(page, 3).kind, 'payday');
  assert.equal(page.data.monthDays[0].work, false);
  assert.equal(page.data.monthDays[1].count, 2);
});

test('闰年二月保留 29 日，下一月首日能作为发薪日', () => {
  const { page, state } = createPage({ today: '2028-02-27', config: { startDate: '2028-02-27', cycleDays: 4 } });
  render(page, state);
  assert.equal(cell(page, 29).date, '2028-02-29');
  assert.equal(cell(page, 30), undefined);
  assert.equal(page.data.monthDays.length, 3);
  changeMonth(page, 1);
  assert.equal(cell(page, 1).kind, 'payday');
  assert.equal(page.data.monthDays.length, 1);
  assert.equal(page.data.calendarMonth.canNext, false);
});

test('默认定位本期的今天所在月，刷新保留用户月份，周期缩短后回到有效月份', () => {
  const { page, state } = createPage({ today: '2026-11-01' });
  render(page, state);
  assert.equal(page.data.calendarMonth.key, '2026-11');
  changeMonth(page, -1);
  render(page, state);
  assert.equal(page.data.calendarMonth.key, '2026-10');
  state.config.cycleDays = 1;
  render(page, state);
  assert.equal(page.data.calendarMonth.key, '2026-11');
  assert.deepEqual(Array.from(page.data.calendarMonths), ['2026-11']);
});

test('空白、周期外及加载中日期不打开修改菜单，有效日期可标记休息', () => {
  const { page, state } = createPage();
  render(page, state);
  const tap = (date) => page.onDayTap({ currentTarget: { dataset: { date } } });
  tap('');
  tap('2026-10-22');
  page.setData({ loading: true });
  tap('2026-10-23');
  assert.equal(state.sheets.length, 0);
  page.setData({ loading: false });
  tap('2026-10-23');
  assert.equal(state.sheets.length, 1);
  let recomputes = 0;
  page.compute = () => { recomputes++; };
  state.sheets[0].success({ tapIndex: 1 });
  assert.equal(state.config.dayOverrides['2026-10-23'], 'rest');
  assert.equal(recomputes, 1);
  tap('2026-10-23');
  assert.equal(state.sheets[1].itemList[1], '取消临时休息标记');
  state.sheets[1].success({ tapIndex: 1 });
  assert.equal(state.config.dayOverrides['2026-10-23'], undefined);
});

test('没有可用周期时同时清空旧月历，设置入口切换原生页签', () => {
  const { page, state } = createPage();
  render(page, state);
  state.config.startDate = '';
  render(page, state);
  assert.equal(page.data.calendarMonth, null);
  assert.equal(page.data.monthDays.length, 0);
  page.goSettings();
  assert.deepEqual(state.switchedTabs, ['/pages/settings/settings']);
});

test('新设置算出日期后，较早的异步结果不会覆盖月历和明细', async () => {
  const waiting = [];
  const { page, state } = createPage({
    config: { followHoliday: true },
    getHolidayMap: () => new Promise((resolve) => waiting.push(resolve)),
  });
  const oldRequest = page.compute();
  state.config = Object.assign({}, state.config, { cycleDays: 23 });
  const newRequest = page.compute();
  waiting[1]({ days: {}, missingYears: [] });
  await newRequest;
  assert.equal(page.data.detail.settlementDate, '2026-11-14');
  waiting[0]({ days: {}, missingYears: [] });
  await oldRequest;
  assert.equal(page.data.detail.settlementDate, '2026-11-14');
  assert.equal(page.data.loading, false);
  changeMonth(page, 1);
  assert.equal(cell(page, 14).kind, 'payday');
});
