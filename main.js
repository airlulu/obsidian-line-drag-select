/*
 * Obsidian「行号区拖动多选」插件
 * ------------------------------------------------------------------
 * 本文件既是插件源码，也是 Obsidian 直接加载的可执行文件（main.js）。
 * 没有 esbuild / tsc / 任何打包或转译步骤：把本目录（main.js + manifest.json + styles.css）
 * 复制到 <Vault>/.obsidian/plugins/line-drag-select/ 即可使用。
 *
 * 运行时只依赖 Obsidian 自己注入的模块：
 *   require("obsidian")            —— 插件基类与设置面板等官方 API
 *   require("@codemirror/state")   —— CM6 状态层（Obsidian 内置）
 *   require("@codemirror/view")    —— CM6 视图层（Obsidian 内置）
 * 因此发布产物不需要 node_modules。node_modules 只在开发期跑单测 / 类型检查时用。
 *
 * 代码结构（自上而下，共 10 节）：
 *   1. 配置项与默认值
 *   2. 纯逻辑：行块 -> 选区（不碰 DOM，可单测）
 *   3. 坐标 -> 行块（三档降级）
 *   4. 行号栏高亮（选区来源标记 + gutterLineClass 逐行 point marker + widget 行块 marker）
 *   5. 拖拽状态机（全局单例）
 *   5-B. 整行选区的键盘命令（Shift 按行扩展 / 删除·剪切补偿）
 *   6-A / 6-B. 两种事件源：复用原生行号 / 自绘行号列
 *   7. 对外出口：CM6 扩展工厂
 *   8. Plugin 装配
 *   9. 设置面板
 *   10. 模块导出
 *
 * 语法基线：本文件按 ES2020+ 原样运行（用到可选链、类字段），
 * Obsidian 1.4 的 Chromium 114 完全支持，远高于所需下限，故不再做语法降级。
 */

const { Plugin, PluginSettingTab, Setting, MarkdownView, Notice } = require("obsidian");
const {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  StateField,
} = require("@codemirror/state");
const {
  GutterMarker,
  ViewPlugin,
  gutter,
  gutterLineClass,
  keymap,
  lineNumberWidgetMarker,
} = require("@codemirror/view");

/* ------------------------------------------------------------------ *
 * 1. 配置项与默认值
 * ------------------------------------------------------------------ */

/** @typedef {"hook" | "own"} GutterMode */

/**
 * @typedef {object} Settings
 * @property {GutterMode} gutterMode - hook：接管 Obsidian 原生行号列；own：插件自绘一列
 * @property {boolean} includeEOL - 选区是否吞掉行尾换行符（VS Code 行为）
 * @property {boolean} autoScroll - 拖到编辑器上下边缘时自动滚动
 */

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  gutterMode: "hook",
  // 默认严格行尾：拖动/单击/Shift 的整行选区都停在末尾行行末（见 docs 设计文档）；
  // 打开后只影响单击 / Shift：整行选区吞掉行尾换行符，便于一键删整行。
  includeEOL: false,
  autoScroll: true,
};

/* ------------------------------------------------------------------ *
 * 2. 纯逻辑：行块 -> 选区
 * ------------------------------------------------------------------ */

/**
 * 一个「视觉行块」的最小抽象。
 * CM6 的 BlockInfo 在折叠 / 嵌入 widget / 换行的情况下覆盖的范围大于单行，
 * 这里只用到它的文档区间，因此解耦成纯数据，方便脱离 DOM 做单测。
 *
 * @typedef {object} LineBlock
 * @property {number} from
 * @property {number} to
 */

/**
 * @typedef {object} LineSelectOptions
 * @property {boolean} includeEOL
 */

/**
 * 行块末端（可选含换行符）。文档最后一行没有换行符可吞。
 * 打开 includeEOL 时只用于“单击 / Shift”的整行选区（拖动永远走 selectionEnd）。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {number}
 */
function blockEnd(state, block, opts) {
  return opts.includeEOL && block.to < state.doc.length ? block.to + 1 : block.to;
}

/**
 * 严格行尾：整行选区的终点落在末尾行行末，不吞换行符 —— 这样 head / 光标 /
 * 选区下界都严格停在“鼠标拖到的那一行”，不会越到下一行行头。
 *
 * 空行例外：空行的 from == to，严格行尾会得到零宽选区（看起来没选中，
 * 且 Backspace 会删掉上一行的换行、把两行并成一行），所以空行吞掉自己的换行符。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} block
 * @returns {number}
 */
function selectionEnd(state, block) {
  if (block.from === block.to) return block.to < state.doc.length ? block.to + 1 : block.to;
  return block.to;
}

