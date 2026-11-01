"use strict";

/**
 * 纯 JavaScript 单测：不经过 esbuild / tsc，直接 require 交给 Obsidian 的 main.js。
 *
 * main.js 顶层会 `require("obsidian")`，这个包只有在 Obsidian / Electron 里才有意义，
 * 所以测试启动时劫持 CommonJS 模块解析（Module._resolveFilename），把 "obsidian"
 * 重定向到 tests/stubs/obsidian.js。
 *
 * `@codemirror/state` 与 `@codemirror/view` 都用真实安装包（Node v24 下两者都能直接
 * require，不需要 DOM）——这样就是真实的 CM6 数据结构和扩展，而不是假对象。
 *
 * main.js 保证导出 `module.exports.__test = { DEFAULT_SETTINGS, blockAtClientY,
 * blockEnd, rangeForLine, rangeForDrag, rangeForShift, toggleLineRange, addRange,
 * sameBlock }`，这里只测这些纯函数，不触碰 DOM / Obsidian 生命周期。
 * 插件生命周期的冒烟测试在 tests/plugin-onload.test.js。
 */

const path = require("node:path");
const Module = require("node:module");

const OBSIDIAN_STUB = path.join(__dirname, "stubs", "obsidian.js");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (request === "obsidian") return OBSIDIAN_STUB;
  return originalResolveFilename.call(this, request, ...rest);
};

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EditorState, EditorSelection, RangeSet } = require("@codemirror/state");
const { gutterLineClass } = require("@codemirror/view");

/** 被测插件模块：CommonJS require 即加载，但不会触发 Obsidian 的 onload。 */
const pluginModule = require("../main.js");
const testApi = (pluginModule && pluginModule.__test) || {};
const {
  DEFAULT_SETTINGS,
  blockAtClientY,
  blockEnd,
  selectionEnd,
  rangeForLine,
  rangeForDrag,
  rangeForShift,
  toggleLineRange,
  addRange,
  sameBlock,
  rowSpan,
  gutterLineStarts,
  extendRowSpan,
  extendedDeleteEnd,
} = testApi;

/** "aaa\nbbb\nccc\nddd" -> 每行 3 字符；positions: L1 0-3, L2 4-7, L3 8-11, L4 12-15 */
const state = EditorState.create({ doc: "aaa\nbbb\nccc\nddd" });

/** 取第 n 行的行块（与 CM6 BlockInfo 解耦后的 { from, to }）。 */
const L = (n) => {
  const line = state.doc.line(n);
  return { from: line.from, to: line.to };
};

const yes = { includeEOL: true };
const no = { includeEOL: false };
const pair = (range) => [range.anchor, range.head];
const spans = (selection) => selection.ranges.map((r) => [r.from, r.to]);

test("main.js 导出契约：两种 Obsidian 导出约定 + __test 纯函数面", () => {
  // Obsidian 直接 require 插件模块时拿到的就是构造函数。
  assert.equal(
    typeof pluginModule,
    "function",
    "module.exports 本身必须是插件构造函数（Obsidian 直接加载约定）"
  );
  // 打包器风格的 default 导出也保留，两种加载方式都能工作。
  assert.equal(
    typeof pluginModule.default,
    "function",
    "module.exports.default 必须是插件构造函数（打包器风格 .default 约定）"
  );
  assert.equal(
    pluginModule.default,
    pluginModule,
    "module.exports.default 必须与 module.exports 是同一个构造函数"
  );

  assert.equal(
    typeof pluginModule.__test,
    "object",
    "main.js 必须导出 __test 对象（纯函数测试接口）"
  );
  for (const name of [
    "blockAtClientY",
    "blockEnd",
    "selectionEnd",
    "rangeForLine",
    "rangeForDrag",
    "rangeForShift",
    "toggleLineRange",
    "addRange",
    "sameBlock",
    "rowSpan",
    "gutterLineStarts",
    "extendRowSpan",
    "extendedDeleteEnd",
  ]) {
    assert.equal(
      typeof testApi[name],
      "function",
      `main.js 的 __test 必须导出函数 ${name}`
    );
  }
});

