const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pages/records/records.js'), 'utf8');
const payroll = require('../utils/payroll');
const payslip = require('../utils/payslip');

function createPage(options = {}) {
  const state = {
    records: options.records || [],
    config: Object.assign({
      startDate: '2026-10-01', cycleDays: 22, restWeekdays: [],
      followHoliday: false, recordStartCycle: 1,
    }, options.config),
    writes: 0,
    toasts: [],
    navigations: [],
    readError: false,
    saveError: false,
    app: { globalData: {} },
  };
  let definition;
  const store = {
    loadConfig: () => state.config,
    saveConfig: (patch) => Object.assign(state.config, patch),
    getRecords: () => {
      if (state.readError) throw new Error('读取失败');
      return state.records;
    },
    saveRecord: (record) => {
      if (state.saveError) throw new Error('空间不足，保存失败');
      state.writes++;
      const index = state.records.findIndex((r) => r.id === record.id);
      if (index >= 0) state.records[index] = record;
      else state.records.push(Object.assign({ id: 'new-record' }, record));
      return index >= 0 ? state.records[index] : state.records[state.records.length - 1];
    },
    deleteRecord: (id) => { state.records = state.records.filter((r) => r.id !== id); },
  };
  const holiday = {
    getBuiltinMap: () => ({}),
    getHolidayMap: options.getHolidayMap || (() => Promise.resolve({ days: {}, missingYears: [] })),
  };
  vm.runInNewContext(source, {
    Page: (page) => { definition = page; },
    getApp: () => state.app,
    require: (name) => {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/holiday')) return holiday;
      if (name.endsWith('/payroll')) return payroll;
      if (name.endsWith('/payslip')) return payslip;
      throw new Error('Unexpected import: ' + name);
    },
    wx: {
      showToast: (toast) => state.toasts.push(toast),
      showModal: (modal) => modal.success({ confirm: true }),
      navigateTo: (options) => state.navigations.push(options.url),
    },
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      Object.keys(patch).forEach((key) => {
        const parts = key.split('.');
        let object = this.data;
        parts.slice(0, -1).forEach((part) => { object = object[part]; });
        object[parts[parts.length - 1]] = patch[key];
      });
    },
  });
  page.data.today = '2026-10-30';
  return { page, state };
}

function record(cycle = 2) {
  return { id: 'existing-' + cycle, cycle, plannedDate: '2026-11-13', actualDate: '2026-10-29', amount: 6000, note: '原备注' };
}

test('新增默认真实当前期，可选择历史期补记并带入对应应发日', async () => {
  const { page, state } = createPage();
  await page.openForm({});
  assert.equal(page.data.form.cycle, 2);
  assert.equal(page.data.form.plannedDate, '2026-11-13');
  page.onCycleChange({ detail: { value: '0' } });
  assert.equal(page.data.form.cycle, 1);
  assert.equal(page.data.form.plannedDate, '2026-10-22');
  page.onSave();
  page.onSave();
  assert.equal(state.writes, 1);
  assert.equal(state.records[0].cycle, 1);
  assert.equal(state.records[0].plannedDate, '2026-10-22');
});

test('首页带期数进入已有记录时编辑原记录，不能改变归属', async () => {
  const { page, state } = createPage({ records: [record()] });
  await page.openForm({ cycle: 2, plannedDate: '2026-11-13' });
  assert.equal(page.data.isEdit, true);
  assert.equal(page.data.form.id, 'existing-2');
  assert.equal(page.data.form.amount, '6000');
  page.onCycleChange({ detail: { value: 0 } });
  assert.equal(page.data.form.cycle, 2);
  page.onNoteInput({ detail: { value: '更新备注' } });
  page.onSave();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].note, '更新备注');
});

test('当前期已记录时新增仍可选择其他期数，选中已有期自动编辑', async () => {
  const { page } = createPage({ records: [record()] });
  await page.openForm({});
  assert.equal(page.data.isEdit, false);
  assert.equal(page.data.form.cycle, 3);
  page.onCycleChange({ detail: { value: 1 } });
  assert.equal(page.data.isEdit, true);
  assert.equal(page.data.form.id, 'existing-2');
});

