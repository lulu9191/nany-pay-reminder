const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pages/settings/settings.js'), 'utf8');

function createPage() {
  const state = {
    config: {
      startDate: '2026-10-01', cycleDays: 22, restWeekdays: [0, 6],
      followHoliday: true, anchorOverride: '',
    },
    saved: [], toasts: [], tabs: [], modals: [], saveError: false, restoreError: false,
  };
  let definition;
  const store = {
    loadConfig: () => state.config,
    saveConfig: (patch) => {
      if (state.saveError) throw new Error('存储空间不足');
      state.saved.push(patch);
      Object.assign(state.config, patch);
    },
    parseBackup: () => ({ ok: true, data: { config: { ...state.config, cycleDays: 26 } }, summary: { exportedAt: '2026-10-30', records: 2 } }),
    applyBackup: (data) => {
      if (state.restoreError) throw new Error('恢复失败，已还原原数据');
      state.config = data.config;
    },
  };
  vm.runInNewContext(source, {
    Page: (page) => { definition = page; },
    require: (name) => {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/holiday')) return { todayStr: () => '2026-10-30' };
      throw new Error('Unexpected module: ' + name);
    },
    setTimeout: (callback) => callback(),
    wx: {
      showToast: (toast) => state.toasts.push(toast),
      switchTab: (target) => state.tabs.push(target.url),
      chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/backup.json' }] }),
      getFileSystemManager: () => ({ readFile: (options) => options.success({ data: '{}' }) }),
      showModal: (modal) => {
        state.modals.push(modal);
        if (modal.success) modal.success({ confirm: true });
      },
    },
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  page.onLoad();
  return { page, state };
}

test('常驻设置tab重新展示时加载最新配置，已有高级起点保持可见且默认折叠', () => {
  const { page, state } = createPage();
  assert.equal(page.data.cycleOptions.length, 60);
  assert.equal(page.data.advancedOpen, false);
  state.config = { ...state.config, cycleDays: 26, restWeekdays: [3], anchorOverride: '2026-10-15' };
  page.onShow();
  assert.equal(page.data.cycleDays, 26);
  assert.equal(page.data.cycleIndex, 25);
  assert.equal(page.data.anchorOverride, '2026-10-15');
  assert.equal(page.data.advancedOpen, false);
  assert.deepEqual(Array.from(page.data.weekChips.filter((chip) => chip.active), (chip) => chip.value), [3]);
});

test('保存成功切换回首页tab并保留所有业务设置', () => {
  const { page, state } = createPage();
  page.onCycleChange({ detail: { value: 25 } });
  page.onHolidayChange({ detail: { value: false } });
  page.onSave();
  assert.equal(state.saved.length, 1);
  assert.equal(state.config.cycleDays, 26);
  assert.equal(state.config.followHoliday, false);
  assert.deepEqual(state.tabs, ['/pages/index/index']);
});

test('保存失败留在设置页并显示原因，校验仍拒绝全周休息和过早起点', () => {
  const { page, state } = createPage();
  state.saveError = true;
  page.onSave();
  assert.match(state.toasts[0].title, /存储空间不足/);
  assert.equal(state.tabs.length, 0);
  state.saveError = false;
  page.data.restWeekdays = [0, 1, 2, 3, 4, 5, 6];
  page.onSave();
  assert.match(state.toasts[1].title, /至少保留/);
  page.data.restWeekdays = [];
  page.data.anchorOverride = '2026-09-01';
  page.onSave();
  assert.match(state.toasts[2].title, /不能早于/);
  assert.equal(state.saved.length, 0);
});

test('导入成功通过tab返回首页，重进设置能看见恢复后的配置', () => {
  const { page, state } = createPage();
  page.onImportBackup();
  assert.deepEqual(state.tabs, ['/pages/index/index']);
  page.onShow();
  assert.equal(page.data.cycleDays, 26);
  assert.match(state.modals[0].content, /覆盖当前全部数据/);
});

test('恢复失败留在当前页且不报告成功', () => {
  const { page, state } = createPage();
  state.restoreError = true;
  page.onImportBackup();
  assert.equal(state.tabs.length, 0);
  assert.equal(state.toasts.length, 0);
  assert.equal(state.modals[1].title, '恢复未完成');
  assert.match(state.modals[1].content, /已还原原数据/);
});
