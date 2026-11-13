const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPaySchedule, buildCycleDetail } = require('../utils/payroll');

function config(overrides = {}) {
  return Object.assign({
    startDate: '2026-10-01',
    cycleDays: 22,
    restWeekdays: [],
    followHoliday: false,
    dayOverrides: {},
    anchorOverride: '',
  }, overrides);
}

test('第二期明细从上一期结算日次日开始，恰好计入 22 天', () => {
  const detail = buildCycleDetail(config(), {}, '2026-11-13');
  assert.equal(detail.cycleStart, '2026-10-23');
  assert.equal(detail.totalWorkdays, 22);
  assert.equal(detail.days.length, 22);
  assert.equal(detail.days[0].date, '2026-10-23');
  assert.equal(detail.days[21].count, 22);
  assert.equal(detail.days[21].isSettlement, true);
});

test('首期及后续周期保留起点后的休息日，不重复上一期工作日', () => {
  const cfg = config({ startDate: '2026-10-03', cycleDays: 2, restWeekdays: [0, 6] });
  const first = buildCycleDetail(cfg, {}, '2026-10-06');
  assert.equal(first.cycleStart, '2026-10-03');
  assert.equal(first.totalWorkdays, 2);
  assert.equal(first.skipped, 2);

  const next = buildCycleDetail(config({ startDate: '2026-10-01', cycleDays: 2, restWeekdays: [0, 6] }), {}, '2026-10-06');
  assert.equal(next.cycleStart, '2026-10-03');
  assert.equal(next.totalWorkdays, 2);
  assert.equal(next.skipped, 2);
});

test('调整起点保留此前完成的周期，截断未完成周期并连续编号', () => {
  const cfg = config({ anchorOverride: '2026-10-25' });
  const schedule = buildPaySchedule(cfg, {}, '2026-10-30');
  assert.deepEqual(schedule.periods.slice(0, 2).map((period) => [period.cycle, period.cycleStart, period.date]), [
    [1, '2026-10-01', '2026-10-22'],
    [2, '2026-10-25', '2026-11-15'],
  ]);
  assert.equal(schedule.cycleIndex, 2);
  assert.equal(schedule.cycleStart, '2026-10-25');
  assert.equal(schedule.schedule.length, 6);
  assert.equal(schedule.periods.filter((period) => period.isNext).length, 1);
  assert.equal(buildCycleDetail(cfg, {}, '2026-10-22').totalWorkdays, 22);
  const detail = buildCycleDetail(cfg, {}, '2026-11-15');
  assert.equal(detail.cycleStart, '2026-10-25');
  assert.equal(detail.totalWorkdays, 22);
  assert.equal(buildCycleDetail(cfg, {}, '2026-11-13'), null);
});

test('锚点恰好是旧结算日时，从该日重新计入，未完成旧期不保留', () => {
  const schedule = buildPaySchedule(config({ anchorOverride: '2026-10-22' }), {}, '2026-10-30');
  assert.equal(schedule.cycleIndex, 1);
  assert.equal(schedule.cycleStart, '2026-10-22');
  assert.equal(schedule.nextSettlement, '2026-11-12');
});

test('未来调整起点不会跳过今天所在的原周期', () => {
  const schedule = buildPaySchedule(config({ anchorOverride: '2026-12-01' }), {}, '2026-10-10');
  assert.equal(schedule.nextSettlement, '2026-10-22');
  assert.equal(schedule.cycleIndex, 1);
  assert.deepEqual(schedule.periods.slice(0, 3).map((period) => [period.cycleStart, period.date]), [
    ['2026-10-01', '2026-10-22'],
    ['2026-10-23', '2026-11-13'],
    ['2026-12-01', '2026-12-22'],
  ]);
});

