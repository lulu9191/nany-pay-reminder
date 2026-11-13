const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payroll = require('../utils/payroll');
const payslip = require('../utils/payslip');
const renderer = require('../utils/payslip-canvas');

const config = {
  startDate: '2026-10-16', cycleDays: 22, restWeekdays: [0, 6], followHoliday: false,
  dayOverrides: { '2026-11-07': 'work' }, anchorOverride: '',
};
const snapshot = payslip.createSnapshot(payroll.buildCycleDetail(config, {}, '2026-11-13'));
function record(patch = {}) {
  return Object.assign({ id: 'r1', cycle: 1, plannedDate: '2026-11-13', actualDate: '2026-11-14', amount: 8800,
    recipientName: '王阿姨', shareNote: '含补贴300元', note: '私下备注', periodSnapshot: snapshot }, patch);
}

function setup(options = {}) {
  let definition;
  const state = {
    records: [record(options.record)], config: JSON.parse(JSON.stringify(config)),
    holidays: 0, writes: 0, toasts: [], shares: [], saves: [], previews: [], updates: 0,
  };
  const app = { globalData: {} };
  const wx = {
    hideShareMenu() {},
    showToast: (value) => state.toasts.push(value),
    showShareImageMenu: (value) => state.shares.push(value),
    saveImageToPhotosAlbum: (value) => state.saves.push(value),
    previewImage: (value) => state.previews.push(value),
    switchTab: (value) => { state.navigation = value; },
    openSetting: (value) => { state.settings = value; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/payslip/payslip.js'), 'utf8'), {
    Page: (value) => { definition = value; }, wx, getApp: () => app,
    require: (name) => {
      if (name.endsWith('/store')) return {
        getRecords: () => {
          if (state.readError) throw new Error('记录读取失败');
          return JSON.parse(JSON.stringify(state.records));
        },
        loadConfig: () => state.config,
        saveRecord: (value) => {
          if (state.writeError) throw new Error('存储空间不足');
          state.writes++;
          state.records = [JSON.parse(JSON.stringify(value))];
          return state.records[0];
        },
      };
      if (name.endsWith('/holiday')) return { getHolidayMap: () => {
        state.holidays++;
        return options.holiday ? options.holiday() : Promise.resolve({ days: {}, missingYears: [] });
      } };
      if (name.endsWith('/payroll')) return payroll;
      if (name.endsWith('/payslip-canvas')) return renderer;
      if (name.endsWith('/payslip')) return payslip;
      throw new Error(name);
    },
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value, callback) { state.updates++; Object.assign(this.data, value); if (callback) callback(); },
  });
  const realRender = page.renderImages;
  page.renderImages = async (model) => { state.rendered = model; return ['temp://slip.png']; };
  page.onLoad({ id: 'r1' });
  return { page, state, wx, app, realRender };
}

test('有日期快照的发薪单不依赖当前设置，晚付款不移动周期', async () => {
  const { page, state } = setup();
  state.config.startDate = '2027-01-01';
  await page.onReady();
  assert.equal(page.data.error, '');
  assert.equal(state.holidays, 0);
  assert.equal(state.rendered.cycleRange, '2026.10.16—2026.11.13');
  assert.equal(state.rendered.actualDateText, '2026.11.14');
  assert.equal(state.rendered.workdays, 22);
  assert.equal(state.rendered.restDays, 7);
  assert.ok(!JSON.stringify(state.rendered).includes('私下备注'));
});

test('未填写金额不能生成，真实零元可以生成', async () => {
  const blank = setup({ record: { amount: null } });
  await blank.page.onReady();
  assert.match(blank.page.data.error, /金额/);
  assert.equal(blank.state.rendered, undefined);
  const zero = setup({ record: { amount: 0 } });
  await zero.page.onReady();
  assert.equal(zero.state.rendered.amountText, '0.00');
});

test('旧记录必须核对日历后保存快照，才能分享或保存图片', async () => {
  const { page, state } = setup({ record: { periodSnapshot: undefined } });
  await page.onReady();
  assert.equal(page.data.needsConfirmation, true);
  page.shareImage();
  page.saveImage();
  assert.equal(state.shares.length + state.saves.length, 0);
  assert.equal(state.writes, 0);
  page.confirmSnapshot();
  assert.equal(state.writes, 1);
  assert.equal(page.data.needsConfirmation, false);
  assert.equal(state.records[0].periodSnapshot.days.length, 29);
  page.shareImage();
  assert.equal(state.shares.length, 1);
});

