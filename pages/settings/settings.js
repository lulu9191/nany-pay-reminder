const {
  loadConfig,
  saveConfig,
  exportData,
  parseBackup,
  applyBackup,
} = require('../../utils/store');
const { todayStr } = require('../../utils/holiday');

const WEEK_CHIPS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

Page({
  data: {
    startDate: '',
    cycleDays: 22,
    cycleOptions: [],
    cycleIndex: 21,
    weekChips: [],
    restWeekdays: [],
    followHoliday: true,
    anchorOverride: '',
    advancedOpen: false,
    today: '',
  },

  onLoad() {
    const cycleOptions = [];
    for (let i = 1; i <= 60; i++) {
      cycleOptions.push(`${i} 个工作日`);
    }
    this.setData({ cycleOptions });
    this.reloadConfig();
  },

  onShow() {
    // Tab 页面会常驻，重新进入时同步恢复备份或其他页面修改过的配置。
    this.reloadConfig();
  },

  reloadConfig() {
    const config = loadConfig();
    this.setData({
      today: todayStr(),
      startDate: config.startDate || '',
      cycleDays: config.cycleDays || 22,
      cycleIndex: (config.cycleDays || 22) - 1,
      weekChips: WEEK_CHIPS.map((c) =>
        Object.assign({}, c, {
          active: (config.restWeekdays || []).indexOf(c.value) !== -1,
        })
      ),
      restWeekdays: (config.restWeekdays || []).slice(),
      followHoliday: config.followHoliday !== false,
      anchorOverride: config.anchorOverride || '',
    });
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value });
  },

  onCycleChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      cycleIndex: index,
      cycleDays: index + 1,
    });
  },

  /** 每周休息日多选 */
  onWeekChipTap(e) {
    const value = Number(e.currentTarget.dataset.value);
    const restWeekdays = this.data.restWeekdays.slice();
    const idx = restWeekdays.indexOf(value);
    if (idx === -1) restWeekdays.push(value);
    else restWeekdays.splice(idx, 1);
    this.setData({
      restWeekdays,
      weekChips: this.data.weekChips.map((c) =>
        Object.assign({}, c, { active: restWeekdays.indexOf(c.value) !== -1 })
      ),
    });
  },

  onHolidayChange(e) {
    this.setData({ followHoliday: e.detail.value });
  },

  onAdvancedToggle() {
    this.setData({ advancedOpen: !this.data.advancedOpen });
  },

  onAnchorChange(e) {
    this.setData({ anchorOverride: e.detail.value });
  },

  onAnchorClear() {
    this.setData({ anchorOverride: '' });
  },

  /* ---------------- 数据备份与恢复 ---------------- */

  /** 导出备份：写临时文件 → 转发到微信聊天（文件传输助手即可） */
  onExportBackup() {
    if (!wx.shareFileMessage) {
      wx.showToast({ title: '当前环境不支持文件分享，请在新版微信中重试', icon: 'none' });
      return;
    }
    const fs = wx.getFileSystemManager();
    const filePath = wx.env.USER_DATA_PATH + '/nanny-pay-backup.json';
    try {
      fs.writeFileSync(filePath, exportData(), 'utf8');
    } catch (e) {
      wx.showToast({ title: '备份文件生成失败', icon: 'none' });
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName: '小新发薪备份_' + this.data.today + '.json',
      success: () => {
        wx.showToast({ title: '已发出，建议存到文件传输助手', icon: 'none' });
      },
      fail: (err) => {
        // 用户取消转发不算错误
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') === -1) {
          wx.showToast({ title: '转发未完成，可重试', icon: 'none' });
        }
      },
    });
  },

  /** 导入恢复：从微信聊天选择备份文件 → 预览确认 → 覆盖写入 */
  onImportBackup() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: (r) => {
            const ret = parseBackup(r.data);
            if (!ret.ok) {
              wx.showModal({ title: '无法导入', content: ret.error, showCancel: false });
              return;
            }
            const s = ret.summary;
            wx.showModal({
              title: '确认恢复？',
              content:
                '备份日期 ' + s.exportedAt +
                '，含 ' + s.records + ' 条发薪记录。恢复将覆盖当前全部数据。系统日历事项不会恢复，之后需要重新添加提醒；若本机已有提醒，请先核对，避免重复。',
              confirmText: '恢复',
              success: (m) => {
                if (!m.confirm) return;
                try {
                  applyBackup(ret.data);
                } catch (err) {
                  wx.showModal({ title: '恢复未完成', content: err.message || '数据写入失败，请重试', showCancel: false });
                  return;
                }
                wx.showToast({ title: '已恢复', icon: 'success' });
                setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 700);
              },
            });
          },
          fail: () => {
            wx.showToast({ title: '文件读取失败', icon: 'none' });
          },
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') === -1) {
          wx.showToast({ title: '请从微信聊天记录中选择备份文件', icon: 'none' });
        }
      },
    });
  },

  onSave() {
    if (!this.data.startDate) {
      wx.showToast({ title: '请先选择开始工作日期', icon: 'none' });
      return;
    }
    if (this.data.anchorOverride && this.data.anchorOverride < this.data.startDate) {
      wx.showToast({ title: '结算起点不能早于开始工作日期', icon: 'none' });
      return;
    }
    if (this.data.restWeekdays.length === 7) {
      wx.showToast({ title: '请至少保留一个每周工作日', icon: 'none' });
      return;
    }
    try {
      saveConfig({
        startDate: this.data.startDate,
        cycleDays: this.data.cycleDays,
        restWeekdays: this.data.restWeekdays.slice().sort(),
        followHoliday: this.data.followHoliday,
        anchorOverride: this.data.anchorOverride,
      });
    } catch (err) {
      wx.showToast({ title: err.message || '设置保存失败，请重试', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
  },
});
