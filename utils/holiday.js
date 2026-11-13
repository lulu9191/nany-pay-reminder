/**
 * 节假日数据模块
 *
 * 三级数据来源（优先级从高到低）：
 *   1. 本地缓存（网络拉取过且未过期，7 天 TTL）
 *   2. 内置节假日表 utils/holiday-data.js —— 离线可用，来源为国务院公告，权威且零延迟
 *   3. 网络拉取 timor.tech —— 仅用于内置表未覆盖的年份（如次年安排刚公布时）
 *
 * ⚠️ 历史教训（2026-10-29）：timor.tech 开启了 Cloudflare 人机校验，小程序端请求
 *    会直接返回拦截页而非 JSON，导致首页每次都弹「节假日数据获取失败」。因此内置表
 *    改为默认数据源，网络仅作补充，应用在完全无网时也能算出正确的发薪日。
 * ⚠️ 每年 11 月左右国务院公布次年安排，需更新 holiday-data.js 并重新发版。
 */

const { HOLIDAY_DATA } = require('./holiday-data');

const API_BASE = 'https://timor.tech';
const CACHE_KEY_PREFIX = 'holiday_data_';
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 缓存 7 天后自动刷新
const FETCH_TIMEOUT = 5000;

/** 日期格式化为 YYYY-MM-DD（本地时区） */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 解析 YYYY-MM-DD 为 Date（本地时区，避免时区偏移问题） */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 今天的 YYYY-MM-DD */
function todayStr() {
  return formatDate(new Date());
}

/**
 * 取某年的内置节假日数据
 * @returns {Object|null} { "YYYY-MM-DD": {holiday: true|false} }，该年无内置数据返回 null
 */
function builtinYearMap(year) {
  const raw = HOLIDAY_DATA[year];
  if (!raw) return null;
  const days = {};
  Object.keys(raw).forEach((md) => {
    // 1 = 法定节假日放假，0 = 调休补班（算工作日）
    days[`${year}-${md}`] = { holiday: raw[md] === 1 };
  });
  return days;
}

/**
 * 同步取内置数据（首屏立即出结果，不发任何请求）
 * @returns {Object|null} 区间内至少有一年内置数据时返回合并 map，否则 null
 */
function getBuiltinMap(startYear, endYear) {
  const merged = {};
  let has = false;
  for (let year = startYear; year <= endYear; year++) {
    const map = builtinYearMap(year);
    if (map) {
      Object.assign(merged, map);
      has = true;
    }
  }
  return has ? merged : null;
}

/**
 * 联网拉取某一年节假日数据
 * @returns {Promise<Object|null>} 失败（含被 Cloudflare 拦截）返回 null
 */
function fetchHolidayData(year) {
  return new Promise((resolve) => {
    wx.request({
      url: `${API_BASE}/api/holiday/year/${year}`,
      method: 'GET',
      timeout: FETCH_TIMEOUT,
      success(res) {
        const body = res.data;
        if (!body || body.code !== 0 || !body.holiday) {
          resolve(null);
          return;
        }
        // API 的 key 是 "MM-DD"，转成完整 "YYYY-MM-DD" 便于查找
        const days = {};
        Object.keys(body.holiday).forEach((mdKey) => {
          const item = body.holiday[mdKey];
          days[`${year}-${mdKey}`] = {
            holiday: item.holiday === true, // true=放假，false=调休补班
            name: item.name || '',
          };
        });
        resolve(days);
      },
      fail() {
        resolve(null);
      },
    });
  });
}

/**
 * 获取年份区间 [startYear, endYear] 的节假日数据
 * @returns {Promise<{days: Object, missingYears: number[]}>}
 *   days: 合并后的 map；missingYears: 内置表和网络都没拿到、只能按普通周历估算的年份
 */
async function getHolidayMap(startYear, endYear) {
  const merged = {};
  const covered = {};
  const fetchYears = [];

  for (let year = startYear; year <= endYear; year++) {
    let cached = null;
    try {
      cached = wx.getStorageSync(CACHE_KEY_PREFIX + year) || null;
    } catch (e) {
      cached = null;
    }

    // 1. 新鲜缓存
    if (cached && cached.days && Date.now() - cached.fetchedAt < CACHE_TTL) {
      Object.assign(merged, cached.days);
      covered[year] = true;
      continue;
    }

    // 2. 内置表（离线可用，优先级高于网络）
    const builtin = builtinYearMap(year);
    if (builtin) {
      Object.assign(merged, builtin);
      covered[year] = true;
      continue;
    }

    // 3. 有旧缓存先用着，同时尝试联网刷新
    if (cached && cached.days) {
      Object.assign(merged, cached.days);
      covered[year] = true;
    }
    fetchYears.push(year);
  }

  // 只为内置表覆盖不到的年份联网，且并发请求，避免串行等待拖慢首屏
  if (fetchYears.length) {
    const results = await Promise.all(fetchYears.map((year) => fetchHolidayData(year)));
    fetchYears.forEach((year, index) => {
      const days = results[index];
      if (days) {
        Object.assign(merged, days);
        covered[year] = true;
        try {
          wx.setStorageSync(CACHE_KEY_PREFIX + year, { days, fetchedAt: Date.now() });
        } catch (e) {
          // 存储失败不影响本次计算
        }
      }
    });
  }

  const missingYears = [];
  for (let year = startYear; year <= endYear; year++) {
    if (!covered[year]) missingYears.push(year);
  }

  return { days: merged, missingYears };
}

module.exports = {
  formatDate,
  parseDate,
  todayStr,
  getHolidayMap,
  getBuiltinMap,
};