/**
 * 单击行号：选中整行。
 * includeEOL 打开时吞掉行尾换行符（保留“点一行后一键删整行”的能力），否则严格行尾。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForLine(state, block, opts) {
  return EditorSelection.range(
    block.from,
    opts.includeEOL ? blockEnd(state, block, opts) : selectionEnd(state, block)
  );
}

/**
 * 拖拽：以按下时那一行（anchor）为锚，逐行扩展。终点永远严格行尾（与 includeEOL 无关）。
 * 向下拖 -> anchor 在起始行行首，head 在末行行末；
 * 向上拖 -> anchor 在起始行行末，head 在末行行首。
 * 这样 anchor/head 方向与 VS Code 一致，配合 5-B 的 Shift 按行扩展还能继续整行微调。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} anchor
 * @param {LineBlock} current
 * @param {LineSelectOptions} _opts - 仅为保持调用签名一致：拖动不再受 includeEOL 影响
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForDrag(state, anchor, current, _opts) {
  if (current.from >= anchor.from) {
    return EditorSelection.range(anchor.from, selectionEnd(state, current));
  }
  return EditorSelection.range(selectionEnd(state, anchor), current.from);
}

/**
 * Shift + 点击：锚点固定为既有 selection 的 anchor，目标行整行对齐后延伸。
 * 目标行在锚点之后 -> 吃到行末（includeEOL 打开时吞换行）；在锚点之前 -> 只到行首。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} anchorPos
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForShift(state, anchorPos, block, opts) {
  if (anchorPos <= block.from) {
    return EditorSelection.range(
      anchorPos,
      opts.includeEOL ? blockEnd(state, block, opts) : selectionEnd(state, block)
    );
  }
  return EditorSelection.range(anchorPos, block.from);
}

/**
 * Ctrl/Cmd + 点击：把整行作为独立选区追加（已存在则移除，即 toggle）。
 * 追加前丢掉纯光标 range —— 否则「复制多行」会带上一个看不见的空选区。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {readonly import("@codemirror/state").SelectionRange[]} base
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").EditorSelection}
 */
function toggleLineRange(state, base, block, opts) {
  const next = rangeForLine(state, block, opts);
  const kept = base.filter((r) => !r.empty);
  const hit = kept.findIndex((r) => r.from === next.from && r.to === next.to);
  const ranges = hit >= 0 ? kept.filter((_, i) => i !== hit) : kept.concat(next);
  if (!ranges.length) return EditorSelection.create([EditorSelection.cursor(next.from)]);
  return EditorSelection.create(ranges, ranges.length - 1);
}

/**
 * 追加一个选区，并把新选区设为主选区（main selection）。同样丢弃纯光标 range。
 *
 * @param {readonly import("@codemirror/state").SelectionRange[]} base
 * @param {import("@codemirror/state").SelectionRange} range
 * @returns {import("@codemirror/state").EditorSelection}
 */
function addRange(base, range) {
  const ranges = base.filter((r) => !r.empty).concat(range);
  return EditorSelection.create(ranges, ranges.length - 1);
}

/**
 * 拖拽过程中列的候选行变化时是否值得重新 dispatch，避免每像素一次事务。
 *
 * @param {LineBlock | null} a
 * @param {LineBlock | null} b
 * @returns {boolean}
 */
function sameBlock(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.from === b.from && a.to === b.to;
}

/**
 * 选区覆盖的行号区间（1 基、闭区间）。末尾行用 `to - 1` 反查，这样空行例外
 * （to = from + 1）与 includeEOL（to = 下一行行首）都能落回“真正被选中的那一行”。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} range
 * @returns {{ first: number, last: number }}
 */
function rowSpan(state, range) {
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to > range.from ? range.to - 1 : range.from).number;
  return { first, last: Math.max(first, last) };
}

/**
 * 行号栏逐行高亮要的“行首位置”列表。
 * CM6 的 gutterLineClass 每行只认落在行首的 point marker（跨行 range 只命中 range.from 那一行），
 * 所以必须把选区覆盖的每一行拆成一个行首 marker。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {readonly LineBlock[]} ranges
 * @returns {number[]}
 */
