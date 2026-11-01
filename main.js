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
 *   4. 拖拽高亮（StateField + gutterLineClass）
 *   5. 拖拽状态机（全局单例）
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
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
} = require("@codemirror/state");
const { GutterMarker, ViewPlugin, gutter, gutterLineClass } = require("@codemirror/view");

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
  includeEOL: true,
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
 * 单击行号：选中整行。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForLine(state, block, opts) {
  return EditorSelection.range(block.from, blockEnd(state, block, opts));
}

/**
 * 拖拽：以按下时那一行（anchor）为锚，逐行扩展。
 * 向下拖 -> anchor 在起始行行首，head 在末行行尾；
 * 向上拖 -> anchor 在起始行行尾，head 在末行行首。
 * 这样 anchor/head 方向与 VS Code 一致，Shift+方向键还能继续微调。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {LineBlock} anchor
 * @param {LineBlock} current
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForDrag(state, anchor, current, opts) {
  if (current.from >= anchor.from) {
    return EditorSelection.range(anchor.from, blockEnd(state, current, opts));
  }
  return EditorSelection.range(blockEnd(state, anchor, opts), current.from);
}

/**
 * Shift + 点击：锚点固定为既有 selection 的 anchor，目标行整行对齐后延伸。
 * 目标行在锚点之后 -> 吃到行尾；在锚点之前 -> 只到行首。
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} anchorPos
 * @param {LineBlock} block
 * @param {LineSelectOptions} opts
 * @returns {import("@codemirror/state").SelectionRange}
 */
function rangeForShift(state, anchorPos, block, opts) {
  if (anchorPos <= block.from) {
    return EditorSelection.range(anchorPos, blockEnd(state, block, opts));
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
 * 4. 拖拽高亮（把正在选中的行块同步到 gutter 上）
 * ------------------------------------------------------------------ */

/** @type {import("@codemirror/state").StateEffectType<{ from: number, to: number } | null>} */
const setDragHighlight = StateEffect.define();

const dragHighlightField = StateField.define({
  // 用 JSDoc 断言把初始值标成「区间或 null」，StateField<Value> 的 Value 由它推断而来
  create: () => /** @type {{ from: number, to: number } | null} */ (null),
  /**
   * @param {{ from: number, to: number } | null} value
   * @param {import("@codemirror/state").Transaction} tr
   */
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDragHighlight)) return e.value;
    // 文档被改动时位置可能失效，直接撤掉高亮，宁可不画也不错画
    if (tr.docChanged) return null;
    return value;
  },
});

class SelectedLineMarker extends GutterMarker {
  constructor() {
    super();
    this.elementClass = "cm-lds-selected";
  }
}

const dragHighlightGutterClass = gutterLineClass.compute([dragHighlightField], (state) => {
  const r = state.field(dragHighlightField);
  if (!r) return RangeSet.empty;
  return RangeSet.of([new SelectedLineMarker().range(r.from, r.to)], true);
});

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
    effects: setDragHighlight.of({ from: selection.main.from, to: selection.main.to }),
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
    d.view.dispatch({ selection: restore, effects: setDragHighlight.of(null) });
  } else if (d.view.dom.isConnected) {
    d.view.dispatch({ effects: setDragHighlight.of(null) });
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

  if (mode === "add") {
    view.dispatch({
      selection: toggleLineRange(view.state, base.ranges, block, opts),
      userEvent: "select.pointer",
    });
    return true;
  }
  if (mode === "shift") {
    const anchorPos = view.state.selection.main.anchor;
    view.dispatch({
      selection: rangeForShift(view.state, anchorPos, block, opts),
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
    moved: false,
    autoScroll: settings.autoScroll,
  };

  // 按下即选中整行，与 VS Code 一致
  view.dispatch({
    selection: rangeForLine(view.state, block, opts),
    effects: setDragHighlight.of({ from: block.from, to: blockEnd(view.state, block, opts) }),
    userEvent: "select.pointer",
  });

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown, true);
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
    dragHighlightField,
    dragHighlightGutterClass,
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
      .setName("选区包含行尾换行符")
      .setDesc("与 VS Code 一致：选中整行后按 Backspace 或剪切可整行移除。")
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
      text: "操作：单击行号选整行；按住左键上下拖动连续选多行；Shift+点击 扩展；Ctrl/Cmd+点击 追加或取消单行选区；拖拽中按 Esc 取消。",
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
  rangeForLine,
  rangeForDrag,
  rangeForShift,
  toggleLineRange,
  addRange,
  sameBlock,
};
