const {
  loadConfig,
  saveConfig,
  getRecords,
  getCalendarAdded,
  addCalendarAdded,
  getCalendarReviewRequired,
  resetCalendarTracking,
} = require('../../utils/store');
const {
  getHolidayMap,
  getBuiltinMap,
  todayStr,
  parseDate,
  formatDate,
} = require('../../utils/holiday');
const { buildPaySchedule, weekdayLabel } = require('../../utils/payroll');

const GREETINGS = ['早上好', '上午好', '下午好', '晚上好'];

function greetingText() {
  const h = new Date().getHours();
  if (h < 9) return GREETINGS[0];
  if (h < 12) return GREETINGS[1];
  if (h < 18) return GREETINGS[2];
  return GREETINGS[3];
}

function todayDisplay() {
  const now = new Date();
  const md = `${now.getMonth() + 1}月${now.getDate()}日`;
  return `${md} ${weekdayLabel(formatDate(now))}`;
}

function dateLabel(dateStr) {
  if (!dateStr) return '';
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 发薪日 9:00 的时间戳（秒）——日历日程的提醒时点 */
function paydayAt9(dateStr) {
  const d = parseDate(dateStr);
  d.setHours(9, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 每周休息日的展示文案 */
function restText(restWeekdays, followHoliday) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  let base;
  if (!restWeekdays || restWeekdays.length === 0) base = '全周上班';
  else if (restWeekdays.length === 2 && restWeekdays.indexOf(0) !== -1 && restWeekdays.indexOf(6) !== -1) base = '五休二';
  else base = '休周' + restWeekdays.slice().sort().map((d) => names[d]).join('、周');
  return followHoliday ? base : base + ' · 节假日照常算';
}

Page({
  data: {
    hasConfig: false,
    config: {},
    cycleDays: 22,
    restText: '',
    schedule: null,
    holidayWarning: '',
    scheduleLoading: false,
    dataError: '',
    calendarReviewRequired: false,
    calendarSummary: '',
    greeting: '',
    todayText: '',
    status: null, // 本期状态：fresh/pending/today/overdue/done
    recordsSummary: '',
    latestRecord: null,
    payDateText: '',
    cycleRangeText: '',
    futureRows: [],
    scheduleExpanded: false,
    addedCount: 0,
    calendarBtnText: '添加发薪提醒',
  },

  onShow() {
    const config = loadConfig();
    this.setData({
      greeting: greetingText(),
      todayText: todayDisplay(),
      config,
      hasConfig: !!config.startDate,
      cycleDays: config.cycleDays,
      restText: restText(config.restWeekdays, config.followHoliday !== false),
      dataError: '',
      holidayWarning: '',
    });
    try {
      const records = getRecords();
      const totalAmount = records.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
      const latest = records.slice().sort((a, b) => b.actualDate.localeCompare(a.actualDate))[0];
      this.setData({
        latestRecord: latest ? Object.assign({}, latest, { dateText: dateLabel(latest.actualDate), amountText: latest.amount === null || latest.amount === undefined ? '未记金额' : '¥' + Number(latest.amount).toFixed(2) }) : null,
        recordsSummary: records.length
          ? `${records.length} 期 · ¥${Math.round(totalAmount * 100) / 100}`
          : '还没记过',
      });
    } catch (err) {
      this.setData({ dataError: err.message || '发薪记录读取失败，请检查本地数据', recordsSummary: '读取失败', latestRecord: null });
    }
    if (config.startDate) this.computeSchedule(config);
    else this.setData({ schedule: null, status: null, scheduleLoading: false });
  },

  onHide() { this._requestId = (this._requestId || 0) + 1; },
  onUnload() { this.onHide(); },

  /** 预览立即显示；数据确认前禁用记录和日历操作，避免把估算结果写入。 */
  async computeSchedule(config) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const today = todayStr();
    const startYear = Number(config.startDate.slice(0, 4));
    let endYear = Math.max(Number(today.slice(0, 4)), Number((config.anchorOverride || config.startDate).slice(0, 4))) + 1;
    this.setData({ scheduleLoading: true });
    try {
      const builtinMap = getBuiltinMap(startYear, endYear);
      const preview = this.applySchedule(config, builtinMap, today);
      if (preview) endYear = Math.max(endYear, Number(preview.schedule[preview.schedule.length - 1].date.slice(0, 4)));
      let result = config.followHoliday === false
        ? { days: {}, missingYears: [] }
        : await getHolidayMap(startYear, endYear);
      if (requestId !== this._requestId) return;
      let schedule = buildPaySchedule(config, result.days, today);
      // 节假日可能把最后一期推到新的年份，补取到实际排期覆盖的最后一年。
      while (config.followHoliday !== false && schedule) {
        const lastYear = Number(schedule.schedule[schedule.schedule.length - 1].date.slice(0, 4));
        if (lastYear <= endYear) break;
        const extra = await getHolidayMap(endYear + 1, lastYear);
        if (requestId !== this._requestId) return;
        result = { days: Object.assign({}, result.days, extra.days), missingYears: result.missingYears.concat(extra.missingYears) };
        endYear = lastYear;
        schedule = buildPaySchedule(config, result.days, today);
      }
      this.applySchedule(config, result.days, today);
      this.setData({
        scheduleLoading: false,
        holidayWarning: result.missingYears.length
          ? `${result.missingYears.join('、')} 年放假安排暂未获取到，相关日期按普通周历估算。`
          : '',
      });
    } catch (err) {
      if (requestId !== this._requestId) return;
      this.setData({ scheduleLoading: false, dataError: err.message || '计算失败，请重新进入后重试' });
    }
  },

  applySchedule(config, holidayMap, today) {
    const schedule = buildPaySchedule(config, holidayMap, today);
    this._fullSchedule = schedule;
    let status = null;
    if (schedule) {
      try { status = this.computeStatus(config, schedule, today); }
      catch (err) { this.setData({ dataError: err.message || '发薪记录读取失败' }); }
    }
    // 历史周期只参与状态计算，不把整段历史传给页面渲染。
    const displaySchedule = schedule ? Object.assign({}, schedule) : null;
    if (displaySchedule) delete displaySchedule.periods;
    this.setData({
      schedule: displaySchedule, status,
      payDateText: schedule ? dateLabel(schedule.nextSettlement) : '',
      cycleRangeText: schedule ? `${dateLabel(schedule.cycleStart)} — ${dateLabel(schedule.nextSettlement)}` : '',
    });
    this.updateFutureRows();
    this.refreshCalendarState(schedule);
    return schedule;
  },

  /** 下一次发薪日期与待补记的历史周期分别计算，优先处理已到期未记录项。 */
  computeStatus(config, schedule, today) {
    const records = getRecords();
    const byCycle = {};
    records.forEach((record) => { byCycle[record.cycle] = record; });
    const target = { cycle: schedule.cycleIndex, plannedDate: schedule.nextSettlement };
    const recordingStart = config.recordStartCycle ||
      (records.length ? records.reduce((first, r) => Math.min(first, r.cycle), Infinity) : 0);
    if (!recordingStart) {
      return Object.assign(target, {
        key: 'fresh', tag: '记录未开启',
        desc: '从这一期开始，记下每次实发情况。',
        btn: '从本期开始记录',
      });
    }
    const overdue = (schedule.periods || []).filter((period) =>
      period.cycle >= recordingStart && period.date < today && !byCycle[period.cycle]);
    if (overdue.length) {
      const period = overdue[0];
      const days = Math.round((parseDate(today) - parseDate(period.date)) / 86400000);
      return {
        cycle: period.cycle, plannedDate: period.date,
        key: 'overdue', tag: '到期未记录',
        desc: `第 ${period.cycle} 期原定 ${period.date} 发薪，已过 ${days} 天。${overdue.length > 1 ? '共 ' + overdue.length + ' 期待补记。' : ''}未记录不等于未发薪，补记不会改变后续排期。`,
        btn: '补记这一期',
      };
    }
    const rec = byCycle[schedule.cycleIndex];
    if (rec) {
      const amountText = rec.amount !== null && rec.amount !== undefined ? ' ¥' + rec.amount : '';
      return Object.assign(target, {
        key: 'done', tag: '已记录',
        desc: `${rec.actualDate} 已发${amountText}${rec.note ? ' · ' + rec.note : ''}`,
        btn: '查看 / 修改这条记录',
      });
    }
    if (schedule.isPaydayToday) {
      return Object.assign(target, {
        key: 'today', tag: '今天到期',
        desc: `今天是第 ${schedule.cycleIndex} 期发薪日，别忘了转账`, btn: '记录已发薪',
      });
    }
    return Object.assign(target, {
      key: 'pending', tag: '待发薪',
      desc: `${schedule.nextSettlement}（${schedule.nextWeekday}）应发，还有 ${schedule.remainingNaturalDays} 天`,
      btn: '记录已发薪',
    });
  },

  refreshCalendarState(schedule) {
    const added = getCalendarAdded();
    const dates = schedule ? schedule.schedule.map((item) => item.date) : [];
    const matching = dates.filter((date) => added.indexOf(date) !== -1);
    const missing = dates.length - matching.length;
    const reviewRequired = getCalendarReviewRequired();
    this.setData({
      addedCount: matching.length,
      calendarReviewRequired: reviewRequired,
      calendarSummary: matching.length
        ? `当前计划中已添加 ${matching.length} 期，最晚至 ${matching[matching.length - 1]}${missing ? '；还有 ' + missing + ' 期未添加' : ''}`
        : '当前计划尚未添加提醒',
      calendarBtnText: reviewRequired ? '处理旧提醒后重新添加'
        : missing ? `添加 ${missing} 期提醒` : '查看添加状态',
    });
  },

  onReviewCalendar() {
    wx.showModal({
      title: '先处理系统日历中的旧提醒',
      content: '请先到手机系统日历删除本工具此前添加的发薪提醒。确认处理后会清除本地添加记录，便于按新计划重新添加；小程序不会自动删除系统日历事项。',
      confirmText: '已处理', cancelText: '稍后处理',
      success: (res) => {
        if (!res.confirm) return;
        try {
          resetCalendarTracking();
          this.refreshCalendarState(this.data.schedule);
          wx.showToast({ title: '可按新计划添加提醒', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: '更新失败，请重试', icon: 'none' });
        }
      },
    });
  },

  /* ---------- 状态卡动作 ---------- */

  onStatusBtn() {
    const { status, schedule, scheduleLoading, dataError } = this.data;
    if (!status || !schedule || scheduleLoading || dataError) return;
    if (status.key === 'fresh') {
      try {
        const config = saveConfig({ recordStartCycle: schedule.cycleIndex });
        this.setData({ config, status: this.computeStatus(config, this._fullSchedule, todayStr()) });
        wx.showToast({ title: '已从本期开始记录', icon: 'success' });
      } catch (err) {
        wx.showToast({ title: err.message || '保存失败，请重试', icon: 'none' });
      }
      return;
    }
    const app = getApp();
    const intent = { cycle: status.cycle, plannedDate: status.plannedDate };
    app.globalData.recordIntent = intent;
    wx.switchTab({
      url: '/pages/records/records',
      fail: () => {
        if (app.globalData.recordIntent === intent) app.globalData.recordIntent = null;
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      },
    });
  },

  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail' });
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' });
  },

  goSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
  },

  updateFutureRows() {
    const items = this.data.schedule ? this.data.schedule.schedule : [];
    const rows = items.map((item) => ({
      date: item.date, cycle: item.cycle, weekday: item.weekday, isNext: item.isNext,
      month: Number(item.date.slice(5, 7)) + '月', day: item.date.slice(8, 10),
      year: item.date.slice(0, 4),
    }));
    this.setData({ futureRows: this.data.scheduleExpanded ? rows : rows.slice(0, 3) });
  },

  onToggleSchedule() {
    this.setData({ scheduleExpanded: !this.data.scheduleExpanded });
    this.updateFutureRows();
  },

  /**
   * 把未来发薪日逐个写入手机系统日历（带 9:00 提醒）
   * wx.addPhoneCalendar：基础库 2.15.0+ 起支持（具体以官方文档核实）
   */
  onAddToCalendar() {
    if (this._addingCalendar || this.data.scheduleLoading || this.data.dataError) return;
    if (getCalendarReviewRequired()) { this.onReviewCalendar(); return; }
    const schedule = this.data.schedule;
    if (!schedule || !schedule.schedule || schedule.schedule.length === 0) {
      wx.showToast({ title: '发薪日还没算出来', icon: 'none' });
      return;
    }
    if (!wx.addPhoneCalendar) {
      wx.showToast({ title: '当前微信版本不支持，请升级微信', icon: 'none' });
      return;
    }

    const alreadyAdded = getCalendarAdded();
    const todo = schedule.schedule.filter((item) => alreadyAdded.indexOf(item.date) === -1);
    if (todo.length === 0) {
      wx.showToast({ title: '这些发薪日都已在日历里啦', icon: 'none' });
      return;
    }

    this._addingCalendar = true;
    wx.showLoading({ title: '正在写入 1/' + todo.length, mask: true });

    let success = 0;
    let denied = false;
    const addedDates = [];

    const addNext = (index) => {
      if (index >= todo.length || denied) {
        this._addingCalendar = false;
        wx.hideLoading();
        try {
          if (addedDates.length) addCalendarAdded(addedDates);
          this.refreshCalendarState(this.data.schedule);
        } catch (err) {
          wx.showModal({ title: '请核对系统日历', content: '日历事项可能已添加，但本地状态保存失败。请先检查系统日历，避免重复添加。', showCancel: false });
          return;
        }
        if (denied && success === 0) {
          wx.showToast({ title: '未授权日历权限，写入失败', icon: 'none' });
        } else if (success > 0) {
          wx.showToast({ title: `已写入 ${success} 个发薪日提醒`, icon: 'success' });
        } else {
          wx.showToast({ title: '写入失败，请重试', icon: 'none' });
        }
        return;
      }

      const item = todo[index];
      wx.showLoading({ title: `正在写入 ${index + 1}/${todo.length}`, mask: true });
      wx.addPhoneCalendar({
        title: `💰 第${item.cycle}期发薪日`,
        startTime: paydayAt9(item.date),
        endTime: paydayAt9(item.date) + 1800,
        description: '小新发薪 · 工资结算日提醒',
        alarm: true,
        alarmOffset: 0, // 发薪日当天 9:00 准点提醒
        success: () => {
          success++;
          addedDates.push(item.date);
        },
        fail: (err) => {
          console.error('日历写入失败', item.date, err);
          // 授权被拒绝则中止后续写入
          if (err && err.errMsg && err.errMsg.indexOf('auth') !== -1) {
            denied = true;
          }
        },
        complete: () => {
          addNext(index + 1);
        },
      });
    };

    addNext(0);
  },
});
