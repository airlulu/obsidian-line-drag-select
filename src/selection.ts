import { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";

/**
 * 一个「视觉行块」的最小抽象。
 * CM6 的 BlockInfo 在折叠 / 嵌入 widget / 换行的情况下覆盖的范围大于单行，
 * 这里只用到它的文档区间，因此解耦成纯数据，方便脱离 DOM 做单测。
 */
export interface LineBlock {
  from: number;
  to: number;
}

export interface LineSelectOptions {
  /** 选区是否吞掉行尾换行符。VS Code 的行为是吞掉，这样 Backspace / Cut 能整行移除。 */
  includeEOL: boolean;
}

/** 行块末端（可选含换行符）。文档最后一行没有换行符可吞。 */
export function blockEnd(state: EditorState, block: LineBlock, opts: LineSelectOptions): number {
  return opts.includeEOL && block.to < state.doc.length ? block.to + 1 : block.to;
}

/** 单击行号：选中整行。 */
export function rangeForLine(
  state: EditorState,
  block: LineBlock,
  opts: LineSelectOptions
): SelectionRange {
  return EditorSelection.range(block.from, blockEnd(state, block, opts));
}

/**
 * 拖拽：以按下时那一行（anchor）为锚，逐行扩展。
 * 向下拖 -> anchor 在起始行行首，head 在末行行尾；
 * 向上拖 -> anchor 在起始行行尾，head 在末行行首。
 * 这样 anchor/head 方向与 VS Code 一致，Shift+方向键还能继续微调。
 */
export function rangeForDrag(
  state: EditorState,
  anchor: LineBlock,
  current: LineBlock,
  opts: LineSelectOptions
): SelectionRange {
  if (current.from >= anchor.from) {
    return EditorSelection.range(anchor.from, blockEnd(state, current, opts));
  }
  return EditorSelection.range(blockEnd(state, anchor, opts), current.from);
}

/**
 * Shift + 点击：锚点固定为既有 selection 的 anchor，目标行整行对齐后延伸。
 * 目标行在锚点之后 -> 吃到行尾；在锚点之前 -> 只到行首。
 */
export function rangeForShift(
  state: EditorState,
  anchorPos: number,
  block: LineBlock,
  opts: LineSelectOptions
): SelectionRange {
  if (anchorPos <= block.from) {
    return EditorSelection.range(anchorPos, blockEnd(state, block, opts));
  }
  return EditorSelection.range(anchorPos, block.from);
}

/**
 * Ctrl/Cmd + 点击：把整行作为独立选区追加（已存在则移除，即 toggle）。
 * 追加前丢掉纯光标 range —— 否则「复制多行」会带上一个看不见的空选区。
 */
export function toggleLineRange(
  state: EditorState,
  base: readonly SelectionRange[],
  block: LineBlock,
  opts: LineSelectOptions
): EditorSelection {
  const next = rangeForLine(state, block, opts);
  const kept = base.filter((r) => !r.empty);
  const hit = kept.findIndex((r) => r.from === next.from && r.to === next.to);
  const ranges = hit >= 0 ? kept.filter((_, i) => i !== hit) : kept.concat(next);
  if (!ranges.length) return EditorSelection.create([EditorSelection.cursor(next.from)]);
  return EditorSelection.create(ranges, ranges.length - 1);
}

/** 追加一个选区，并把新选区设为主选区（main selection）。同样丢弃纯光标 range。 */
export function addRange(
  base: readonly SelectionRange[],
  range: SelectionRange
): EditorSelection {
  const ranges = base.filter((r) => !r.empty).concat(range);
  return EditorSelection.create(ranges, ranges.length - 1);
}

/** 拖拽过程中列的候选行变化时是否值得重新 dispatch，避免每像素一次事务。 */
export function sameBlock(a: LineBlock | null, b: LineBlock | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.from === b.from && a.to === b.to;
}
