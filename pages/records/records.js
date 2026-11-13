const {
  loadConfig,
  saveConfig,
  getRecords,
  saveRecord,
  deleteRecord,
} = require('../../utils/store');
const { getHolidayMap, getBuiltinMap } = require('../../utils/holiday');
const { buildPaySchedule, buildCycleDetail, normalizeCfg } = require('../../utils/payroll');
const { createSnapshot } = require('../../utils/payslip');

const EMPTY_FORM = {
  id: '',
  cycle: 0,
  plannedDate: '',
  actualDate: '',
  amount: '',
  note: '',
  recipientName: '',
  shareNote: '',
};

function amountText(amount) {
  return Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rulesFingerprint(config) {
  const cfg = normalizeCfg(config);
  return JSON.stringify([
    cfg.startDate, cfg.cycleDays, cfg.anchorOverride, cfg.followHoliday,
    cfg.restWeekdays.slice().sort(),
    Object.keys(cfg.dayOverrides).sort().map((day) => [day, cfg.dayOverrides[day]]),
  ]);
}

Page({
  data: {
    records: [],
    recordGroups: [],
    totalAmount: 0,
    totalAmountText: '0.00',
    showForm: false,
    isEdit: false,
    form: Object.assign({}, EMPTY_FORM),
    today: '',
    periods: [],
    selectedPeriodIndex: 0,
    formLoading: false,
    saving: false,
    loadError: '',
    formNotice: '',
    lastSavedRecordId: '',
  },

  onLoad(options) {
    this.setData({ today: this.fmtToday() });
    this.refresh();
    // 从首页「记录已发薪」跳入：自动弹出表单并带上期数与应发日期
    if (options && (options.cycle || options.id !== undefined)) {
      this.openForm({
        id: options.id,
        cycle: Number(options.cycle),
        plannedDate: options.planned || '',
      });
    }
  },

  onShow() {
    this.setData({ today: this.fmtToday() });
    this.refresh();
    const app = getApp();
    const intent = app.globalData && app.globalData.recordIntent;
    if (intent) {
      app.globalData.recordIntent = null;
      return this.openForm({
        id: intent.id,
        cycle: Number(intent.cycle),
        plannedDate: intent.plannedDate || '',
      });
    }
    this.setTabBarVisible(!this.data.showForm);
  },

  onUnload() {
    this._formRequestId = (this._formRequestId || 0) + 1;
    this.setTabBarVisible(true);
  },

  onHide() {
    if (this.data.formLoading) this.closeForm();
    this.setTabBarVisible(true);
  },

  setTabBarVisible(visible) {
    const method = visible ? 'showTabBar' : 'hideTabBar';
    if (typeof wx[method] === 'function') wx[method]({ animation: false });
  },

  fmtToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  refresh() {
    try {
      const records = getRecords()
        .slice()
        .sort((a, b) => a.actualDate === b.actualDate
          ? b.cycle - a.cycle
          : (a.actualDate < b.actualDate ? 1 : -1));
      const totalAmount = records.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
      const formattedRecords = records.map((r) => {
        const hasAmount = r.amount !== null && r.amount !== undefined;
        return Object.assign({}, r, {
          hasAmount,
          amountText: hasAmount ? `¥${amountText(r.amount)}` : '未记金额',
          dateText: `${Number(r.actualDate.slice(5, 7))}月${Number(r.actualDate.slice(8, 10))}日`,
        });
      });
      const recordGroups = [];
      formattedRecords.forEach((r) => {
        const month = r.actualDate.slice(0, 7);
        let group = recordGroups[recordGroups.length - 1];
        if (!group || group.month !== month) {
          group = {
            month,
            title: `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`,
            records: [],
          };
          recordGroups.push(group);
        }
        group.records.push(r);
      });
      this.setData({
        records: formattedRecords,
        recordGroups,
        totalAmount: Math.round(totalAmount * 100) / 100,
        totalAmountText: amountText(totalAmount),
        loadError: '',
      });
      return true;
    } catch (e) {
      this.setData({ loadError: '发薪记录读取失败，请返回后重试，现有数据未改动' });
      return false;
    }
  },

  /* ---------- 表单 ---------- */

  async openForm(prefill) {
    if (!this.refresh()) return;
    if (prefill && prefill.id !== undefined) {
      // 分享页返回时按记录编号定位；历史重复期数不能误开另一笔记录。
      const exactRecord = this.data.records.find((record) => record.id === prefill.id);
      if (exactRecord) this.openRecord(exactRecord);
      else {
        this.closeForm();
        if (this.data.lastSavedRecordId === prefill.id) this.setData({ lastSavedRecordId: '' });
        wx.showToast({ title: '这条记录已不存在，请重新选择', icon: 'none' });
      }
      return;
    }
    const requestedCycle = prefill && Number(prefill.cycle);
    const existing = this.data.records.find((r) => r.cycle === requestedCycle);
    if (existing) {
      this.openRecord(existing);
      return;
    }
    const requestId = (this._formRequestId || 0) + 1;
    this._formRequestId = requestId;
    this._formContext = null;
    this.setTabBarVisible(false);
    this.setData({
      showForm: true,
      isEdit: false,
      formLoading: true,
      periods: [],
      formNotice: '',
      form: Object.assign({}, EMPTY_FORM, { actualDate: this.data.today }),
    });
    try {
      const cfg = JSON.parse(JSON.stringify(loadConfig()));
      if (!cfg.startDate) throw new Error('请先在设置中填写开始工作日期');
      const today = this.data.today;
      const startYear = Number(cfg.startDate.slice(0, 4));
      let endYear = Math.max(startYear, Number(today.slice(0, 4)), Number((cfg.anchorOverride || cfg.startDate).slice(0, 4))) + 1;
      let holidayMap = cfg.followHoliday === false ? {} : (getBuiltinMap(startYear, endYear) || {});
      let schedule = buildPaySchedule(cfg, holidayMap, today);
      const lastPreview = schedule && schedule.schedule[schedule.schedule.length - 1];
      if (lastPreview) endYear = Math.max(endYear, Number(lastPreview.date.slice(0, 4)));
      const missingYears = [];
      if (cfg.followHoliday !== false) {
        const result = await getHolidayMap(startYear, endYear);
        if (this._formRequestId !== requestId) return;
        holidayMap = result.days;
        missingYears.push(...result.missingYears);
        schedule = buildPaySchedule(cfg, holidayMap, today);
        // 节假日可能把末期推到更远的年份，补齐后再确定表单中的应发日。
        while (schedule && Number(schedule.schedule[schedule.schedule.length - 1].date.slice(0, 4)) > endYear) {
          const nextEndYear = Number(schedule.schedule[schedule.schedule.length - 1].date.slice(0, 4));
          const extra = await getHolidayMap(endYear + 1, nextEndYear);
          if (this._formRequestId !== requestId) return;
          Object.assign(holidayMap, extra.days);
          missingYears.push(...extra.missingYears);
          endYear = nextEndYear;
          schedule = buildPaySchedule(cfg, holidayMap, today);
        }
      }
      if (this._formRequestId !== requestId) return;
      if (!schedule || !schedule.periods || !schedule.periods.length) {
        throw new Error('暂时无法计算期数，请检查上班安排');
      }
      const records = getRecords();
      const recordedCycles = {};
      records.forEach((r) => { recordedCycles[r.cycle] = true; });
      const periods = schedule.periods.map((period) => ({
        cycle: period.cycle,
        date: period.date,
        label: `第 ${period.cycle} 期 · 应发 ${period.date}${recordedCycles[period.cycle] ? ' · 已记录' : ''}`,
      }));
      const defaultPeriod = periods.find((p) => p.cycle >= schedule.cycleIndex && !recordedCycles[p.cycle])
        || periods.find((p) => !recordedCycles[p.cycle]);
      let index = periods.findIndex((p) => p.cycle === (requestedCycle || (defaultPeriod && defaultPeriod.cycle) || schedule.cycleIndex));
      let notice = missingYears.length ? `${missingYears.join('、')} 年放假安排未获取到，应发日期按普通周历估算` : '';
      if (index < 0) {
        index = periods.findIndex((p) => p.cycle === schedule.cycleIndex);
        notice = '结算安排已更新，请核对期数与应发日期';
      } else if (prefill && prefill.plannedDate && prefill.plannedDate !== periods[index].date) {
        notice = '结算安排已更新，应发日期已按当前规则重新计算';
      }
      this._formContext = { config: cfg, signature: rulesFingerprint(cfg), holidayMap, missingYears };
      this.setData({ periods, formLoading: false, formNotice: notice });
      this.selectPeriod(index);
    } catch (e) {
      if (this._formRequestId !== requestId) return;
      this.setData({ formLoading: false, formNotice: e.message || '期数读取失败，请关闭后重试' });
    }
  },

  onAddTap() {
    this.openForm({});
  },

  onEditTap(e) {
    if (this.data.loadError) return;
    const id = e.currentTarget.dataset.id;
    const rec = this.data.records.find((r) => r.id === id);
    if (!rec) return;
    this.openRecord(rec);
  },

  openRecord(rec) {
    this._formRequestId = (this._formRequestId || 0) + 1;
    this._formContext = null;
    this.setTabBarVisible(false);
    this.setData({
      showForm: true,
      isEdit: true,
      formLoading: false,
      formNotice: '该期已有记录，修改后会更新原记录',
      form: {
        id: rec.id,
        cycle: rec.cycle,
        plannedDate: rec.plannedDate || '',
        actualDate: rec.actualDate,
        amount: rec.amount === null || rec.amount === undefined ? '' : String(rec.amount),
        note: rec.note || '',
        recipientName: rec.recipientName || '',
        shareNote: rec.shareNote || '',
      },
    });
  },

  closeForm() {
    if (this.data.saving) return;
    this._formRequestId = (this._formRequestId || 0) + 1;
    this._formContext = null;
    this.setData({ showForm: false, isEdit: false, formLoading: false, form: Object.assign({}, EMPTY_FORM) });
    this.setTabBarVisible(true);
  },

  stopBubble() {},

  onActualDateChange(e) {
    this.setData({ 'form.actualDate': e.detail.value });
  },

  onCycleChange(e) {
    if (this.data.formLoading || this.data.isEdit || this.data.saving) return;
    this.selectPeriod(Number(e.detail.value));
  },

  selectPeriod(index) {
    const period = this.data.periods[index];
    if (!period) return;
    try {
      const existing = getRecords().find((r) => r.cycle === period.cycle);
      if (existing) {
        this.openRecord(existing);
        return;
      }
      this.setData({
        selectedPeriodIndex: index,
        'form.cycle': period.cycle,
        'form.plannedDate': period.date,
      });
    } catch (e) {
      this.setData({ loadError: '发薪记录读取失败，请返回后重试，现有数据未改动' });
    }
  },

  onAmountInput(e) {
    this.setData({ 'form.amount': e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ 'form.note': e.detail.value });
  },

  onRecipientInput(e) {
    this.setData({ 'form.recipientName': e.detail.value });
  },

  onShareNoteInput(e) {
    this.setData({ 'form.shareNote': e.detail.value });
  },

  onPreviewSlip() {
    return this.onSave(true);
  },

  onOpenLastSlip() {
    if (this.data.lastSavedRecordId) this.navigateToSlip(this.data.lastSavedRecordId);
  },

  navigateToSlip(id) {
    wx.navigateTo({
      url: '/pages/payslip/payslip?id=' + encodeURIComponent(id),
      fail: () => wx.showToast({ title: '预览未打开，请重试', icon: 'none' }),
    });
  },

  onSave(preview) {
    if (!this.data.showForm || this.data.saving || this.data.formLoading || this.data.loadError) return;
    const f = this.data.form;
    if (!Number.isInteger(f.cycle) || f.cycle < 1) {
      wx.showToast({ title: '请选择发薪期数', icon: 'none' });
      return;
    }
    if (!f.actualDate) {
      wx.showToast({ title: '请选择实际发薪日期', icon: 'none' });
      return;
    }
    const amount = f.amount === '' ? null : Number(f.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      wx.showToast({ title: '金额格式不对', icon: 'none' });
      return;
    }
    if (preview === true && amount === null) {
      wx.showToast({ title: '请补充实发金额后再预览', icon: 'none' });
      return;
    }
    if ((f.recipientName || '').length > 40 || (f.shareNote || '').length > 500) {
      wx.showToast({ title: '称呼限40字，发薪说明限500字', icon: 'none' });
      return;
    }
    const payload = {
      cycle: f.cycle,
      plannedDate: f.plannedDate || '',
      actualDate: f.actualDate,
      amount,
      note: (f.note || '').trim(),
      recipientName: (f.recipientName || '').trim(),
      shareNote: (f.shareNote || '').trim(),
    };
    if (f.id) payload.id = f.id; // 编辑时才带 id，避免 undefined 键污染
    this.setData({ saving: true });
    try {
      const existing = getRecords().find((r) => r.cycle === f.cycle);
      if (!f.id && existing) {
        this.openRecord(existing);
        wx.showToast({ title: '该期已有记录，请核对后修改', icon: 'none' });
        return;
      }
      if (f.id) {
        const original = getRecords().find((r) => r.id === f.id);
        if (!original || original.cycle !== f.cycle) {
          throw new Error('原记录已变化，请关闭后重新打开');
        }
        // 修改金额、称呼和说明不重算旧日历；旧记录的快照在预览页核对后补存。
        if (original.periodSnapshot) payload.periodSnapshot = original.periodSnapshot;
      } else {
        const context = this._formContext;
        if (!context || context.signature !== rulesFingerprint(loadConfig())) {
          this.setData({ formNotice: '上班安排已变化，请关闭后重新核对期数；本次尚未保存' });
          throw new Error('上班安排已变化，请重新核对期数');
        }
        payload.periodSnapshot = createSnapshot(
          buildCycleDetail(context.config, context.holidayMap, f.plannedDate), context.missingYears
        );
      }
      const saved = saveRecord(payload);
      // 首次记录视为「从本期开始记录」，晚发薪不会改变结算起点。
      const cfg = loadConfig();
      let stateSaved = true;
      if (!cfg.recordStartCycle) {
        try {
          saveConfig({ recordStartCycle: f.cycle });
        } catch (e) {
          stateSaved = false;
        }
      }
      this.setData({ showForm: false, lastSavedRecordId: saved.id });
      this.setTabBarVisible(true);
      this.refresh();
      if (preview === true) this.navigateToSlip(saved.id);
      else wx.showToast({ title: stateSaved ? '已保存' : '记录已保存，首页状态更新失败', icon: stateSaved ? 'success' : 'none' });
      return saved;
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 弹层里的「撤销记录」 */
  onDelete() {
    const id = this.data.form.id;
    if (!id) {
      // 表单处于新增态时不该出现撤销，真出现也要给反馈而不是静默失败
      wx.showToast({ title: '这条记录还没保存过，无需撤销', icon: 'none' });
      return;
    }
    this.confirmDelete(id);
  },

  /** 统一的删除确认流程 */
  confirmDelete(id) {
    let rec;
    try {
      rec = getRecords().find((r) => r.id === id);
    } catch (e) {
      wx.showToast({ title: '记录读取失败，请稍后重试', icon: 'none' });
      return;
    }
    if (!rec) {
      wx.showToast({ title: '记录已不存在，正在刷新', icon: 'none' });
      this.refresh();
      return;
    }
    wx.showModal({
      title: '撤销这条记录？',
      content:
        '第 ' + rec.cycle + ' 期（实发 ' + rec.actualDate + '）将回到未记录状态，不影响发薪日计算。',
      confirmText: '撤销',
      confirmColor: '#A44E38',
      cancelText: '保留',
      success: (res) => {
        if (!res.confirm) return;
        try {
          deleteRecord(id);
        } catch (e) {
          wx.showToast({ title: e.message || '撤销失败，请稍后重试', icon: 'none' });
          return;
        }
        this._formRequestId = (this._formRequestId || 0) + 1;
        this.setData({
          showForm: false,
          isEdit: false,
          form: Object.assign({}, EMPTY_FORM),
          lastSavedRecordId: this.data.lastSavedRecordId === id ? '' : this.data.lastSavedRecordId,
        });
        this.setTabBarVisible(true);
        this.refresh();
        wx.showToast({ title: '已撤销', icon: 'none' });
      },
    });
  },
});
