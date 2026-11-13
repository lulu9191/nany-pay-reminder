/** 发薪单使用已保存的日期快照，不读取当前上班规则。 */
const MAX_DAYS = 800;
const DAY_MS = 86400000;

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || year > 9999) return NaN;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return date.getTime();
}

function dateString(value) {
  const date = new Date(value);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('发薪单日期快照格式无效');
  }
  const start = dateValue(value.cycleStart);
  const end = dateValue(value.settlementDate);
  const length = (end - start) / DAY_MS + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || length < 1 || length > MAX_DAYS || !Number.isInteger(length)) {
    throw new Error('发薪单区间无效');
  }
  if (!Array.isArray(value.days) || value.days.length !== length) throw new Error('发薪单日期明细不完整');
  let workdays = 0;
  const days = value.days.map((day, index) => {
    if (!day || typeof day !== 'object' || Array.isArray(day) ||
        day.date !== dateString(start + index * DAY_MS) || typeof day.work !== 'boolean' ||
        typeof day.label !== 'string' || !day.label.trim() || day.label.length > 80) {
      throw new Error('发薪单日期明细无效或顺序不连续');
    }
    if (day.work) workdays++;
    return { date: day.date, work: day.work, label: day.label };
  });
  if (workdays < 1 || workdays > 60 || !days[days.length - 1].work) throw new Error('发薪单工作日数量或结算日无效');
  const missingYears = value.missingYears === undefined ? [] : value.missingYears;
  const lastYear = Number(value.settlementDate.slice(0, 4));
  if (!Array.isArray(missingYears) || missingYears.some((year) => !Number.isInteger(year) || year < 1 || year > lastYear) ||
      new Set(missingYears).size !== missingYears.length) throw new Error('发薪单节假日覆盖信息无效');
  return { version: 1, cycleStart: value.cycleStart, settlementDate: value.settlementDate, days, missingYears: missingYears.slice().sort() };
}

function createSnapshot(detail, missingYears = []) {
  if (!detail || !Array.isArray(missingYears)) throw new Error('暂时无法生成本期日期明细，请重新核对日期');
  const lastYear = Number(detail.settlementDate.slice(0, 4));
  return normalizeSnapshot({
    version: 1, cycleStart: detail.cycleStart, settlementDate: detail.settlementDate,
    days: detail.days,
    // 早于本期的未知节假日也可能影响累计期号与区间，仅排除未来预览年份。
    missingYears: Array.from(new Set(missingYears.filter((year) => Number.isInteger(year) && year >= 1 && year <= lastYear))),
  });
}

function buildMonths(snapshot) {
  const states = {};
  snapshot.days.forEach((day) => { states[day.date] = day.work ? 'work' : 'rest'; });
  const months = [];
  let year = Number(snapshot.cycleStart.slice(0, 4));
  let month = Number(snapshot.cycleStart.slice(5, 7));
  const lastMonth = snapshot.settlementDate.slice(0, 7);
  while (true) {
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    const first = dateValue(key + '-01');
    const offset = (new Date(first).getUTCDay() + 6) % 7;
    const cells = Array.from({ length: offset }, (_, index) => ({ key: key + '-blank-' + index, day: '', state: 'empty' }));
    let time = first;
    while (new Date(time).getUTCMonth() === month - 1 && new Date(time).getUTCFullYear() === year) {
      const date = dateString(time);
      cells.push({ key: date, day: new Date(time).getUTCDate(), state: states[date] || 'outside' });
      time += DAY_MS;
    }
    while (cells.length % 7) cells.push({ key: key + '-blank-' + cells.length, day: '', state: 'empty' });
    months.push({ key, title: `${year} 年 ${month} 月`, rows: cells.length / 7, cells });
    if (key === lastMonth) break;
    month++;
    if (month > 12) { year++; month = 1; }
  }
  return months;
}

function buildSlipView(record) {
  if (!record || record.amount === null || record.amount === undefined) throw new Error('请先补充实发金额，再生成发薪单');
  if (typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.amount < 0 || record.amount > Number.MAX_SAFE_INTEGER) {
    throw new Error('实发金额无效');
  }
  if (!Number.isSafeInteger(record.cycle) || record.cycle < 1 || !Number.isFinite(dateValue(record.actualDate))) throw new Error('发薪记录无效');
  if (!record.periodSnapshot) throw new Error('这笔记录还没有保存日期明细，请先核对本期日历');
  const snapshot = normalizeSnapshot(record.periodSnapshot);
  const workdays = snapshot.days.filter((day) => day.work).length;
  const recipientName = (record.recipientName || '').trim();
  return {
    brand: '小新发薪', greeting: recipientName ? `${recipientName}，辛苦了` : '辛苦了',
    appreciation: '感谢您这段时间的用心照顾。', cycle: record.cycle,
    amountText: record.amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    cycleRange: snapshot.cycleStart.replace(/-/g, '.') + '—' + snapshot.settlementDate.replace(/-/g, '.'),
    actualDateText: record.actualDate.replace(/-/g, '.'), workdays, restDays: snapshot.days.length - workdays,
    months: buildMonths(snapshot),
    adjustments: snapshot.days.filter((day) => day.label !== '正常计入' && day.label !== '每周休息日').map((day) => {
      const parts = day.date.split('-');
      return `${parts[0]} 年 ${Number(parts[1])} 月 ${Number(parts[2])} 日 ${day.label}`;
    }),
    note: record.shareNote || '',
    notice: snapshot.missingYears.length ? `${snapshot.missingYears.join('、')} 年节假日安排未获取到，本期区间或工作日可能按普通周历估算，请双方核对。` : '',
  };
}

module.exports = { createSnapshot, normalizeSnapshot, buildSlipView };