test("DEFAULT_SETTINGS：默认配置值", () => {
  assert.deepEqual(
    DEFAULT_SETTINGS,
    { gutterMode: "hook", includeEOL: false, autoScroll: true },
    "DEFAULT_SETTINGS 默认值应为 hook / includeEOL=false / autoScroll=true（拖动始终严格行尾）"
  );
});

test("blockEnd：行块末端是否吞掉行尾换行符", () => {
  assert.equal(blockEnd(state, L(2), yes), 8, "第2行含换行符末端应为 8");
  assert.equal(blockEnd(state, L(2), no), 7, "第2行不含换行符末端应为 7");
  assert.equal(
    blockEnd(state, L(4), yes),
    15,
    "末行末尾没有换行符可吞，末端仍应为 15"
  );
});

test("单击行号：选中整行", () => {
  assert.deepEqual(
    pair(rangeForLine(state, L(2), yes)),
    [4, 8],
    "单击第2行（含换行符）"
  );
  assert.deepEqual(
    pair(rangeForLine(state, L(2), no)),
    [4, 7],
    "单击第2行（不含换行符）"
  );
  assert.deepEqual(
    pair(rangeForLine(state, L(4), yes)),
    [12, 15],
    "单击末行（末尾无换行符可吞）"
  );
});

test("拖拽：终点严格落在末尾行行尾，与 includeEOL 无关", () => {
  assert.deepEqual(
    pair(rangeForDrag(state, L(2), L(4), yes)),
    [4, 15],
    "从第2行向下拖到末行第4行（末行没有换行可吞）"
  );
  assert.deepEqual(
    pair(rangeForDrag(state, L(4), L(2), yes)),
    [15, 4],
    "从末行向上拖到第2行"
  );
  assert.deepEqual(
    pair(rangeForDrag(state, L(2), L(3), yes)),
    [4, 11],
    "向下拖到第3行：终点是 11（第3行行末），不是 12（第4行行首）"
  );
  assert.deepEqual(
    pair(rangeForDrag(state, L(3), L(2), no)),
    [11, 4],
    "向上拖到第2行：从第3行行末到第2行行首"
  );
  assert.deepEqual(
    pair(rangeForDrag(state, L(2), L(2), yes)),
    [4, 7],
    "原地按下不移动（严格行尾，不吞换行）"
  );
});

test("Shift 扩展：锚点固定，目标行整行对齐", () => {
  assert.deepEqual(
    pair(rangeForShift(state, 4, L(4), yes)),
    [4, 15],
    "锚点在第2行首，Shift 点到第4行"
  );
  assert.deepEqual(
    pair(rangeForShift(state, 15, L(2), yes)),
    [15, 4],
    "锚点在文末，Shift 点到第2行"
  );
});

test("Ctrl/Cmd 追加与 toggle：多选区", () => {
  const empty = EditorSelection.single(0).ranges;
  const added = toggleLineRange(state, empty, L(3), yes);
  assert.deepEqual(spans(added), [[8, 12]], "追加第3行");

  const removed = toggleLineRange(state, added.ranges, L(3), yes);
  assert.deepEqual(
    spans(removed),
    [[8, 8]],
    "再次 toggle 第3行 -> 回到第3行行首的光标"
  );

  const multi = addRange(added.ranges, rangeForLine(state, L(1), yes));
  assert.deepEqual(
    spans(multi),
    [
      [0, 4],
      [8, 12],
    ],
    "多选区按文档顺序规范化"
  );
});

test("sameBlock：行块相等性判断（拖拽去重用）", () => {
  assert.equal(sameBlock({ from: 4, to: 7 }, { from: 4, to: 7 }), true, "相同行块应视为同一块");
  assert.equal(sameBlock(null, { from: 4, to: 7 }), false, "null 与行块不应视为同一块");
  assert.equal(sameBlock({ from: 4, to: 7 }, null), false, "行块与 null 不应视为同一块");
  assert.equal(sameBlock(null, null), true, "两者都为 null 应视为同一块");
});

