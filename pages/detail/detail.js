const { loadConfig, saveConfig } = require('../../utils/store');
const { getBuiltinMap, getHolidayMap, todayStr } = require('../../utils/holiday');
const { buildPaySchedule, buildCycleDetail } = require('../../utils/payroll');

/** 只由本期明细生成月历，周一为每周第一天，周期外日期不能修改。 */
function calendarState(detail, selectedMonth, today) {
  const days = detail ? detail.days : [];
  const months = [];
  days.forEach((day) => {
    const month = day.date.slice(0, 7);
    if (months.indexOf(month) === -1) months.push(month);
  });
  if (!months.length) {
    return { calendarMonths: [], calendarMonthIndex: 0, calendarMonth: null, monthDays: [] };
  }
  let index = months.indexOf(selectedMonth);
  if (index === -1) index = months.indexOf(today.slice(0, 7));
  if (index === -1) index = 0;
  const monthKey = months[index];
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const dayCount = new Date(year, month, 0).getDate();
  const monthDays = days.filter((day) => day.date.slice(0, 7) === monthKey).map((day) =>
    Object.assign({}, day, { shortDate: `${Number(day.date.slice(5, 7))}月${Number(day.date.slice(8, 10))}日` }));
  const byDate = {};
  monthDays.forEach((day) => { byDate[day.date] = day; });
  const cells = [];
  const cellCount = Math.ceil((offset + dayCount) / 7) * 7;
  for (let position = 0; position < cellCount; position++) {
    const dayNumber = position - offset + 1;
    if (dayNumber < 1 || dayNumber > dayCount) {
      cells.push({ key: `empty-${position}`, kind: 'empty', date: '', number: '', label: '' });
      continue;
    }
    const date = `${monthKey}-${String(dayNumber).padStart(2, '0')}`;
    const day = byDate[date];
    const kind = !day ? 'outside' : day.isSettlement ? 'payday' : day.work ? 'work' : 'rest';
    cells.push({
      key: date, date: day ? date : '', number: dayNumber, kind,
      label: !day ? '' : day.isSettlement ? '发薪' : day.work ? '计入' : '休息',
      isToday: date === today,
      accessibilityLabel: day ? `${date}，${day.isSettlement ? '发薪日，' : ''}${day.label}，可调整` : `${date}，不在本期`,
    });
  }
  return {
    calendarMonths: months,
    calendarMonthIndex: index,
    calendarMonth: {
      key: monthKey, title: `${year} 年 ${month} 月`, cells,
      canPrevious: index > 0, canNext: index < months.length - 1,
    },
    monthDays,
  };
}

Page({
  data: {
    schedule: null,
    detail: null,
    loading: true,
    holidayWarning: '',
    error: '',
    calendarWeekdays: ['一', '二', '三', '四', '五', '六', '日'],
    calendarMonths: [],
    calendarMonthIndex: 0,
    calendarMonth: null,
    monthDays: [],
  },

  onShow() {
    this.compute();
  },

  onHide() { this._requestId = (this._requestId || 0) + 1; },
  onUnload() { this.onHide(); },

  async compute() {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const config = loadConfig();
    this.setData({ loading: true, error: '', holidayWarning: '' });
    if (!config.startDate) {
      this.setData(Object.assign({ loading: false, schedule: null, detail: null }, calendarState(null, '', '')));
      return;
    }
    const today = todayStr();
    const startYear = Number(config.startDate.slice(0, 4));
    let endYear = Math.max(Number(today.slice(0, 4)), Number((config.anchorOverride || config.startDate).slice(0, 4))) + 1;

    try {
      // 先用内置表出一版，再联网补齐未覆盖年份。
      const builtinMap = getBuiltinMap(startYear, endYear);
      this.render(config, builtinMap, today);
      if (this.data.schedule) endYear = Math.max(endYear, Number(this.data.schedule.nextSettlement.slice(0, 4)));
      let result = config.followHoliday === false
        ? { days: {}, missingYears: [] }
        : await getHolidayMap(startYear, endYear);
      if (requestId !== this._requestId) return;
      let schedule = buildPaySchedule(config, result.days, today);
      while (config.followHoliday !== false && schedule && Number(schedule.nextSettlement.slice(0, 4)) > endYear) {
        const lastYear = Number(schedule.nextSettlement.slice(0, 4));
        const extra = await getHolidayMap(endYear + 1, lastYear);
        if (requestId !== this._requestId) return;
        result = { days: Object.assign({}, result.days, extra.days), missingYears: result.missingYears.concat(extra.missingYears) };
        endYear = lastYear;
        schedule = buildPaySchedule(config, result.days, today);
      }
      this.render(config, result.days, today);
      this.setData({
        loading: false,
        holidayWarning: result.missingYears.length
          ? `${result.missingYears.join('、')} 年放假安排暂未获取到，相关日期按普通周历估算`
          : '',
      });
    } catch (err) {
      if (requestId !== this._requestId) return;
      this.setData({ loading: false, error: err.message || '计算失败，请重试' });
    }
  },

  render(config, holidayMap, today) {
    const schedule = buildPaySchedule(config, holidayMap, today);
    const detail = schedule
      ? buildCycleDetail(config, holidayMap, schedule.nextSettlement)
      : null;
    const displaySchedule = schedule ? Object.assign({}, schedule) : null;
    if (displaySchedule) delete displaySchedule.periods;
    const selectedMonth = this.data.calendarMonth ? this.data.calendarMonth.key : '';
    this.setData(Object.assign({ schedule: displaySchedule, detail }, calendarState(detail, selectedMonth, today)));
  },

  onMonthChange(e) {
    const step = Number(e.currentTarget.dataset.step);
    if (step !== -1 && step !== 1) return;
    const nextIndex = this.data.calendarMonthIndex + step;
    const month = this.data.calendarMonths[nextIndex];
    if (!month) return;
    this.setData(calendarState(this.data.detail, month, todayStr()));
  },

  /** 点某一天：临时标记上班 / 休息 / 恢复默认 */
  onDayTap(e) {
    if (this.data.loading || this.data.error) return;
    const date = e.currentTarget.dataset.date;
    if (!date || !this.data.detail || !this.data.detail.days.some((day) => day.date === date)) return;
    const cfg = loadConfig();
    const current = (cfg.dayOverrides || {})[date];
    wx.showActionSheet({
      itemList: [
        current === 'work' ? '取消临时上班标记' : '这天上班，计入周期',
        current === 'rest' ? '取消临时休息标记' : '这天休息，不计入周期',
        '恢复每周及节假日安排',
      ],
      success: (res) => {
        const overrides = Object.assign({}, cfg.dayOverrides);
        if (res.tapIndex === 0) {
          if (current === 'work') delete overrides[date];
          else overrides[date] = 'work';
        } else if (res.tapIndex === 1) {
          if (current === 'rest') delete overrides[date];
          else overrides[date] = 'rest';
        } else {
          delete overrides[date];
        }
        try {
          saveConfig({ dayOverrides: overrides });
        } catch (err) {
          wx.showToast({ title: err.message || '保存失败，请重试', icon: 'none' });
          return;
        }
        this.compute();
      },
    });
  },

  goSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
  },
});
