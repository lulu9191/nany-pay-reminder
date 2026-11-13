/**
 * 发薪单的确定性排版和 Canvas 2D 绘制。
 * 不依赖 wx 或 DOM；所有尺寸都是逻辑像素，调用者负责设置像素比。
 */
const WIDTH = 750;
const MARGIN = 46;
const INNER = WIDTH - MARGIN * 2;
const MAX_HEIGHT = 1800;
const FOOTER_SPACE = 114;
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
const MONEY_FONT = 'Georgia, "Times New Roman", serif';
const COLORS = {
  paper: '#fffaf3', ink: '#503321', muted: '#8c7a6b', line: '#e3cbbb',
  work: '#d95e50', rest: '#e8e1d8', restText: '#796f64', outside: '#b5aea5',
  white: '#ffffff', status: '#e8e8cc', statusText: '#59673b',
};
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function fontString(size, weight = 400, family = FONT) {
  return `${weight} ${size}px ${family}`;
}

function measure(text, size, weight, context, family = FONT) {
  if (context && typeof context.measureText === 'function') {
    const previous = context.font;
    try {
      context.font = fontString(size, weight, family);
      const width = context.measureText(String(text)).width;
      if (Number.isFinite(width)) return width;
    } finally {
      context.font = previous;
    }
  }
  // 无画布时保守估计，生成的布局仍可用于测试或首次确定画布尺寸。
  return Array.from(String(text)).reduce((width, char) => {
    const factor = /[\u0020-\u007e]/.test(char) ? (char === ' ' ? 0.34 : 0.64) : 1;
    return width + size * factor;
  }, 0);
}

function wrapText(text, width, size, weight, context) {
  const lines = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((paragraph) => {
    let line = '';
    Array.from(paragraph).forEach((char) => {
      if (line && measure(line + char, size, weight, context) > width) {
        lines.push(line);
        line = char;
      } else {
        line += char;
      }
    });
    lines.push(line);
  });
  return lines;
}

function text(page, value, x, y, size, options = {}) {
  page.commands.push(Object.assign({
    type: 'text', text: String(value), x, y, size,
    weight: 400, color: COLORS.ink, align: 'left', baseline: 'top', family: FONT,
  }, options));
}

function line(page, x1, y1, x2, y2) {
  page.commands.push({ type: 'line', x1, y1, x2, y2, color: COLORS.line, width: 1 });
}

function circle(page, x, y, radius, color) {
  page.commands.push({ type: 'circle', x, y, radius, color });
}

function pill(page, x, y, width, height, color) {
  page.commands.push({ type: 'pill', x, y, width, height, color });
}

function addWrapped(page, value, x, y, width, size, leading, context, options = {}) {
  const lines = wrapText(value, width, size, options.weight || 400, context);
  lines.forEach((value, index) => text(page, value, x, y + index * leading, size, options));
  return y + lines.length * leading;
}

function addCalendarHeading(page, model, y) {
  text(page, '本期工作日历', MARGIN, y, 27, { weight: 500 });
  text(page, `工作 ${model.workdays} 天 · 休息 ${model.restDays} 天`, WIDTH - MARGIN, y + 2, 22, { align: 'right' });
  const legendY = y + 58;
  const centers = [MARGIN + 95, MARGIN + 290, MARGIN + 485];
  circle(page, centers[0], legendY, 10, COLORS.work);
  circle(page, centers[1], legendY, 10, COLORS.rest);
  text(page, '28', centers[2], legendY, 20, { color: COLORS.outside, align: 'center', baseline: 'middle' });
  ['工作日', '休息日', '周期外'].forEach((label, index) => {
    text(page, label, centers[index] + 25, legendY, 20, { baseline: 'middle' });
  });
  return legendY + 43;
}