function gutterLineStarts(state, ranges) {
  /** @type {number[]} */
  const starts = [];
  /** @type {Set<number>} */
  const seen = new Set();
  for (const range of ranges) {
    if (range.from === range.to) {
      // 零宽选区（例如单击文末空行）：单行点亮，与其它规则保持一致
      const pos = state.doc.lineAt(range.from).from;
      if (!seen.has(pos)) {
        seen.add(pos);
        starts.push(pos);
      }
      continue;
    }
    let line = state.doc.lineAt(range.from);
    for (;;) {
      // 只收集“行首 < 选区终点”的行：终点落在下一行行首时不会把下一行点亮
      if (line.from < range.to && !seen.has(line.from)) {
        seen.add(line.from);
        starts.push(line.from);
      }
      if (line.to >= range.to || line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return starts.sort((a, b) => a - b);
}

/**
 * 块级 widget（表格 / 嵌入块 / 折叠块……）是否被整行选区整体覆盖。
 *
 * 行号栏高亮对文本行用 gutterLineClass 逐行 point marker；但被 block widget 整体替换
 * 掉的行没有文本行块（CM6 的 gutter 只在 BlockType.Text 行块上消费 gutterLineClass），
 * 这些“视觉行”必须按块判断，改由 gutter 的 widgetMarker 出元素（见 widgetSelectionMarker）。
 *
 * 只认完全覆盖：行号区产生的选区永远按整行对齐，所以一个 widget 行块要么整块被选中，
 * 要么完全没选中，不存在“选中半个表格块”的情况。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {readonly LineBlock[]} ranges
 * @param {LineBlock} block
 * @returns {boolean}
 */
function blockCoveredByRanges(state, ranges, block) {
  if (!block || block.to <= block.from) return false;
  const first = state.doc.lineAt(block.from).from;
  // block.to 可能落在新行行首（替换范围吞掉行尾换行），减一后仍能落回真正覆盖的末行
  const last = state.doc.lineAt(block.to - 1).from;
  return ranges.some((range) => range.from <= first && range.to > last);
}

/**
 * 按行扩展 / 收缩后的行号区间（纯函数，便于单测）。
 * 收缩到只剩锚点那一行就停住，不把选区收成光标；到文档首尾会被钳制。
 *
 * @param {{ first: number, last: number }} span - 当前覆盖的行号区间
 * @param {boolean} headAbove - head 在上（向上拖出来的选区）
 * @param {1 | -1} dir - 1 = 向下按键，-1 = 向上按键
 * @param {number} rows - 一次移动几行
 * @param {number} lineCount - 文档总行数
 * @returns {{ first: number, last: number }}
 */
function extendRowSpan(span, headAbove, dir, rows, lineCount) {
  let first = span.first;
  let last = span.last;
  if (dir > 0) {
    if (headAbove) first += rows;
    else last += rows;
  } else if (headAbove) {
    first -= rows;
  } else {
    last -= rows;
  }
  first = Math.max(1, first);
  last = Math.min(lineCount, last);
  if (first > last) {
    if (headAbove) first = last;
    else last = first;
  }
  return { first, last };
}

/**
 * 整行删除补偿：严格行尾的选区末尾正好落在行末时，删除 / 剪切要多删一个换行符，
 * 否则拖选几行后按 Backspace 只会清空内容、留下一个空行。
 * 已经含换行（includeEOL 单击，终点在下一行行首）时不重复多删。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} range
 * @returns {number}
 */
function extendedDeleteEnd(state, range) {
  if (range.to >= state.doc.length) return range.to; // 文末没有换行可多删
  const line = state.doc.lineAt(range.to);
  if (line.from === range.to && range.to > range.from) return range.to; // 已含行尾换行
  if (line.to === range.to) return range.to + 1; // 正好停在行末：多删这个换行
  return range.to;
}

/* ------------------------------------------------------------------ *
 * 3. 坐标 -> 行块（三档降级，兼容 Obsidian 内置的 @codemirror/view 新旧版本）
 * ------------------------------------------------------------------ */

/**
 * 把鼠标的视口 Y 坐标翻译成一个行块。
 * gutter 元素与 content 行块在 CM6 中是一一对齐的，所以 y 可以直接换算。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {number} clientY
 * @param {boolean} clamp - 拖出编辑器范围时是否钳制到首/末行
 * @returns {LineBlock | null}
 */
function blockAtClientY(view, clientY, clamp) {
  const height = clientY - view.documentTop;

  // 6.26+：官方 API，快且能正确处理折叠 / block widget
  if (typeof view.lineBlockAtHeight === "function") {
    try {
      const block = view.lineBlockAtHeight(height);
      if (block) return { from: block.from, to: block.to };
    } catch {
      /* 落到下一档 */
    }
  }

  const blocks = view.viewportLineBlocks;
  if (blocks && blocks.length) {
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    if (height < first.top) return clamp ? first : null;
    if (height >= last.bottom) return clamp ? last : null;
    for (const b of blocks) if (height < b.bottom) return b;
    return last;
  }

  // 最后兜底：拿内容区左侧的 x 反查文档位置
  const rect = view.contentDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + 4, y: clientY });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  return { from: line.from, to: line.to };
}

/* ------------------------------------------------------------------ *
 * 4. 行号栏高亮（由“行号区产生的整行选区”驱动，逐行 point marker）
 * ------------------------------------------------------------------ */

/**
 * 事务标记：这条事务携带的是插件自己产生的整行选区（拖动 / 单击 / Shift / Ctrl 点击 /
 * 键盘按行扩展）。内容区点击、Ctrl+A、撤销重做等其它来源改选区时，高亮必须立刻失效。
 */
const gutterSelection = Annotation.define();

const lineSelectionField = StateField.define({
  // 用 JSDoc 断言把初始值标成「区间数组或 null」，StateField<Value> 的 Value 由它推断而来
  create: () => /** @type {{ ranges: LineBlock[] } | null} */ (null),
  /**
   * @param {{ ranges: LineBlock[] } | null} value
   * @param {import("@codemirror/state").Transaction} tr
   */
  update(value, tr) {
    // 文档一改位置就可能失效，直接撤掉高亮，宁可不亮也不错亮
    if (tr.docChanged) return null;
    if (tr.annotation(gutterSelection)) {
      return { ranges: tr.newSelection.ranges.map((r) => ({ from: r.from, to: r.to })) };
    }
    // 不是插件产生的选区变化（点击正文、Ctrl+A、撤销……）-> 失效
    if (tr.selection) return null;
    return value;
  },
});

class SelectedLineMarker extends GutterMarker {
  constructor() {
    super();
    this.elementClass = "cm-lds-selected";
  }
}

const lineSelectionGutterClass = gutterLineClass.compute([lineSelectionField], (state) => {
  const value = state.field(lineSelectionField);
  if (!value) return RangeSet.empty;
  return RangeSet.of(
    gutterLineStarts(state, value.ranges).map((pos) => new SelectedLineMarker().range(pos)),
    true
  );
});

/**
 * 被整行选区覆盖的块级 widget 在行号栏补一个“空白高亮元素”。
 *
 * 为什么需要单独一条路径：表格、嵌入块、折叠块在 Live Preview 里是 block widget，
 * 会把源码行整体替换掉——这些行没有文本行块，而 CM6 的 gutter 在遇到 widget 行块时
 * 只问该 gutter 的 widgetMarker，不会消费 gutterLineClass。于是“选中行都该亮”的规则
 * 在表格这类行上必然失效，行号栏会缺一段高亮。
 *
 * 这里给 widget 行块返回一个不带数字的 marker：元素高度自动等于整个 widget 的高度，
 * 选中的就是一段与文本行同色的高亮；未选中时返回 null，不改变 Obsidian 原本
 * “widget 旁边不显示行号”的外观，也不会多出空白元素。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {unknown} _widget
 * @param {LineBlock} block
 * @returns {GutterMarker | null}
 */
function widgetSelectionMarker(view, _widget, block) {
  const value = view.state.field(lineSelectionField, false);
  if (!value || !block) return null;
  return blockCoveredByRanges(view.state, value.ranges, block) ? new SelectedLineMarker() : null;
}

/**
 * 原生行号列（Obsidian 自带的 lineNumbers）内部通过 lineNumberWidgetMarker facet
 * 收集 widget 行块的 marker；把上面的 widgetSelectionMarker 接进这条管道即可。
 * 老版本 CM6 没有这个 facet 时优雅降级：只失去 widget 行块高亮，其它功能不受影响。
 */
const lineSelectionWidgetMarker = lineNumberWidgetMarker
  ? lineNumberWidgetMarker.of(widgetSelectionMarker)
  : [];

/* ------------------------------------------------------------------ *
 * 5. 拖拽状态机（全局单例：同一时刻只可能有一个编辑器在拖）
 * ------------------------------------------------------------------ */

/** @typedef {"none" | "shift" | "add"} ModifierMode */

/**
 * @typedef {object} DragState
 * @property {import("@codemirror/view").EditorView} view
 * @property {LineSelectOptions} opts
 * @property {LineBlock} anchor
 * @property {import("@codemirror/state").EditorSelection} base - 按下瞬间的完整选区
 * @property {ModifierMode} mode
 * @property {LineBlock} lastBlock
 * @property {number} lastY
 * @property {number | null} raf
 * @property {boolean} wasTracked - 按下前是否已有整行选区（Esc 回滚时用于恢复高亮）
 * @property {boolean} moved
 * @property {boolean} autoScroll
 */

/** @type {DragState | null} */
let drag = null;

/**
 * @param {MouseEvent | PointerEvent} e
 * @returns {ModifierMode}
 */
function modifierOf(e) {
  // macOS 上 Cmd，Windows/Linux 上 Ctrl 表示「追加选区」，与 VS Code 一致
  if (e.metaKey || e.ctrlKey) return "add";
  if (e.shiftKey) return "shift";
  return "none";
}

/**
 * @param {DragState} d
 * @param {LineBlock} block
 */
function applySelection(d, block) {
  const { view } = d;
  const state = view.state;
  /** @type {import("@codemirror/state").EditorSelection} */
  let selection;

  if (d.mode === "add") {
    selection = addRange(d.base.ranges, rangeForDrag(state, d.anchor, block, d.opts));
  } else if (d.mode === "shift") {
    selection = EditorSelection.create([
      rangeForShift(state, state.selection.main.anchor, block, d.opts),
    ]);
  } else {
    selection = EditorSelection.create([rangeForDrag(state, d.anchor, block, d.opts)]);
  }

  view.dispatch({
    selection,
    annotations: gutterSelection.of(true),
    userEvent: "select.pointer",
  });
}

/** 拖到编辑器上下边缘时自动滚动，速度与超出距离成正比 */
function autoScrollTick() {
  if (!drag) return;
  const d = drag;
  d.raf = null;
  const scroller = d.view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const edge = 28;
  let delta = 0;
  if (d.lastY < rect.top + edge) {
    delta = -Math.min(40, (rect.top + edge - d.lastY) * 0.4);
  } else if (d.lastY > rect.bottom - edge) {
    delta = Math.min(40, (d.lastY - (rect.bottom - edge)) * 0.4);
  }
  if (!delta) return;

  const before = scroller.scrollTop;
  scroller.scrollTop += delta;
  if (scroller.scrollTop === before) return; // 已经到顶/到底

  const block = blockAtClientY(d.view, d.lastY, true);
  if (block && !sameBlock(block, d.lastBlock)) {
    d.lastBlock = block;
    applySelection(d, block);
  }
  d.raf = requestAnimationFrame(autoScrollTick);
}

function scheduleAutoScroll() {
  if (drag && drag.autoScroll && drag.raf == null) {
    drag.raf = requestAnimationFrame(autoScrollTick);
  }
}

/** @param {PointerEvent} event */
const onPointerMove = (event) => {
  if (!drag) return;
  const d = drag;
  if (!d.view.dom.isConnected) {
    endDrag();
    return;
  }
  d.lastY = event.clientY;
  d.moved = true;
  const block = blockAtClientY(d.view, d.lastY, true);
  if (!block || sameBlock(block, d.lastBlock)) {
    scheduleAutoScroll();
    return;
  }
  d.lastBlock = block;
  applySelection(d, block);
  scheduleAutoScroll();
};

const onPointerUp = () => endDrag();

/** @param {KeyboardEvent} event */
const onKeyDown = (event) => {
  if (!drag || event.key !== "Escape") return;
  event.preventDefault();
  endDrag(drag.base);
};

/** @param {import("@codemirror/state").EditorSelection | null} [restore] */
function endDrag(restore) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.raf != null) cancelAnimationFrame(d.raf);
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerUp, true);
  window.removeEventListener("keydown", onKeyDown, true);
  if (restore && d.view.dom.isConnected) {
    // Esc 回滚：只有按下前本来就是整行选区时才恢复高亮，否则让高亮失效
    d.view.dispatch({
      selection: restore,
      annotations: d.wasTracked ? gutterSelection.of(true) : undefined,
    });
  }
}

