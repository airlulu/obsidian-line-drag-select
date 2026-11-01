import { EditorState, EditorSelection } from "@codemirror/state";
import {
  rangeForLine,
  rangeForDrag,
  rangeForShift,
  toggleLineRange,
  addRange,
  LineBlock,
} from "../src/selection";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failed++;
    console.error(`FAIL ${label}: got ${a}, want ${b}`);
  } else {
    console.log(`ok   ${label} -> ${a}`);
  }
}

/** "aaa\nbbb\nccc\nddd" -> 每行 3 字符，positions: L1 0-3, L2 4-7, L3 8-11, L4 12-15 */
const state = EditorState.create({ doc: "aaa\nbbb\nccc\nddd" });
const L = (n: number): LineBlock => {
  const l = state.doc.line(n);
  return { from: l.from, to: l.to };
};
const yes = { includeEOL: true };
const no = { includeEOL: false };
const pair = (r: { anchor: number; head: number }) => [r.anchor, r.head];

console.log("--- 单击行号 ---");
eq(pair(rangeForLine(state, L(2), yes)), [4, 8], "单击第2行（含换行符）");
eq(pair(rangeForLine(state, L(2), no)), [4, 7], "单击第2行（不含换行符）");
eq(pair(rangeForLine(state, L(4), yes)), [12, 15], "单击末行（末尾无换行符可吞）");

console.log("--- 拖拽 ---");
eq(pair(rangeForDrag(state, L(2), L(4), yes)), [4, 15], "从第2行向下拖到第4行");
eq(pair(rangeForDrag(state, L(4), L(2), yes)), [15, 4], "从第4行向上拖到第2行");
eq(pair(rangeForDrag(state, L(2), L(2), yes)), [4, 8], "原地按下不移动");

console.log("--- Shift 扩展 ---");
eq(pair(rangeForShift(state, 4, L(4), yes)), [4, 15], "锚点在第2行首，Shift 点到第4行");
eq(pair(rangeForShift(state, 15, L(2), yes)), [15, 4], "锚点在文末，Shift 点到第2行");

console.log("--- Ctrl/Cmd 追加与 toggle ---");
const empty = EditorSelection.single(0).ranges;
const added = toggleLineRange(state, empty, L(3), yes);
eq(
  added.ranges.map((r) => [r.from, r.to]),
  [[8, 12]],
  "追加第3行"
);
const removed = toggleLineRange(state, added.ranges, L(3), yes);
eq(
  removed.ranges.map((r) => [r.from, r.to]),
  [[8, 8]],
  "再次 toggle 第3行 -> 回到第3行行首的光标"
);
const multi = addRange(added.ranges, rangeForLine(state, L(1), yes));
eq(
  multi.ranges.map((r) => [r.from, r.to]),
  [
    [0, 4],
    [8, 12],
  ],
  "多选区按文档顺序规范化"
);

console.log(failed ? `\n${failed} 个用例失败` : "\n全部用例通过");
process.exit(failed ? 1 : 0);