function addHeader(page, model, first, context) {
  page.commands.push({ type: 'rect', x: MARGIN, y: 27, width: 4, height: 23, color: COLORS.work });
  text(page, model.brand || '小新发薪', MARGIN + 17, 25, 25, { weight: 500 });
  if (model.notice && String(model.notice).trim()) {
    text(page, '日期为估算', WIDTH / 2, 30, 18, { align: 'center', color: COLORS.muted });
  }
  if (!first) {
    text(page, `第 ${model.cycle} 期 · ${model.cycleRange}`, MARGIN, 84, 21);
    line(page, MARGIN, 125, WIDTH - MARGIN, 125);
    return 153;
  }
  // 称呼来自可导入的数据；换行属于误输入，不能将一个名字扩成几十行。
  // 仅归一问候语，下面的发薪说明仍保留用户填写的换行。
  const greeting = String(model.greeting || '辛苦了').replace(/\s+/g, ' ').trim() || '辛苦了';
  let y = addWrapped(page, greeting, MARGIN, 87, INNER, 37, 48, context, { weight: 500 });
  y = addWrapped(page, model.appreciation || '感谢您这段时间的用心照顾。', MARGIN, y + 7, INNER, 21, 31, context);
  y += 19;
  text(page, `第 ${model.cycle} 期`, MARGIN, y + 5, 23);
  pill(page, WIDTH - MARGIN - 151, y - 2, 151, 36, COLORS.status);
  text(page, '已记录发放', WIDTH - MARGIN - 75.5, y + 16, 20, {
    color: COLORS.statusText, align: 'center', baseline: 'middle',
  });
  y += 70;
  const amountParts = String(model.amountText).split('.');
  const integer = amountParts[0];
  const decimals = '.' + (amountParts[1] || '00');
  const amountX = MARGIN + 202;
  const available = WIDTH - MARGIN - amountX;
  let mainSize = 80;
  let currencySize;
  let decimalSize;
  let currencyWidth;
  let integerWidth;
  while (true) {
    currencySize = Math.round(mainSize * 0.68);
    decimalSize = Math.round(mainSize * 0.63);
    currencyWidth = measure('¥', currencySize, 400, context, MONEY_FONT) + 4;
    integerWidth = measure(integer, mainSize, 400, context, MONEY_FONT);
    const total = currencyWidth + integerWidth + measure(decimals, decimalSize, 400, context, MONEY_FONT);
    if (total <= available || mainSize <= 20) break;
    mainSize -= 2;
  }
  text(page, '实发金额', MARGIN + 7, y + 29, 27, { weight: 500 });
  line(page, MARGIN + 175, y + 16, MARGIN + 175, y + 78);
  const baseline = y + 77;
  text(page, '¥', amountX, baseline, currencySize, { baseline: 'alphabetic', family: MONEY_FONT });
  text(page, integer, amountX + currencyWidth, baseline, mainSize, { baseline: 'alphabetic', family: MONEY_FONT });
  text(page, decimals, amountX + currencyWidth + integerWidth, baseline, decimalSize, { baseline: 'alphabetic', family: MONEY_FONT });
  y += 108;
  text(page, '本期区间', MARGIN + 7, y, 22);
  const rangeEnd = addWrapped(page, model.cycleRange, MARGIN + 177, y, INNER - 177, 22, 31, context);
  y = rangeEnd + 8;
  text(page, '发薪日期', MARGIN + 7, y, 22);
  y = addWrapped(page, model.actualDateText, MARGIN + 177, y, INNER - 177, 22, 31, context) + 21;
  line(page, MARGIN, y, WIDTH - MARGIN, y);
  return y + 28;
}

function monthRows(month) {
  return Math.max(1, Math.ceil(month.cells.length / 7));
}

function monthHeight(month) {
  return 92 + monthRows(month) * 47 + 32;
}

function addMonth(page, month, y, context) {
  const title = String(month.title);
  text(page, title, MARGIN + 7, y, 26, { weight: 500 });
  const titleWidth = measure(title, 26, 500, context);
  const dividerStart = MARGIN + titleWidth + 32;
  if (dividerStart < WIDTH - MARGIN - 20) line(page, dividerStart, y + 15, WIDTH - MARGIN, y + 15);
  const cellWidth = INNER / 7;
  WEEKDAYS.forEach((day, column) => text(page, day, MARGIN + cellWidth * (column + 0.5), y + 57, 22, {
    align: 'center', baseline: 'middle',
  }));
  month.cells.forEach((cell, index) => {
    if (cell.state === 'empty' || cell.day === '' || cell.day === null || cell.day === undefined) return;
    const x = MARGIN + cellWidth * (index % 7 + 0.5);
    const centerY = y + 106 + Math.floor(index / 7) * 47;
    let color = COLORS.outside;
    if (cell.state === 'work') {
      circle(page, x, centerY, 21, COLORS.work);
      color = COLORS.white;
    } else if (cell.state === 'rest') {
      circle(page, x, centerY, 21, COLORS.rest);
      color = COLORS.restText;
    }
    text(page, cell.day, x, centerY + 1, 24, { align: 'center', baseline: 'middle', color });
  });
  page.monthKeys.push(month.key);
  return y + monthHeight(month);
}

function finishPage(page, y) {
  const dividerY = y + 20;
  line(page, MARGIN, dividerY, WIDTH - MARGIN, dividerY);
  text(page, '由发薪方填写，请核对实际到账。', MARGIN + 3, dividerY + 22, 18, { color: COLORS.muted });
  text(page, '红色日期计入本期，金额按双方约定填写。', MARGIN + 3, dividerY + 49, 18, { color: COLORS.muted });
  page.height = Math.ceil(dividerY + 94);
}