/* ------------------------------------------------------------------ *
 * blockAtClientY：坐标 -> 行块的三档降级
 * ------------------------------------------------------------------ */

test("blockAtClientY 档1：优先用 lineBlockAtHeight，且高度 = clientY - documentTop", () => {
  let receivedHeight;
  const view = {
    documentTop: 100,
    lineBlockAtHeight(height) {
      receivedHeight = height;
      return { from: 4, to: 7, top: 0, bottom: 20 };
    },
  };

  const block = blockAtClientY(view, 130, false);

  assert.equal(receivedHeight, 30, "lineBlockAtHeight 应收到 clientY - documentTop = 30");
  assert.deepEqual(block, { from: 4, to: 7 }, "档1 应把 BlockInfo 收窄成 {from,to}");
});

test("blockAtClientY 档2：viewportLineBlocks 命中、首末行 clamp 与中间行", () => {
  const first = { from: 0, to: 3, top: 0, bottom: 20 };
  const second = { from: 4, to: 7, top: 20, bottom: 40 };
  const view = {
    documentTop: 0,
    viewportLineBlocks: [first, second],
    // 故意不提供 contentDOM / posAtCoords：档2 命中后不应继续落到档3
  };

  assert.equal(
    blockAtClientY(view, -5, false),
    null,
    "y 在第一行上方且 clamp=false 时应返回 null（不钳制）"
  );
  assert.deepEqual(
    blockAtClientY(view, -5, true),
    first,
    "y 在第一行上方且 clamp=true 时应钳到首行"
  );
  assert.deepEqual(blockAtClientY(view, 10, false), first, "y 落在第一行内应返回第一行");
  assert.deepEqual(blockAtClientY(view, 30, false), second, "y 落在第二行内应返回第二行");
  assert.equal(
    blockAtClientY(view, 60, false),
    null,
    "y 越过末行且 clamp=false 时应返回 null（不钳制）"
  );
  assert.deepEqual(
    blockAtClientY(view, 60, true),
    second,
    "y 越过末行且 clamp=true 时应钳到末行"
  );
});

test("blockAtClientY：lineBlockAtHeight 抛错/返回空时自动降级到档2", () => {
  const first = { from: 0, to: 3, top: 0, bottom: 20 };
  const throwingView = {
    documentTop: 0,
    lineBlockAtHeight() {
      throw new Error("cm6 api boom");
    },
    viewportLineBlocks: [first],
  };
  assert.deepEqual(
    blockAtClientY(throwingView, 10, false),
    first,
    "lineBlockAtHeight 抛错时应吞掉异常并降级到 viewportLineBlocks"
  );

  const nullView = {
    documentTop: 0,
    lineBlockAtHeight: () => null,
    viewportLineBlocks: [first],
  };
  assert.deepEqual(
    blockAtClientY(nullView, 10, false),
    first,
    "lineBlockAtHeight 返回 null 时也应降级到 viewportLineBlocks"
  );
});

test("blockAtClientY 档3：viewportLineBlocks 为空时用 posAtCoords + doc.lineAt 兜底", () => {
  let receivedCoords;
  const view = {
    documentTop: 0,
    viewportLineBlocks: [],
    contentDOM: {
      getBoundingClientRect: () => ({ left: 10, top: 0, right: 300, bottom: 400 }),
    },
    posAtCoords(coords) {
      receivedCoords = coords;
      return 8;
    },
    state: {
      doc: {
        lineAt(pos) {
          assert.equal(pos, 8, "lineAt 应收到 posAtCoords 返回的位置");
          return { from: 8, to: 11 };
        },
      },
    },
  };

  const block = blockAtClientY(view, 50, false);

  assert.deepEqual(
    receivedCoords,
    { x: 14, y: 50 },
    "posAtCoords 应收到内容区左侧 +4 的 x 与原始 clientY"
  );
  assert.deepEqual(block, { from: 8, to: 11 }, "档3 应返回 posAtCoords 对应行的行块");
});