/**
 * 统一的拖拽入口：自绘 gutter 与 hook 原生 gutter 都走这里。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {LineBlock} block
 * @param {MouseEvent | PointerEvent} event
 * @param {Settings} settings
 * @returns {boolean}
 */
function startDrag(view, block, event, settings) {
  endDrag();
  /** @type {LineSelectOptions} */
  const opts = { includeEOL: settings.includeEOL };
  const mode = modifierOf(event);
  const base = view.state.selection;
  const wasTracked = view.state.field(lineSelectionField, false) !== null;

  if (mode === "add") {
    view.dispatch({
      selection: toggleLineRange(view.state, base.ranges, block, opts),
      annotations: gutterSelection.of(true),
      userEvent: "select.pointer",
    });
    return true;
  }
  if (mode === "shift") {
    const anchorPos = view.state.selection.main.anchor;
    view.dispatch({
      selection: rangeForShift(view.state, anchorPos, block, opts),
      annotations: gutterSelection.of(true),
      userEvent: "select.pointer",
    });
    return true;
  }

  drag = {
    view,
    opts,
    anchor: block,
    base,
    mode,
    lastBlock: block,
    lastY: event.clientY,
    raf: null,
    wasTracked,
    moved: false,
    autoScroll: settings.autoScroll,
  };

  // 按下即选中整行，与 VS Code 一致
  view.dispatch({
    selection: rangeForLine(view.state, block, opts),
    annotations: gutterSelection.of(true),
    userEvent: "select.pointer",
  });

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  return true;
}