test('表单打开后同一期已有记录时不会覆盖，而是切换编辑待用户核对', async () => {
  const { page, state } = createPage();
  await page.openForm({});
  state.records.push(record());
  page.onSave();
  assert.equal(state.writes, 0);
  assert.equal(state.records.length, 1);
  assert.equal(page.data.isEdit, true);
  assert.equal(page.data.form.amount, '6000');
  assert.match(state.toasts[0].title, /已有记录/);
});

test('节假日加载完成前不能保存，关闭表单后旧请求不会改写新表单', async () => {
  let resolveHoliday;
  const { page, state } = createPage({
    config: { followHoliday: true },
    records: [record(1)],
    getHolidayMap: () => new Promise((resolve) => { resolveHoliday = resolve; }),
  });
  const loading = page.openForm({});
  assert.equal(page.data.formLoading, true);
  page.onSave();
  assert.equal(state.writes, 0);
  page.closeForm();
  page.onEditTap({ currentTarget: { dataset: { id: 'existing-1' } } });
  resolveHoliday({ days: {}, missingYears: [] });
  await loading;
  assert.equal(page.data.isEdit, true);
  assert.equal(page.data.form.id, 'existing-1');
});

test('读取错误阻止新增，保存错误保留用户表单并显示原因', async () => {
  const { page, state } = createPage();
  state.readError = true;
  await page.openForm({});
  assert.equal(page.data.showForm, false);
  assert.match(page.data.loadError, /读取失败/);
  state.readError = false;
  await page.openForm({});
  state.saveError = true;
  page.onAmountInput({ detail: { value: '6800' } });
  page.onSave();
  assert.equal(page.data.showForm, true);
  assert.equal(page.data.saving, false);
  assert.equal(page.data.form.amount, '6800');
  assert.match(state.toasts[0].title, /空间不足/);
});

test('首页传入旧应发日时以重新计算的真实日期为准', async () => {
  const { page } = createPage();
  await page.openForm({ cycle: 2, plannedDate: '2026-11-12' });
  assert.equal(page.data.form.cycle, 2);
  assert.equal(page.data.form.plannedDate, '2026-11-13');
  assert.match(page.data.formNotice, /重新计算/);
});

test('切换到记录标签时一次性消费首页意图，并定位原有记录', async () => {
  const { page, state } = createPage({ records: [record()] });
  state.app.globalData.recordIntent = { cycle: 2, plannedDate: '2026-11-13' };
  await page.onShow();
  assert.equal(state.app.globalData.recordIntent, null);
  assert.equal(page.data.isEdit, true);
  assert.equal(page.data.form.id, 'existing-2');
  page.closeForm();
  await page.onShow();
  assert.equal(page.data.showForm, false);
});

test('账单按实际发薪年月倒序分组，跨年月份分开且不改变汇总', () => {
  const { page } = createPage({ records: [
    Object.assign(record(1), { actualDate: '2025-10-29', amount: 6000.25 }),
    Object.assign(record(2), { actualDate: '2026-09-30', plannedDate: '2026-10-01', amount: null }),
    Object.assign(record(3), { actualDate: '2026-10-01', plannedDate: '2026-09-30', amount: 0 }),
    Object.assign(record(4), { actualDate: '2026-10-30', amount: 6500.75 }),
  ] });
  page.refresh();
  const groups = page.data.recordGroups;
  assert.equal(groups.length, 3);
  assert.equal(groups[0].month, '2026-10');
  assert.equal(groups[0].records.length, 2);
  assert.equal(groups[0].records[0].cycle, 4);
  assert.equal(groups[0].records[1].amountText, '¥0.00');
  assert.equal(groups[1].month, '2026-09');
  assert.equal(groups[1].records[0].amountText, '未记金额');
  assert.equal(groups[2].month, '2025-10');
  assert.equal(page.data.totalAmount, 12501);
  assert.equal(page.data.totalAmountText, '12,501.00');
});