test("blockAtClientY 档3：posAtCoords 返回 null 时为 null，不抛错", () => {
  const view = {
    documentTop: 0,
    viewportLineBlocks: [],
    contentDOM: {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 400 }),
    },
    posAtCoords: () => null,
  };
  assert.equal(blockAtClientY(view, 50, true), null, "posAtCoords 返回 null 时应返回 null");
});

/* ------------------------------------------------------------------ *
 * 严格行尾 / 空行例外 / 行号栏高亮行 / 删除补偿
 * ------------------------------------------------------------------ */

test("selectionEnd：严格行尾 + 空行例外", () => {
  assert.equal(selectionEnd(state, L(2)), 7, "非空行严格停在行末，不吞换行");
  assert.equal(selectionEnd(state, L(4)), 15, "末行没有换行可吞");

  const withEmpty = EditorState.create({ doc: "aaa\n\nccc" });
  assert.equal(
    selectionEnd(withEmpty, { from: 4, to: 4 }),
    5,
    "空行例外：吞掉它自己的换行符，选区才可见（否则零宽选区删掉上一行换行）"
  );

  const emptyTail = EditorState.create({ doc: "aaa\nbbb\n" });
  assert.equal(selectionEnd(emptyTail, { from: 8, to: 8 }), 8, "文末空行没有换行可吞");
});

test("Shift 扩展：includeEOL 只影响单击 / Shift 的末端", () => {
  assert.deepEqual(
    pair(rangeForShift(state, 4, L(3), yes)),
    [4, 12],
    "includeEOL 打开：Shift 到第3行仍吞换行（保留一键删整行）"
  );
  assert.deepEqual(
    pair(rangeForShift(state, 4, L(3), no)),
    [4, 11],
    "includeEOL 关闭：Shift 到第3行严格停在第3行行末"
  );
});

test("rowSpan：把选区映射回覆盖的行号区间", () => {
  assert.deepEqual(rowSpan(state, { from: 4, to: 11 }), { first: 2, last: 3 }, "第2–3行");
  assert.deepEqual(
    rowSpan(state, { from: 4, to: 12 }),
    { first: 2, last: 3 },
    "终点落在下一行行首时仍只算到上一行"
  );

  const withEmpty = EditorState.create({ doc: "aaa\n\nccc" });
  assert.deepEqual(
    rowSpan(withEmpty, { from: 4, to: 5 }),
    { first: 2, last: 2 },
    "空行例外（to = from + 1 = 下一行行首）仍落回空行那一行"
  );
});

test("gutterLineStarts：每行一个行首 marker，终点在下一行行首时不多亮一行", () => {
  assert.deepEqual(gutterLineStarts(state, [{ from: 4, to: 11 }]), [4, 8], "严格选区覆盖第2–3行");
  assert.deepEqual(
    gutterLineStarts(state, [{ from: 4, to: 12 }]),
    [4, 8],
    "includeEOL 的终点（第4行行首）不能把第4行行首点亮"
  );
  assert.deepEqual(gutterLineStarts(state, [{ from: 8, to: 15 }]), [8, 12], "第3行到末行");

  const emptyTail = EditorState.create({ doc: "aaa\nbbb\n" });
  assert.deepEqual(
    gutterLineStarts(emptyTail, [{ from: 8, to: 8 }]),
    [8],
    "文末空行单击是零宽选区，也要点亮这一行"
  );
});

test("extendedDeleteEnd：删除时多删末尾一个换行，已含换行则不重复", () => {
  assert.equal(extendedDeleteEnd(state, { from: 4, to: 7 }), 8, "终点在行末 -> 补偿一个换行");
  assert.equal(
    extendedDeleteEnd(state, { from: 4, to: 8 }),
    8,
    "终点已在下一行行首（已含换行）-> 不重复补偿"
  );
  assert.equal(extendedDeleteEnd(state, { from: 12, to: 15 }), 15, "文末没有换行可多删");
  assert.equal(extendedDeleteEnd(state, { from: 4, to: 5 }), 5, "终点在行内 -> 不补偿");
});