test('当前日期相同但期数不同的旧记录不能误用另一期日历', async () => {
  const { page, state } = setup({ record: { periodSnapshot: undefined, cycle: 2 } });
  await page.onReady();
  assert.match(page.data.error, /无法还原/);
  assert.equal(state.writes, 0);
  assert.equal(page.data.currentImage, '');
});

test('预览后规则变化会阻止补存旧快照，存储失败可重新生成再核对', async () => {
  const { page, state } = setup({ record: { periodSnapshot: undefined } });
  await page.onReady();
  state.config.dayOverrides['2026-10-17'] = 'work';
  page.confirmSnapshot();
  assert.match(page.data.error, /安排已变化/);
  assert.equal(state.writes, 0);
  const failed = setup({ record: { periodSnapshot: undefined } });
  await failed.page.onReady();
  failed.state.writeError = true;
  failed.page.confirmSnapshot();
  assert.equal(failed.page.data.needsConfirmation, true);
  assert.equal(failed.page.data.confirming, false);
  assert.match(failed.page.data.error, /空间不足/);
});

test('发薪记录删除或金额变化后不能转发过时图片', async () => {
  const { page, state } = setup();
  await page.onReady();
  state.records[0].amount = 9900;
  page.shareImage();
  assert.equal(state.shares.length, 0);
  assert.match(page.data.error, /记录已变化/);
  state.records = [];
  await page.loadRecord();
  assert.match(page.data.error, /不存在/);
});

test('分享不携带本机记录地址，取消分享不误报成功或改变付款记录', async () => {
  const { page, state } = setup();
  await page.onReady();
  page.shareImage();
  page.shareImage();
  assert.equal(state.shares.length, 1);
  const share = state.shares[0];
  assert.equal(share.needShowEntrance, false);
  assert.equal(share.entrancePath, 'pages/index/index');
  share.fail({ errMsg: 'showShareImageMenu:fail cancel' });
  share.complete();
  assert.equal(page.data.actionBusy, false);
  assert.equal(state.toasts.length, 0);
  assert.equal(state.writes, 0);
});

test('拒绝相册权限后提供设置入口，用户取消不会报错', async () => {
  const { page, state } = setup();
  await page.onReady();
  page.saveImage();
  state.saves[0].fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
  state.saves[0].complete();
  assert.equal(page.data.albumDenied, true);
  assert.equal(page.data.actionBusy, false);
  page.openAlbumSettings();
  state.settings.success({ authSetting: { 'scope.writePhotosAlbum': true } });
  assert.equal(page.data.albumDenied, false);
  page.saveImage();
  state.saves[1].fail({ errMsg: 'saveImageToPhotosAlbum:fail cancel' });
  state.saves[1].complete();
  assert.equal(state.toasts.length, 0);
});

test('不支持图片分享菜单时可打开图片长按转发', async () => {
  const { page, state, wx } = setup();
  wx.showShareImageMenu = undefined;
  await page.onReady();
  page.shareImage();
  assert.equal(state.previews.length, 1);
  assert.equal(state.previews[0].current, 'temp://slip.png');
});

test('页面退出后丢弃旧请求，不生成图片也不更新页面', async () => {
  let resolve;
  const { page, state } = setup({ record: { periodSnapshot: undefined }, holiday: () => new Promise((r) => { resolve = r; }) });
  state.config.followHoliday = true;
  const loading = page.onReady();
  page.onUnload();
  const updates = state.updates;
  resolve({ days: {}, missingYears: [] });
  await loading;
  assert.equal(state.rendered, undefined);
  assert.equal(state.updates, updates);
});

test('生成途中记录发生变化时不展示旧图片', async () => {
  const { page, state } = setup();
  page.renderImages = async () => {
    state.records[0].shareNote = '已更正';
    return ['temp://old.png'];
  };
  await page.onReady();
  assert.match(page.data.error, /记录已变化/);
  assert.equal(page.data.currentImage, '');
});

test('图片绘制失败提供重试而不写入发薪记录', async () => {
  const { page, state } = setup();
  page.renderImages = async () => { throw new Error('图片生成失败，请重试'); };
  await page.onReady();
  assert.match(page.data.error, /图片生成失败/);
  assert.equal(page.data.loading, false);
  assert.equal(state.writes, 0);
});

test('返回编辑携带记录编号，读取失败保持当前页面并提示', async () => {
  const { page, state, app } = setup();
  await page.onReady();
  page.editRecord();
  assert.equal(app.globalData.recordIntent.id, 'r1');
  assert.equal(state.navigation.url, '/pages/records/records');
  state.navigation = null;
  state.readError = true;
  page.editRecord();
  assert.equal(state.navigation, null);
  assert.match(state.toasts[0].title, /读取失败/);
});