/* ------------------------------------------------------------------ *
 * 5-B. 整行选区的键盘命令：Shift 按行扩展 / 删除·剪切补偿
 *
 * 严格行尾之后 head 停在末尾行行末：原生的 Shift+↑/↓ 会按列移动，选区不再是整行；
 * 同时整行删除 / 剪切会留下空行。下面的命令只接管“行号区产生的整行选区”，
 * 其余情况一律返回 false，交回原生按键行为。
 * ------------------------------------------------------------------ */

/**
 * 一屏大约能放下多少行（PageUp / PageDown 的步长）。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {number}
 */
function pageRowStep(view) {
  const lineHeight = view.defaultLineHeight || 20;
  const rows = Math.round(view.scrollDOM.clientHeight / lineHeight) - 1;
  return Math.max(1, rows);
}

/**
 * Shift + ↑/↓（PageUp / PageDown）：整行选区按视觉行块扩展 / 收缩，行号高亮跟着走。
 * 只有当前选区是“行号区整行选区”时才接管，否则返回 false 让原生按键生效。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {1 | -1} dir - 1 = 向下，-1 = 向上
 * @param {number} rows - 一次移动多少行
 * @returns {boolean}
 */
function extendLineSelection(view, dir, rows) {
  const state = view.state;
  if (!state.field(lineSelectionField, false)) return false;
  const selection = state.selection;
  const span = rowSpan(state, selection.main);
  // 向上拖出来的选区 head 在上，向下拖出来的 head 在下：两者“扩展”的方向相反
  const headAbove = selection.main.head < selection.main.anchor;
  const next = extendRowSpan(span, headAbove, dir, rows, state.doc.lines);
  if (next.first === span.first && next.last === span.last) return true;
  const first = next.first;
  const last = next.last;

  const firstLine = state.doc.line(first);
  const lastLine = state.doc.line(last);
  const end = selectionEnd(state, { from: lastLine.from, to: lastLine.to });
  const range = headAbove
    ? EditorSelection.range(end, firstLine.from)
    : EditorSelection.range(firstLine.from, end);
  view.dispatch({
    selection: selection.replaceRange(range, selection.mainIndex),
    annotations: gutterSelection.of(true),
    userEvent: "select.keyboard",
  });
  return true;
}