test("extendRowSpan：Shift+方向键按行扩展 / 收缩的行号区间", () => {
  const span = { first: 3, last: 6 };
  assert.deepEqual(extendRowSpan(span, false, 1, 1, 20), { first: 3, last: 7 }, "向下扩展一行");
  assert.deepEqual(extendRowSpan(span, false, -1, 1, 20), { first: 3, last: 5 }, "向下选区向上收缩一行");
  assert.deepEqual(extendRowSpan(span, true, -1, 1, 20), { first: 2, last: 6 }, "向上扩展一行");
  assert.deepEqual(extendRowSpan(span, true, 1, 1, 20), { first: 4, last: 6 }, "向上选区向下收缩一行");

  assert.deepEqual(
    extendRowSpan({ first: 3, last: 3 }, false, -1, 1, 20),
    { first: 3, last: 3 },
    "收缩到锚点那一行就停住，不把选区收成光标"
  );
  assert.deepEqual(
    extendRowSpan({ first: 6, last: 6 }, true, 1, 1, 20),
    { first: 6, last: 6 },
    "向上选区收缩到锚点那一行也停住"
  );

  assert.deepEqual(
    extendRowSpan({ first: 8, last: 9 }, false, 1, 5, 10),
    { first: 8, last: 10 },
    "向下扩展被文档末行钳制"
  );
  assert.deepEqual(
    extendRowSpan({ first: 2, last: 6 }, true, -1, 5, 10),
    { first: 1, last: 6 },
    "向上扩展被文档首行钳制"
  );
  assert.deepEqual(extendRowSpan(span, false, 1, 10, 20), { first: 3, last: 16 }, "PageDown 一次移动 10 行");
});

/* ------------------------------------------------------------------ *
 * 行号栏高亮：由插件事务的来源标记驱动（整行选区 -> 逐行 marker）
 * ------------------------------------------------------------------ */

test("行号栏高亮：插件事务点亮每一行，其它来源改选区 / 改文档后立即失效", () => {
  const { gutterSelection, lineSelectionField, lineSelectionGutterClass } = testApi;
  const markedStarts = (state) => {
    const marks = [];
    // gutterLineClass 是无 combine 的 facet，读出来是 RangeSet 数组（gutter 内部同样用 RangeSet.iter）
    const cursor = RangeSet.iter(state.facet(gutterLineClass), 0);
    while (cursor.value) {
      marks.push(cursor.from);
      cursor.next();
    }
    return marks;
  };

  let s = EditorState.create({
    doc: "aaa\nbbb\nccc\nddd",
    extensions: [lineSelectionField, lineSelectionGutterClass],
  });
  assert.deepEqual(markedStarts(s), [], "初始没有整行选区 -> 不亮");

  // 插件自己产生的整行选区（拖动第2–3行）：每一行一个 marker
  s = s.update({
    selection: EditorSelection.create([EditorSelection.range(4, 11)]),
    annotations: gutterSelection.of(true),
  }).state;
  assert.deepEqual(markedStarts(s), [4, 8], "第2–3行各点亮一个行首 marker");

  // 内容区点击等其它来源改选区：高亮失效
  s = s.update({ selection: EditorSelection.single(4) }).state;
  assert.deepEqual(markedStarts(s), [], "非插件事务改选区后高亮失效");

  // 插件事务 + 文档改动：宁可不亮也不错亮
  s = s.update({
    selection: EditorSelection.create([EditorSelection.range(4, 11)]),
    annotations: gutterSelection.of(true),
  }).state;
  s = s.update({ changes: { from: 0, insert: "x" } }).state;
  assert.deepEqual(markedStarts(s), [], "文档改动后高亮失效");
});