test('新记录保存经过核对的本期快照，私人备注和公开说明分别保存', async () => {
  const { page, state } = createPage();
  await page.openForm({ cycle: 1 });
  page.onRecipientInput({ detail: { value: '王阿姨' } });
  page.onShareNoteInput({ detail: { value: '含补贴 300 元' } });
  page.onNoteInput({ detail: { value: '仅自己看' } });
  page.onSave();
  const saved = state.records[0];
  assert.equal(saved.periodSnapshot.cycleStart, '2026-10-01');
  assert.equal(saved.periodSnapshot.settlementDate, '2026-10-22');
  assert.equal(saved.periodSnapshot.days.length, 22);
  assert.equal(saved.recipientName, '王阿姨');
  assert.equal(saved.shareNote, '含补贴 300 元');
  assert.equal(saved.note, '仅自己看');
  assert.equal(page.data.lastSavedRecordId, saved.id);
  page.onOpenLastSlip();
  assert.match(state.navigations[0], /\/pages\/payslip\/payslip\?id=new-record$/);
});

test('表单打开后上班安排变化时拒绝保存过时日历且保留所填金额', async () => {
  const { page, state } = createPage();
  await page.openForm({ cycle: 1 });
  page.onAmountInput({ detail: { value: '8800' } });
  state.config.dayOverrides = { '2026-10-16': 'rest' };
  page.onSave();
  assert.equal(state.writes, 0);
  assert.equal(page.data.form.amount, '8800');
  assert.match(page.data.formNotice, /安排已变化/);
});

test('修改已有记录后预览先保存新内容，保留原日期快照', async () => {
  const snapshot = payslip.createSnapshot(payroll.buildCycleDetail({
    startDate: '2026-10-23', cycleDays: 22, restWeekdays: [], followHoliday: false,
  }, {}, '2026-11-13'));
  const existing = Object.assign(record(), { periodSnapshot: snapshot });
  const { page, state } = createPage({ records: [existing], config: { restWeekdays: [0, 6] } });
  await page.openForm({ cycle: 2 });
  page.onShareNoteInput({ detail: { value: '新的说明' } });
  page.onPreviewSlip();
  assert.equal(state.writes, 1);
  assert.deepEqual(state.records[0].periodSnapshot, snapshot);
  assert.equal(state.records[0].shareNote, '新的说明');
  assert.match(state.navigations[0], /id=existing-2$/);
});

test('未记金额不能预览，保存失败不会跳转发薪单', async () => {
  const { page, state } = createPage({ records: [Object.assign(record(), { amount: null })] });
  await page.openForm({ cycle: 2 });
  page.onPreviewSlip();
  assert.equal(state.writes, 0);
  assert.equal(state.navigations.length, 0);
  assert.match(state.toasts[0].title, /补充实发金额/);
  page.onAmountInput({ detail: { value: '8800' } });
  state.saveError = true;
  page.onPreviewSlip();
  assert.equal(state.navigations.length, 0);
  assert.equal(page.data.showForm, true);
});

test('编辑旧记录不把当前规则自动保存成历史日历', async () => {
  const { page, state } = createPage({ records: [record()] });
  await page.openForm({ cycle: 2 });
  page.onPreviewSlip();
  assert.equal(state.records[0].periodSnapshot, undefined);
  assert.equal(state.navigations.length, 1);
});

test('从发薪单返回按记录ID定位，历史同期期数不会打开另一笔记录', async () => {
  const first = record();
  const second = Object.assign(record(), { id: 'second-record', amount: 8800 });
  const { page, state } = createPage({ records: [first, second] });
  state.app.globalData.recordIntent = { id: 'second-record', cycle: 2, plannedDate: '2026-11-13' };
  await page.onShow();
  assert.equal(page.data.form.id, 'second-record');
  assert.equal(page.data.form.amount, '8800');
  assert.equal(state.app.globalData.recordIntent, null);
});

test('指定ID已不存在时不退回同一期或新增表单，并明确提示', async () => {
  const { page, state } = createPage({ records: [record()] });
  page.openRecord(record());
  state.app.globalData.recordIntent = { id: 'deleted-record', cycle: 2, plannedDate: '2026-11-13' };
  await page.onShow();
  assert.equal(page.data.showForm, false);
  assert.equal(page.data.isEdit, false);
  assert.equal(page.data.form.id, '');
  assert.equal(state.writes, 0);
  assert.match(state.toasts[0].title, /记录已不存在/);
  await page.openForm({ id: 'deleted-record', cycle: 3 });
  assert.equal(page.data.showForm, false);
  assert.equal(state.toasts.length, 2);
});