/**
 * 整行选区上的删除（Backspace / Delete 共用）：末尾多删一个换行符，
 * 否则拖选几行后删除只会清空内容、留下一个空行。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {boolean}
 */
function deleteTrackedLineSelection(view) {
  const state = view.state;
  if (!state.field(lineSelectionField, false)) return false;
  const ends = state.selection.ranges.map((range) => extendedDeleteEnd(state, range));
  if (ends.every((end, i) => end === state.selection.ranges[i].to)) return false;
  const spec = state.changeByRange((range) => {
    const end = extendedDeleteEnd(state, range);
    return { changes: { from: range.from, to: end }, range: EditorSelection.cursor(range.from) };
  });
  view.dispatch({ changes: spec.changes, selection: spec.selection, userEvent: "delete" });
  return true;
}

/**
 * 整行选区上的 Ctrl/Cmd + X：先按补偿后的区间写入剪贴板，再删除。
 * 没有 navigator.clipboard 时交回原生剪切（宁可不补偿，也不吞掉剪贴板内容）。
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {boolean}
 */
function cutTrackedLineSelection(view) {
  const state = view.state;
  if (!state.field(lineSelectionField, false)) return false;
  const ranges = state.selection.ranges;
  const ends = ranges.map((range) => extendedDeleteEnd(state, range));
  if (ends.every((end, i) => end === ranges[i].to)) return false;
  const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  const text = ranges.map((range, i) => state.sliceDoc(range.from, ends[i])).join("\n");
  const spec = state.changeByRange((range) => {
    const end = extendedDeleteEnd(state, range);
    return { changes: { from: range.from, to: end }, range: EditorSelection.cursor(range.from) };
  });
  clipboard.writeText(text).then(
    () => {
      // 剪贴板写入是异步的：期间文档若已被改动，就放弃删除，别用旧 changeSet 误删
      if (view.dom.isConnected && view.state.doc === state.doc) {
        view.dispatch({ changes: spec.changes, selection: spec.selection, userEvent: "delete" });
      }
    },
    () => {
      /* 写剪贴板失败：什么都不做，避免“没复制却删了” */
    }
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * 6-A. 模式 A：hook Obsidian 原生行号 gutter
 * ------------------------------------------------------------------ */

/**
 * @param {() => Settings} getSettings
 * @returns {import("@codemirror/state").Extension}
 */
function hookNativeGutter(getSettings) {
  return ViewPlugin.define((view) => {
    /** @param {PointerEvent} event */
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const target = /** @type {HTMLElement | null} */ (event.target);
      if (!target) return;
      // 只认行号那一列，避免抢走折叠箭头 / 其它 gutter 的点击
      if (!target.closest(".cm-lineNumbers")) return;
      if (!target.closest(".cm-gutters")) return;

      const block = blockAtClientY(view, event.clientY, false);
      if (!block) return;

      // capture 阶段拦下，不让 CM6 / 浏览器启动原生文本选择
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      startDrag(view, block, event, getSettings());
    };

    view.dom.addEventListener("pointerdown", onPointerDown, true);
    return {
      destroy() {
        view.dom.removeEventListener("pointerdown", onPointerDown, true);
        if (drag && drag.view === view) endDrag();
      },
    };
  });
}

/* ------------------------------------------------------------------ *
 * 6-B. 模式 B：自绘行号列（用户没开「显示行号」时也能用）
 * ------------------------------------------------------------------ */

class NumberMarker extends GutterMarker {
  /** @param {string} label */
  constructor(label) {
    super();
    this.label = label;
  }
  /** @param {GutterMarker} other */
  eq(other) {
    return other instanceof NumberMarker && other.label === this.label;
  }
  toDOM() {
    return document.createTextNode(this.label);
  }
}

/**
 * @param {() => Settings} getSettings
 * @returns {import("@codemirror/state").Extension}
 */
function ownLineNumbers(getSettings) {
  return gutter({
    class: "cm-lineNumbers cm-lds-own",
    renderEmptyElements: false,
    lineMarker(view, line) {
      return new NumberMarker(String(view.state.doc.lineAt(line.from).number));
    },
    // 自绘行号列不是 CM6 内置的 lineNumbers，lineNumberWidgetMarker facet 管不到它，
    // 所以把同一个 widget marker 函数直接配给本 gutter（语义与原生行号列一致）。
    widgetMarker: widgetSelectionMarker,
    initialSpacer(view) {
      return new NumberMarker(String(view.state.doc.lines));
    },
    domEventHandlers: {
      mousedown(view, line, event) {
        if (!(event instanceof MouseEvent) || event.button !== 0) return false;
        event.preventDefault();
        view.focus();
        return startDrag(view, { from: line.from, to: line.to }, event, getSettings());
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * 7. 对外出口：CM6 扩展工厂
 * ------------------------------------------------------------------ */

/**
 * @param {() => Settings} getSettings
 * @returns {import("@codemirror/state").Extension}
 */
function lineDragSelect(getSettings) {
  const mode = getSettings().gutterMode;
  const body = mode === "own" ? ownLineNumbers(getSettings) : hookNativeGutter(getSettings);

  return [
    // 多选区必须显式打开，否则 CM6 会把 Ctrl/Cmd 追加的选区合并掉
    EditorState.allowMultipleSelections.of(true),
    lineSelectionField,
    lineSelectionGutterClass,
    // 表格 / 嵌入块 / 折叠块这类被 block widget 替换的“视觉行”没有文本行块，
    // gutterLineClass 落不到它们身上，靠 widget marker 在行号栏补一段同色高亮。
    lineSelectionWidgetMarker,
    // 整行选区的键盘语义：Shift 按行扩展、删除 / 剪切补一个换行。
    // 只在“行号区产生的整行选区”上生效，其它情况 run 返回 false 交回原生按键。
    Prec.highest(
      keymap.of([
        { key: "Shift-ArrowDown", run: (view) => extendLineSelection(view, 1, 1) },
        { key: "Shift-ArrowUp", run: (view) => extendLineSelection(view, -1, 1) },
        { key: "Shift-PageDown", run: (view) => extendLineSelection(view, 1, pageRowStep(view)) },
        { key: "Shift-PageUp", run: (view) => extendLineSelection(view, -1, pageRowStep(view)) },
        { key: "Backspace", run: (view) => deleteTrackedLineSelection(view) },
        { key: "Delete", run: (view) => deleteTrackedLineSelection(view) },
        { key: "Mod-x", run: (view) => cutTrackedLineSelection(view) },
      ])
    ),
    // 优先级压到最高，保证我们的事件先于其它插件的 gutter handler
    Prec.highest(body),
  ];
}

/* ------------------------------------------------------------------ *
 * 8. Plugin 装配
 * ------------------------------------------------------------------ */

class LineDragSelectPlugin extends Plugin {
  /**
   * 用户配置。运行期的初始值来自 DEFAULT_SETTINGS，onload 会被 loadSettings() 覆盖。
   * （基类 Plugin 只声明了 `settings?: unknown`，这里用 JSDoc 收窄成具体类型，纯类型层面收益。）
   *
   * @type {Settings}
   */
  settings = { ...DEFAULT_SETTINGS };

  /** 设置变更后用它热重配所有已打开的编辑器 */
  compartment = new Compartment();

  async onload() {
    await this.loadSettings();

    // 官方 API：把 CM6 extension 注册到所有（含后续新建的）编辑器实例
    this.registerEditorExtension(this.compartment.of(this.build()));

    this.addSettingTab(new LineDragSelectSettingTab(this.app, this));
    this.syncBodyClass();

    // 未开启行号时给一次明确提示，否则用户会以为插件没生效
    this.addCommand({
      id: "check-line-numbers",
      name: "检查行号是否已开启",
      callback: () => this.reportGutterState(),
    });
  }

  onunload() {
    // 卸载时若正处在拖拽中，清掉 window 监听与 rAF，避免插件重载后残留监听
    // （自绘行号模式的 gutter 没有 destroy 回调，只能在这里兜底。）
    try {
      endDrag();
    } catch {
      /* 编辑器可能正在销毁 */
    }
    document.body.classList.remove("lds-own-gutter");
  }

  /** @returns {import("@codemirror/state").Extension} */
  build() {
    return lineDragSelect(() => this.settings);
  }

  syncBodyClass() {
    document.body.classList.toggle("lds-own-gutter", this.settings.gutterMode === "own");
  }

  /** 设置变更后让已打开的编辑器就地生效（CM6 的动态重配） */
  reconfigureAll() {
    const ext = this.build();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      // Obsidian 未公开 editor.cm，这里按官方文档的写法取 EditorView
      const cm = /** @type {any} */ (leaf.view)?.editor?.cm;
      if (!cm) continue;
      try {
        cm.dispatch({ effects: this.compartment.reconfigure(ext) });
      } catch {
        /* 编辑器可能正在销毁 */
      }
    }
  }

  reportGutterState() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const el = view.contentEl.querySelector(".cm-lineNumbers");
    new Notice(
      el
        ? "行号已开启，可以在行号区拖动选中多行。"
        : "未检测到行号。请在 设置 ▸ 编辑器 打开「显示行号」，或把插件切成「自绘行号列」模式。"
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncBodyClass();
    this.reconfigureAll();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
}

/* ------------------------------------------------------------------ *
 * 9. 设置面板
 * ------------------------------------------------------------------ */

class LineDragSelectSettingTab extends PluginSettingTab {
  /**
   * @param {import("obsidian").App} app
   * @param {LineDragSelectPlugin} plugin
   */
  constructor(app, plugin) {
    super(app, plugin);
    /** @type {LineDragSelectPlugin} */
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("行号来源")
      .setDesc(
        "复用：直接接管 Obsidian 原生行号列（需先在 设置 ▸ 编辑器 打开「显示行号」）；自绘：插件自己画一列，不依赖系统设置。"
      )
      .addDropdown((d) =>
        d
          .addOption("hook", "复用原生行号（推荐）")
          .addOption("own", "自绘行号列")
          .setValue(this.plugin.settings.gutterMode)
          .onChange(async (v) => {
            this.plugin.settings.gutterMode = /** @type {GutterMode} */ (v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("单击 / Shift 整行时包含行尾换行符")
      .setDesc(
        "打开后，单击或 Shift 点击行号时选区吞掉行尾换行符，按 Backspace 或剪切可整行移除；拖动始终严格停在末尾行行尾。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeEOL).onChange(async (v) => {
          this.plugin.settings.includeEOL = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("拖到边缘自动滚动")
      .setDesc("拖到编辑器上/下边缘时，笔记跟着滚动，可连续选中超出一屏的行。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoScroll).onChange(async (v) => {
          this.plugin.settings.autoScroll = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("p", {
      text: "操作：单击行号选整行；按住左键上下拖动连续选多行；Shift+点击 扩展；Ctrl/Cmd+点击 追加或取消单行选区；拖拽中按 Esc 取消；选中多行后 Shift+↑/↓（含 PageUp/PageDown）按整行加选一行，Backspace / Delete / Ctrl(Cmd)+X 会把整行连同行尾换行一起删除。选中的行号会同步高亮。",
      cls: "setting-item-description",
    });
  }
}

/* ------------------------------------------------------------------ *
 * 10. 模块导出
 * ------------------------------------------------------------------ */

// Obsidian 加载插件时既接受 module.exports 直接是构造函数，
// 也接受 module.exports.default（打包器产物的写法），两种都给出。
module.exports = LineDragSelectPlugin;
LineDragSelectPlugin.default = LineDragSelectPlugin;

// 仅给 Node 单测用：Obsidian 加载插件时不会访问 __test。
// DEFAULT_SETTINGS 这里给副本，防止单测改动污染插件默认配置。
module.exports.__test = {
  DEFAULT_SETTINGS: { ...DEFAULT_SETTINGS },
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
  blockCoveredByRanges,
  extendRowSpan,
  extendedDeleteEnd,
  // 高亮状态（供单测直接构造 / 断言插件事务的来源标记）
  gutterSelection,
  lineSelectionField,
  lineSelectionGutterClass,
  // widget 行块（表格 / 嵌入块 / 折叠块）的高亮 marker，以及完整扩展工厂（集成测试用）
  lineSelectionWidgetMarker,
  widgetSelectionMarker,
  lineDragSelect,
  // 键盘命令（供单测用最小假 view 驱动）
  pageRowStep,
  extendLineSelection,
  deleteTrackedLineSelection,
  cutTrackedLineSelection,
};
