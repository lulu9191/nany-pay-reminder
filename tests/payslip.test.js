const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshot, normalizeSnapshot, buildSlipView } = require('../utils/payslip');
const { buildCycleDetail } = require('../utils/payroll');

function snapshot(config, settlement, missingYears) {
  return createSnapshot(buildCycleDetail(Object.assign({ cycleDays: 22, restWeekdays: [], followHoliday: false }, config), {}, settlement), missingYears);
}

function view(periodSnapshot, patch) {
  return buildSlipView(Object.assign({ cycle: 12, actualDate: '2026-11-13', amount: 8800, periodSnapshot }, patch));
}

test('示例22工作日、7休息日和临时上班正确标色，周期外日期不计入', () => {
  const data = snapshot({ startDate: '2026-10-16', restWeekdays: [0, 6], dayOverrides: { '2026-11-07': 'work' } }, '2026-11-13');
  const result = view(data, { recipientName: '王阿姨', shareNote: '本期含补贴 300 元。', note: '私人信息' });
  assert.equal(result.brand, '小新发薪');
  assert.equal(result.workdays, 22);
  assert.equal(result.restDays, 7);
  assert.equal(result.greeting, '王阿姨，辛苦了');
  assert.equal(result.amountText, '8,800.00');
  assert.equal(result.months.length, 2);
  assert.equal(result.months[0].rows, 5);
  assert.equal(result.months[1].rows, 6);
  const cells = result.months.flatMap((month) => month.cells);
  assert.equal(cells.filter((day) => day.state === 'work').length, 22);
  assert.equal(cells.filter((day) => day.state === 'rest').length, 7);
  assert.equal(cells.find((day) => day.key === '2026-11-07').state, 'work');
  assert.equal(cells.find((day) => day.key === '2026-11-14').state, 'outside');
  assert.match(result.adjustments[0], /11 月 7 日 临时标记上班/);
  assert.equal(JSON.stringify(result).includes('私人信息'), false);
});

test('跨年完整月份和闰年2月日期正确，星期一为首列', () => {
  const crossYear = view(snapshot({ startDate: '2026-12-25', cycleDays: 10 }, '2027-01-03'));
  assert.deepEqual(crossYear.months.map((month) => month.key), ['2026-12', '2027-01']);
  assert.equal(crossYear.months[0].cells[1].day, 1);
  assert.equal(crossYear.months[1].cells[4].day, 1);
  const leap = view(snapshot({ startDate: '2028-02-28', cycleDays: 3 }, '2028-03-01'));
  assert.equal(leap.months[0].cells.filter((day) => day.day !== '').length, 29);
  assert.equal(leap.months[0].cells.find((day) => day.day === 29).state, 'work');
});

test('金额未填写不可生成，不把空金额视为0；0元可以如实生成', () => {
  const data = snapshot({ startDate: '2026-10-01' }, '2026-10-22');
  assert.throws(() => view(data, { amount: null }), /补充实发金额/);
  assert.throws(() => view(data, { amount: undefined }), /补充实发金额/);
  assert.equal(view(data, { amount: 0 }).amountText, '0.00');
  assert.throws(() => view(undefined), /没有保存日期明细/);
});

test('快照独立于原始日期对象，未知节假日提示保留历史年份并排除未来预览年份', () => {
  const detail = buildCycleDetail({ startDate: '2026-10-01', cycleDays: 22, restWeekdays: [], followHoliday: false }, {}, '2026-10-22');
  const data = createSnapshot(detail, [2025, 2026, 2027, 2026]);
  detail.days[0].work = false;
  assert.equal(data.days[0].work, true);
  assert.deepEqual(data.missingYears, [2025, 2026]);
  assert.match(view(data).notice, /2025、2026 年节假日安排未获取到/);
  assert.match(view(data).notice, /本期区间或工作日可能按普通周历估算/);
});

test('本期年份数据齐全时仍保留较早缺失年份造成的累计周期不确定性', () => {
  const detail = buildCycleDetail({ startDate: '2026-10-01', cycleDays: 22, restWeekdays: [], followHoliday: false }, {}, '2026-10-22');
  const data = createSnapshot(detail, [2024, 2027]);
  assert.deepEqual(data.missingYears, [2024]);
  assert.deepEqual(normalizeSnapshot(data).missingYears, [2024]);
  assert.match(view(data).notice, /2024 年节假日安排未获取到/);
  assert.equal(view(data).notice.includes('2027'), false);
});

test('损坏快照被拒绝：不连续、重复、无效日期、缺天、错误类型或超出范围年份', () => {
  const original = snapshot({ startDate: '2026-10-01' }, '2026-10-22');
  const corruptions = [
    (v) => { v.version = 2; },
    (v) => { v.days.pop(); },
    (v) => { v.days[1].date = v.days[0].date; },
    (v) => { v.days[0].work = 'true'; },
    (v) => { v.days[0].label = null; },
    (v) => { v.cycleStart = '2026-02-30'; },
    (v) => { v.days[v.days.length - 1].work = false; },
    (v) => { v.missingYears = [2027]; },
    (v) => { v.missingYears = [2026, 2026]; },
  ];
  corruptions.forEach((corrupt) => {
    const copy = JSON.parse(JSON.stringify(original));
    corrupt(copy);
    assert.throws(() => normalizeSnapshot(copy));
  });
});
