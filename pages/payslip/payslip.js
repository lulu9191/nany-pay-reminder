const { getRecords, saveRecord, loadConfig } = require('../../utils/store');
const { getHolidayMap } = require('../../utils/holiday');
const { buildPaySchedule, buildCycleDetail, normalizeCfg } = require('../../utils/payroll');
const { createSnapshot, buildSlipView } = require('../../utils/payslip');
const { createPosterPages, drawPoster } = require('../../utils/payslip-canvas');

function ruleKey(config) {
  const cfg = normalizeCfg(config);
  return JSON.stringify([
    cfg.startDate, cfg.cycleDays, cfg.restWeekdays.slice().sort(), cfg.followHoliday,
    cfg.anchorOverride, Object.keys(cfg.dayOverrides).sort().map((date) => [date, cfg.dayOverrides[date]]),
  ]);
}

function cancelled(error) {
  return /cancel/i.test((error && error.errMsg) || '');
}

Page({
  data: {
    loading: true,
    error: '',
    images: [],
    imageIndex: 0,
    currentImage: '',
    canvasHeight: 1600,
    needsConfirmation: false,
    confirming: false,
    actionBusy: false,
    albumDenied: false,
    notice: '',
  },

  onLoad(options) {
    this._recordId = options && options.id;
    this._requestId = 0;
    this._disposed = false;
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu();
  },

  onReady() {
    return this.loadRecord();
  },

  onUnload() {
    this._disposed = true;
    this._requestId++;
    this._canvas = null;
  },

  async loadRecord() {
    if (this.data.actionBusy || this.data.confirming) return;
    const requestId = ++this._requestId;
    this.setData({ loading: true, error: '', images: [], currentImage: '', imageIndex: 0, needsConfirmation: false, notice: '' });
    this._candidate = null;
    try {
      const record = getRecords().find((item) => item.id === this._recordId);
      if (!record) throw new Error('这条发薪记录已不存在，请返回记录页重新选择');
      if (record.amount === null || record.amount === undefined) {
        throw new Error('这期还没有填写实发金额，请补充后再生成发薪单');
      }
      this._recordBaseline = JSON.stringify(record);
      let candidate = record;
      let needsConfirmation = false;
      if (!record.periodSnapshot) {
        if (!record.plannedDate) throw new Error('这条旧记录没有保存本期区间，暂时无法还原工作日历');
        const cfg = JSON.parse(JSON.stringify(loadConfig()));
        if (!cfg.startDate) throw new Error('请先在设置中填写开始工作日期，再核对本期区间');
        this._ruleBaseline = ruleKey(cfg);
        const result = cfg.followHoliday === false
          ? { days: {}, missingYears: [] }
          : await getHolidayMap(Number(cfg.startDate.slice(0, 4)), Number(record.plannedDate.slice(0, 4)));
        if (requestId !== this._requestId || this._disposed) return;
        const schedule = buildPaySchedule(cfg, result.days, record.plannedDate, 1);
        const period = schedule && schedule.periods.find((item) => item.cycle === record.cycle && item.date === record.plannedDate);
        const detail = period && buildCycleDetail(cfg, result.days, record.plannedDate);
        if (!detail) throw new Error('这条旧记录未保存当时的工作日历，当前安排也无法还原该期。请先核对原来的上班安排');
        candidate = Object.assign({}, record, { periodSnapshot: createSnapshot(detail, result.missingYears) });
        needsConfirmation = true;
      }
      const model = buildSlipView(candidate);
      this._candidate = candidate;
      this._model = model;
      this.setData({ needsConfirmation, notice: model.notice || '' });
      const images = await this.renderImages(model, requestId);
      if (!images || requestId !== this._requestId || this._disposed) return;
      // 日期核对/生成期间发生的修改不能悄悄混入当前图片。
      this.checkUnchanged(needsConfirmation);
      this.setData({ images, currentImage: images[0], imageIndex: 0, loading: false });
    } catch (error) {
      if (requestId !== this._requestId || this._disposed) return;
      this.setData({ loading: false, error: error.message || '图片生成失败，请重试', images: [], currentImage: '' });
    }
  },

  getCanvas() {
    if (this._canvas) return Promise.resolve(this._canvas);
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#payslip-canvas').fields({ node: true, size: true }).exec((result) => {
        const canvas = result && result[0] && result[0].node;
        if (!canvas || !canvas.getContext) {
          reject(new Error('当前微信暂不支持图片生成，请更新微信后重试'));
          return;
        }
        this._canvas = canvas;
        resolve(canvas);
      });
    });
  },

  async renderImages(model, requestId) {
    const canvas = await this.getCanvas();
    if (requestId !== this._requestId || this._disposed) return null;
    const context = canvas.getContext('2d');
    const pages = createPosterPages(model, context);
    const images = [];
    for (const page of pages) {
      if (requestId !== this._requestId || this._disposed) return null;
      await new Promise((resolve) => this.setData({ canvasHeight: page.height }, resolve));
      if (requestId !== this._requestId || this._disposed) return null;
      // 固定两倍分辨率，兼顾聊天中的文字清晰度和长图的内存开销。
      canvas.width = page.width * 2;
      canvas.height = page.height * 2;
      context.scale(2, 2);
      drawPoster(context, model, page);
      if (canvas.requestAnimationFrame) await new Promise((resolve) => canvas.requestAnimationFrame(resolve));
      if (requestId !== this._requestId || this._disposed) return null;
      const path = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas, fileType: 'png', destWidth: canvas.width, destHeight: canvas.height,
          success: (result) => result.tempFilePath ? resolve(result.tempFilePath) : reject(new Error('图片未生成，请重试')),
          fail: () => reject(new Error('图片生成失败，请重试')),
        }, this);
      });
      images.push(path);
    }
    return images;
  },

  checkUnchanged(checkRules) {
    const latest = getRecords().find((item) => item.id === this._recordId);
    if (!latest || JSON.stringify(latest) !== this._recordBaseline) {
      throw new Error('发薪记录已变化，请重新生成图片');
    }
    if (checkRules && ruleKey(loadConfig()) !== this._ruleBaseline) {
      throw new Error('上班安排已变化，请重新核对本期日历');
    }
    return latest;
  },

  confirmSnapshot() {
    if (!this.data.needsConfirmation || this.data.loading || this.data.error || this.data.confirming || !this._candidate) return;
    this.setData({ confirming: true });
    try {
      const current = this.checkUnchanged(true);
      const saved = saveRecord(Object.assign({}, current, { periodSnapshot: this._candidate.periodSnapshot }));
      this._candidate = saved;
      this._recordBaseline = JSON.stringify(saved);
      this.setData({ needsConfirmation: false });
      wx.showToast({ title: '本期日历已保存', icon: 'success' });
    } catch (error) {
      this.setData({ error: error.message || '保存失败，请重试' });
    } finally {
      this.setData({ confirming: false });
    }
  },

  canExport() {
    if (this.data.loading || this.data.error || this.data.needsConfirmation || this.data.actionBusy || !this.data.currentImage) return false;
    try {
      this.checkUnchanged(false);
      return true;
    } catch (error) {
      this.setData({ error: error.message });
      return false;
    }
  },

  changeImage(event) {
    if (this.data.actionBusy) return;
    const next = this.data.imageIndex + Number(event.currentTarget.dataset.step);
    if (!Number.isInteger(next) || next < 0 || next >= this.data.images.length) return;
    this.setData({ imageIndex: next, currentImage: this.data.images[next] });
  },

  previewImage() {
    if (!this.canExport()) return;
    wx.previewImage({ urls: this.data.images, current: this.data.currentImage });
  },

  shareImage() {
    if (!this.canExport()) return;
    if (typeof wx.showShareImageMenu !== 'function') {
      wx.showToast({ title: '长按图片即可保存或转发', icon: 'none' });
      this.previewImage();
      return;
    }
    this.setData({ actionBusy: true });
    wx.showShareImageMenu({
      path: this.data.currentImage,
      needShowEntrance: false,
      // 即使旧客户端忽略 needShowEntrance，也不会把本机记录地址放入入口。
      entrancePath: 'pages/index/index',
      fail: (error) => {
        if (!this._disposed && !cancelled(error)) wx.showToast({ title: '暂时无法分享，可先保存图片', icon: 'none' });
      },
      complete: () => { if (!this._disposed) this.setData({ actionBusy: false }); },
    });
  },

  saveImage() {
    if (!this.canExport()) return;
    if (typeof wx.saveImageToPhotosAlbum !== 'function') {
      wx.showToast({ title: '请在微信中长按图片保存', icon: 'none' });
      this.previewImage();
      return;
    }
    this.setData({ actionBusy: true, albumDenied: false });
    wx.saveImageToPhotosAlbum({
      filePath: this.data.currentImage,
      success: () => {
        if (!this._disposed) wx.showToast({ title: this.data.images.length > 1 ? `第 ${this.data.imageIndex + 1} 张已保存` : '已保存到相册', icon: 'success' });
      },
      fail: (error) => {
        if (this._disposed || cancelled(error)) return;
        if (/auth|deny|denied|permission/i.test((error && error.errMsg) || '')) {
          this.setData({ albumDenied: true });
        } else {
          wx.showToast({ title: '保存失败，请检查相册权限后重试', icon: 'none' });
        }
      },
      complete: () => { if (!this._disposed) this.setData({ actionBusy: false }); },
    });
  },

  openAlbumSettings() {
    if (typeof wx.openSetting !== 'function') return;
    wx.openSetting({
      success: (result) => {
        if (!this._disposed && result.authSetting && result.authSetting['scope.writePhotosAlbum']) this.setData({ albumDenied: false });
      },
    });
  },

  editRecord() {
    if (this.data.actionBusy || this.data.confirming) return;
    let record;
    try {
      record = getRecords().find((item) => item.id === this._recordId);
    } catch (error) {
      wx.showToast({ title: error.message || '记录读取失败，请重试', icon: 'none' });
      return;
    }
    const app = getApp();
    app.globalData.recordIntent = record ? { id: record.id, cycle: record.cycle, plannedDate: record.plannedDate } : null;
    wx.switchTab({
      url: '/pages/records/records',
      fail: () => {
        app.globalData.recordIntent = null;
        wx.showToast({ title: '未能打开记录页，请重试', icon: 'none' });
      },
    });
  },
});
