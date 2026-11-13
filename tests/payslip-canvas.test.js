const test = require('node:test');
const assert = require('node:assert/strict');
const { createPosterPages, drawPoster } = require('../utils/payslip-canvas');

function month(year, number, first, last, extraWork) {
  const prefix = `${year}-${String(number).padStart(2, '0')}`;
  const offset = (new Date(year, number - 1, 1).getDay() + 6) % 7;
  const count = new Date(year, number, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push({ key: `empty-${i}`, day: '', state: 'empty' });
  for (let day = 1; day <= count; day++) {
    const date = `${prefix}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(year, number - 1, day).getDay();
    let state = 'outside';
    if (date >= first && date <= last) state = weekday !== 0 && weekday !== 6 || date === extraWork ? 'work' : 'rest';
    cells.push({ key: date, day, state });
  }
  while (cells.length % 7) cells.push({ key: `empty-${cells.length}`, day: '', state: 'empty' });
  return { key: prefix, title: `${year} 年 ${number} 月`, cells, rows: cells.length / 7 };
}

function example(changes = {}) {
  return Object.assign({
    brand: '小新发薪', greeting: '王阿姨，辛苦了', appreciation: '感谢您这段时间的用心照顾。',
    cycle: 12, amountText: '8,800.00', cycleRange: '2026.10.16—2026.11.13', actualDateText: '2026.11.13',
    workdays: 22, restDays: 7,
    months: [10, 11].map((number) => month(2026, number, '2026-10-16', '2026-11-13', '2026-11-07')),
    adjustments: ['11 月 7 日临时上班'], note: '本期含补贴 300 元。', notice: '',
  }, changes);
}

function allText(pages) {
  return pages.flatMap((page) => page.commands.filter((command) => command.type === 'text').map((command) => command.text));
}

test('两个月真实日历绘制 22 个红色工作日、7 个灰色休息日，周一开头且全部日期保留', () => {
  const pages = createPosterPages(example());
  assert.equal(pages.length, 1);
  const commands = pages[0].commands;
  assert.equal(commands.filter((command) => command.type === 'circle' && command.radius === 21 && command.color === '#d95e50').length, 22);
  assert.equal(commands.filter((command) => command.type === 'circle' && command.radius === 21 && command.color === '#e8e1d8').length, 7);
  const dateLabels = commands.filter((command) => command.type === 'text' && command.size === 24);
  assert.equal(dateLabels.length, 61);
  const firstMonth = dateLabels.slice(0, 31);
  assert.deepEqual(firstMonth.map((command) => Number(command.text)), Array.from({ length: 31 }, (_, i) => i + 1));
  assert.equal(firstMonth[0].x, 375); // 10 月 1 日周四
  assert.equal(firstMonth[15].x, 469); // 10 月 16 日周五
  assert.equal(dateLabels[31].x, 657); // 11 月 1 日周日
  assert.ok(allText(pages).includes('小新发薪'));
  assert.ok(!allText(pages).includes('本期发薪明细'));
  assert.ok(!allText(pages).includes('示例数据'));
});

test('跨多月每张最多两个完整月份，月份和日期不会在分页中丢失', () => {
  const months = Array.from({ length: 9 }, (_, i) => month(2026, i + 1, '2026-01-01', '2026-09-30'));
  const pages = createPosterPages(example({ months, adjustments: [], note: '' }));
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.flatMap((page) => page.monthKeys), months.map((item) => item.key));
  assert.ok(pages.every((page) => page.monthKeys.length <= 2 && page.height <= 1800));
  assert.equal(allText(pages).filter((value) => /^第 \d+ \/ 5 张$/.test(value)).length, 5);
  assert.equal(pages.flatMap((page) => page.commands).filter((command) => command.type === 'text' && command.size === 24).length, 273);
});

test('长称呼、超长说明与大量临时安排自动换行续页，内容不截断', () => {
  const greeting = '称呼'.repeat(20) + '，辛苦了';
  const note = '本期说明'.repeat(125);
  const adjustments = Array.from({ length: 80 }, (_, i) => `临时安排${String(i).padStart(3, '0')}：按双方约定调整工作时间。`);
  const pages = createPosterPages(example({ greeting, note, adjustments, notice: '2027 年放假安排未获取到，日期按普通周历估算。' }));
  assert.ok(pages.length > 2);
  assert.ok(pages.every((page) => page.height <= 1800));
  const noteText = pages.flatMap((page) => page.commands)
    .filter((command) => command.type === 'text' && command.size === 20 && command.x === 49)
    .map((command) => command.text).join('');
  assert.equal(noteText, note);
  const texts = allText(pages);
  adjustments.forEach((value) => assert.ok(texts.includes(value)));
  const greetingText = pages[0].commands.filter((command) => command.type === 'text' && command.size === 37).map((command) => command.text).join('');
  assert.equal(greetingText, greeting);
  assert.ok(texts.join('').includes('2027 年放假安排未获取到，日期按普通周历估算。'));
});

test('按实际字体测量长金额并缩小，金额不会超过右侧边界', () => {
  const context = {
    font: 'initial',
    measureText(value) {
      const size = Number(this.font.match(/(\d+)px/)[1]);
      return { width: String(value).length * size * 0.64 };
    },
  };
  const pages = createPosterPages(example({ amountText: '9,007,199,254,740,991.00' }), context);
  assert.equal(context.font, 'initial');
  const amounts = pages[0].commands.filter((command) => command.type === 'text' && command.family.startsWith('Georgia'));
  assert.equal(amounts.map((command) => command.text).join(''), '¥9,007,199,254,740,991.00');
  amounts.forEach((command) => {
    assert.ok(command.x + command.text.length * command.size * 0.64 <= 704.01);
  });
});

test('161 字说明在页尾完整计入段后留白，所有导出图片均不超过 1800 像素', () => {
  // 该输入曾把最后一行后的 5 + 14 像素排除在空间检查外，产生 1812 像素的图片。
  const note = '字'.repeat(161);
  const pages = createPosterPages(example({ note }));
  assert.equal(pages.length, 2);
  assert.ok(pages.every((page) => page.height <= 1800));
  const noteText = pages.flatMap((page) => page.commands)
    .filter((command) => command.type === 'text' && command.size === 20 && command.x === 49)
    .map((command) => command.text).join('');
  assert.equal(noteText, note);
});

test('40 字符称呼中的大量换行会归一，发薪说明的换行仍保留', () => {
  const recipient = '王' + '\n'.repeat(39);
  const model = example({ greeting: recipient + '，辛苦了', note: '第一行\n第二行' });
  const pages = createPosterPages(model);
  assert.ok(pages.every((page) => page.height <= 1800));
  assert.equal(pages.length, 1);
  const greetings = pages[0].commands.filter((command) => command.type === 'text' && command.size === 37);
  assert.deepEqual(greetings.map((command) => command.text), ['王 ，辛苦了']);
  const notes = pages.flatMap((page) => page.commands)
    .filter((command) => command.type === 'text' && command.size === 20 && command.x === 49);
  assert.deepEqual(notes.map((command) => command.text), ['第一行', '第二行']);
  assert.equal(notes[1].y - notes[0].y, 31);
  assert.equal(model.greeting, recipient + '，辛苦了'); // 不改原始记录
});

test('估算提示出现在每张图片顶部，完整日期说明仍保留在正文', () => {
  const months = Array.from({ length: 5 }, (_, i) => month(2027, i + 1, '2027-01-01', '2027-05-31'));
  const notice = '2027 年放假安排未获取到，日期按普通周历估算。';
  const pages = createPosterPages(example({ months, note: '说明'.repeat(250), notice }));
  assert.ok(pages.length >= 3);
  pages.forEach((page) => {
    const flags = page.commands.filter((command) => command.type === 'text' && command.text === '日期为估算');
    assert.equal(flags.length, 1);
    assert.equal(flags[0].x, 375);
    assert.equal(flags[0].y, 30);
    assert.equal(flags[0].align, 'center');
  });
  assert.ok(allText(pages).join('').includes(notice));
  assert.ok(!allText(createPosterPages(example())).includes('日期为估算'));
});

test('绘制只使用标准 Canvas 2D，输出画布尺寸完整且维持调用者状态', () => {
  const calls = [];
  const ctx = {};
  ['save', 'restore', 'fillRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'fill', 'stroke'].forEach((method) => {
    ctx[method] = (...args) => calls.push({ method, args });
  });
  const model = example();
  const page = createPosterPages(model)[0];
  drawPoster(ctx, model, page);
  assert.deepEqual(calls[0], { method: 'save', args: [] });
  assert.deepEqual(calls[1], { method: 'fillRect', args: [0, 0, 750, page.height] });
  assert.equal(calls.at(-1).method, 'restore');
  assert.equal(calls.filter((call) => call.method === 'fillText').length, page.commands.filter((command) => command.type === 'text').length);
});

test('拒绝缺失或不完整月份，避免生成误导性的半张日历', () => {
  assert.throws(() => createPosterPages(example({ months: [] })), /缺少本期日历/);
  assert.throws(() => createPosterPages(example({ months: [{ cells: new Array(29).fill({ day: 1 }) }] })), /月份数据不完整/);
});
