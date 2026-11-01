import {
  EditorSelection,
  EditorState,
  Extension,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  BlockInfo,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  gutterLineClass,
} from "@codemirror/view";
import {
  LineBlock,
  LineSelectOptions,
  addRange,
  blockEnd,
  rangeForDrag,
  rangeForLine,
  rangeForShift,
  sameBlock,
  toggleLineRange,
} from "./selection";
import { Settings } from "./settings";

/* ------------------------------------------------------------------ *
 * 1. 坐标 -> 行块
 * ------------------------------------------------------------------ */

/**
 * 把鼠标的视口 Y 坐标翻译成一个行块。
 * gutter 元素与 content 行块在 CM6 中是一一对齐的，所以 y 可以直接换算。
 * 三档降级，兼容 Obsidian 内置的 @codemirror/view 新旧版本。
 */
export function blockAtClientY(
  view: EditorView,
  clientY: number,
  clamp: boolean
): LineBlock | null {
  const height = clientY - view.documentTop;

  // 6.26+：官方 API，快且能正确处理折叠 / block widget
  const api = view as EditorView & {
    lineBlockAtHeight?: (h: number) => BlockInfo | null;
  };
  if (typeof api.lineBlockAtHeight === "function") {
    try {
      const block = api.lineBlockAtHeight(height);
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
 * 2. 拖拽高亮（把正在选中的行块同步到 gutter 上）
 * ------------------------------------------------------------------ */

const setDragHighlight = StateEffect.define<{ from: number; to: number } | null>();

const dragHighlightField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDragHighlight)) return e.value;
    // 文档被改动时位置可能失效，直接撤掉高亮，宁可不画也不错画
    if (tr.docChanged) return null;
    return value;
  },
});

class SelectedLineMarker extends GutterMarker {
  override elementClass = "cm-lds-selected";
}

const dragHighlightGutterClass = gutterLineClass.compute([dragHighlightField], (state) => {
  const r = state.field(dragHighlightField);
  if (!r) return RangeSet.empty;
  return RangeSet.of([new SelectedLineMarker().range(r.from, r.to)], true);
});

/* ------------------------------------------------------------------ *
 * 3. 拖拽状态机（全局单例：同一时刻只可能有一个编辑器在拖）
 * ------------------------------------------------------------------ */

type ModifierMode = "none" | "shift" | "add";

interface DragState {
  view: EditorView;
  opts: LineSelectOptions;
  anchor: LineBlock;
  /** 按下瞬间的完整选区，Shift / Ctrl 分支要用，Esc 取消时用于回滚 */
  base: EditorSelection;
  mode: ModifierMode;
  lastBlock: LineBlock;
  lastY: number;
  raf: number | null;
  moved: boolean;
  autoScroll: boolean;
}

let drag: DragState | null = null;

function modifierOf(e: MouseEvent | PointerEvent): ModifierMode {
  // macOS 上 Cmd，Windows/Linux 上 Ctrl 表示「追加选区」，与 VS Code 一致
  if (e.metaKey || e.ctrlKey) return "add";
  if (e.shiftKey) return "shift";
  return "none";
}

function applySelection(d: DragState, block: LineBlock) {
  const { view } = d;
  const state = view.state;
  let selection: EditorSelection;

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

const onPointerMove = (event: PointerEvent) => {
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

const onKeyDown = (event: KeyboardEvent) => {
  if (!drag || event.key !== "Escape") return;
  event.preventDefault();
  endDrag(drag.base);
};

function endDrag(restore?: EditorSelection | null) {
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

/** 统一的拖拽入口：自绘 gutter 与 hook 原生 gutter 都走这里 */
function startDrag(
  view: EditorView,
  block: LineBlock,
  event: MouseEvent | PointerEvent,
  settings: Settings
): boolean {
  endDrag();
  const opts: LineSelectOptions = { includeEOL: settings.includeEOL };
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
 * 4. 模式 A：hook Obsidian 原生行号 gutter
 * ------------------------------------------------------------------ */

function hookNativeGutter(getSettings: () => Settings): Extension {
  return ViewPlugin.define((view) => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
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
        if (drag?.view === view) endDrag();
      },
    };
  });
}

/* ------------------------------------------------------------------ *
 * 5. 模式 B：自绘行号列（用户没开「显示行号」时也能用）
 * ------------------------------------------------------------------ */

class NumberMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: NumberMarker) {
    return other.label === this.label;
  }
  override toDOM() {
    return document.createTextNode(this.label);
  }
}

function ownLineNumbers(getSettings: () => Settings): Extension {
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
 * 6. 对外出口
 * ------------------------------------------------------------------ */

export function lineDragSelect(getSettings: () => Settings): Extension {
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