/**
 * 每张最多两个完整月份，文字超长时自动续页且保留所有内容。
 * 推荐传入真实上下文 measureContext，以实际字体测量长称呼、金额和备注。
 */
function createPosterPages(model, measureContext) {
  if (!model || !Array.isArray(model.months) || !model.months.length) {
    throw new Error('缺少本期日历，暂时无法生成发薪单');
  }
  model.months.forEach((month) => {
    if (!Array.isArray(month.cells) || month.cells.length < 28 || month.cells.length > 42 || month.cells.length % 7 !== 0) {
      throw new Error('本期月份数据不完整，请重新核对');
    }
  });
  const pages = [];
  let page;
  let y;
  const startPage = (first, calendars) => {
    page = { width: WIDTH, height: 0, commands: [], monthKeys: [], index: pages.length, total: 0 };
    pages.push(page);
    y = addHeader(page, model, first, measureContext);
    if (calendars) y = addCalendarHeading(page, model, y);
  };
  startPage(true, true);
  model.months.forEach((month) => {
    if (page.monthKeys.length >= 2 || y + monthHeight(month) + FOOTER_SPACE > MAX_HEIGHT) {
      finishPage(page, y);
      startPage(false, true);
    }
    y = addMonth(page, month, y, measureContext);
  });
  const ensureTextSpace = (height) => {
    if (y + height + FOOTER_SPACE > MAX_HEIGHT) {
      finishPage(page, y);
      startPage(false, false);
    }
  };
  const addTextSection = (title, values, size = 20, color = COLORS.ink) => {
    const nonEmpty = values.filter((value) => value !== null && value !== undefined && String(value).length);
    if (!nonEmpty.length) return;
    // 标题、至少一行正文及末尾留白要一起放得下，避免页尾只有标题。
    ensureTextSpace((title ? 44 : 0) + 31 + 19);
    if (title) {
      y += 7;
      text(page, title, MARGIN + 3, y, 22, { weight: 500 });
      y += 37;
    }
    nonEmpty.forEach((value, valueIndex) => {
      const lines = wrapText(value, INNER - 6, size, 400, measureContext);
      lines.forEach((value, lineIndex) => {
        const previousPage = page;
        const lastLine = lineIndex === lines.length - 1;
        const finalValue = valueIndex === nonEmpty.length - 1;
        const trailingSpace = lastLine ? 5 + (finalValue ? 14 : 0) : 0;
        ensureTextSpace(31 + trailingSpace);
        if (page !== previousPage && title) {
          text(page, title + '（续）', MARGIN + 3, y, 22, { weight: 500 });
          y += 37;
        }
        text(page, value, MARGIN + 3, y, size, { color });
        y += 31;
      });
      y += 5;
    });
    y += 14;
  };
  addTextSection('临时安排', Array.isArray(model.adjustments) ? model.adjustments : [], 19, COLORS.muted);
  addTextSection('发薪说明', [model.note]);
  addTextSection('日期说明', [model.notice], 19, COLORS.muted);
  finishPage(page, y);
  pages.forEach((item, index) => {
    item.index = index;
    item.total = pages.length;
    if (pages.length > 1) text(item, `第 ${index + 1} / ${pages.length} 张`, WIDTH - MARGIN, 28, 19, {
      align: 'right', color: COLORS.muted,
    });
  });
  return pages;
}

function drawPill(ctx, command) {
  const { x, y, width, height } = command;
  const r = height / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arc(x + width - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + height);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
  ctx.fill();
}

/** 画布尺寸和比例由调用者设置；这里不修改 ctx.canvas，也不访问平台 API。 */
function drawPoster(ctx, model, pageSpec) {
  if (!ctx || !pageSpec || !Array.isArray(pageSpec.commands)) throw new Error('发薪单画布尚未准备好');
  ctx.save();
  try {
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, pageSpec.width, pageSpec.height);
    pageSpec.commands.forEach((command) => {
      ctx.fillStyle = command.color;
      if (command.type === 'text') {
        ctx.font = fontString(command.size, command.weight, command.family);
        ctx.textAlign = command.align;
        ctx.textBaseline = command.baseline;
        ctx.fillText(command.text, command.x, command.y);
      } else if (command.type === 'line') {
        ctx.strokeStyle = command.color;
        ctx.lineWidth = command.width;
        ctx.beginPath();
        ctx.moveTo(command.x1, command.y1);
        ctx.lineTo(command.x2, command.y2);
        ctx.stroke();
      } else if (command.type === 'circle') {
        ctx.beginPath();
        ctx.arc(command.x, command.y, command.radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (command.type === 'rect') {
        ctx.fillRect(command.x, command.y, command.width, command.height);
      } else if (command.type === 'pill') {
        drawPill(ctx, command);
      }
    });
  } finally {
    ctx.restore();
  }
}

module.exports = { createPosterPages, drawPoster };