test('一天周期超过 60 期仍提供六个未来结算日及完整历史', () => {
  const schedule = buildPaySchedule(config({ startDate: '2026-08-01', cycleDays: 1 }), {}, '2026-10-30');
  assert.equal(schedule.cycleIndex, 91);
  assert.equal(schedule.schedule.length, 6);
  assert.equal(schedule.periods.length, 96);
  assert.equal(schedule.schedule[0].date, '2026-10-30');
  assert.equal(schedule.schedule[5].date, '2026-11-04');
  assert.equal(schedule.periods[0].date, '2026-08-01');
  assert.equal(schedule.isPaydayToday, true);
  assert.equal(schedule.progressPercent, 100);
});

test('多年前入职的普通周期可以持续结算，锚点后的编号也超过 60 期', () => {
  const cfg = config({ startDate: '2020-01-01' });
  const schedule = buildPaySchedule(cfg, {}, '2026-10-30');
  assert.equal(schedule.cycleIndex, 114);
  assert.equal(schedule.nextSettlement, '2026-11-12');
  assert.equal(schedule.schedule.length, 6);
  assert.equal(schedule.periods.length, 119);

  const anchored = buildPaySchedule(Object.assign({}, cfg, { anchorOverride: '2026-10-01' }), {}, '2026-10-30');
  assert.equal(anchored.cycleIndex, 114);
  assert.equal(anchored.cycleStart, '2026-10-23');
  assert.equal(anchored.nextSettlement, '2026-11-13');
});

test('尚未入职时只统计本期工作日，进度保持为零', () => {
  const schedule = buildPaySchedule(config({ startDate: '2026-11-01' }), {}, '2026-10-30');
  assert.equal(schedule.remainingWorkdays, 22);
  assert.equal(schedule.doneWorkdays, 0);
  assert.equal(schedule.progressPercent, 0);
});

test('支持日期范围末端能及时停止，不会滚入五位年份继续扫描', () => {
  const schedule = buildPaySchedule(config({ startDate: '9999-12-31', cycleDays: 1 }), {}, '9999-12-31');
  assert.equal(schedule.nextSettlement, '9999-12-31');
  assert.equal(schedule.schedule.length, 1);
  assert.equal(schedule.remainingWorkdays, 1);
});

test('临时标记优先于节假日和固定休息日，明细与排期使用相同规则', () => {
  const cfg = config({
    cycleDays: 3,
    restWeekdays: [0, 6],
    followHoliday: true,
    dayOverrides: { '2026-10-01': 'work', '2026-10-02': 'rest' },
  });
  const holidays = { '2026-10-01': { holiday: true }, '2026-10-03': { holiday: false } };
  const schedule = buildPaySchedule(cfg, holidays, '2026-10-01');
  assert.equal(schedule.nextSettlement, '2026-10-05');
  const detail = buildCycleDetail(cfg, holidays, schedule.nextSettlement);
  assert.equal(detail.totalWorkdays, 3);
  assert.equal(detail.skipped, 2);
  assert.deepEqual(detail.days.filter((day) => day.work).map((day) => day.date), ['2026-10-01', '2026-10-03', '2026-10-05']);
});

test('全周休息和非法配置及时返回，非结算日不能生成伪造明细', () => {
  assert.equal(buildPaySchedule(config({ restWeekdays: [0, 1, 2, 3, 4, 5, 6] }), {}, '2026-10-30'), null);
  for (const invalid of [
    { cycleDays: 0 }, { cycleDays: -1 }, { cycleDays: 1.5 }, { cycleDays: Infinity },
    { startDate: '2026-02-30' }, { startDate: 'bad' },
    { restWeekdays: [8] }, { anchorOverride: '2026-09-30' },
  ]) {
    assert.equal(buildPaySchedule(config(invalid), {}, '2026-10-30'), null);
  }
  assert.equal(buildPaySchedule(config(), {}, 'bad'), null);
  assert.equal(buildPaySchedule(config(), {}, '2026-10-30', Infinity), null);
  assert.equal(buildCycleDetail(config(), {}, '2026-10-21'), null);
  assert.equal(buildCycleDetail(config(), {}, '2026-09-30'), null);
  assert.equal(buildCycleDetail(config(), {}, 'bad'), null);
});
