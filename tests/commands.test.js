"use strict";

/**
 * 整行选区键盘命令的单测：Shift 按行扩展、Backspace/Delete、Ctrl/Cmd+X。
 *
 * 这里用最小的“假 view”驱动 main.js 里的命令（它们只用到 view.state / view.dispatch /
 * view.defaultLineHeight / view.scrollDOM.clientHeight / view.dom.isConnected），
 * 不需要真实 DOM，也不经过 Obsidian。命令产生的选区与文档变化都是真实 CM6 状态对象。
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
const { EditorState, EditorSelection } = require("@codemirror/state");

const pluginModule = require("../main.js");
const {
  gutterSelection,
  lineSelectionField,
  lineSelectionGutterClass,
  pageRowStep,
  extendLineSelection,
  deleteTrackedLineSelection,
  cutTrackedLineSelection,
} = pluginModule.__test;

/** "aaa\nbbb\nccc\nddd\neee" -> 第1行 0-3、第2行 4-7、第3行 8-11、第4行 12-15、第5行 16-19 */
const DOC = "aaa\nbbb\nccc\nddd\neee";

/**
 * 造一个带“插件整行选区来源标记”的状态。
 *
 * @param {readonly (readonly [number, number])[]} ranges - [anchor, head] 列表
 */
function makeState(ranges) {
  let state = EditorState.create({
    doc: DOC,
    extensions: [lineSelectionField, lineSelectionGutterClass],
  });
  state = state.update({
    selection: EditorSelection.create(
      ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))
    ),
    annotations: gutterSelection.of(true),
  }).state;
  return state;
}

/** 命令只碰这几个 view 成员，够用即可。 */
function makeView(state) {
  return {
    state,
    defaultLineHeight: 20,
    scrollDOM: { clientHeight: 400 },
    dom: { isConnected: true },
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
  };
}

const pair = (view) => [view.state.selection.main.anchor, view.state.selection.main.head];

test("Shift+↓：整行选区向下扩展一行，行号栏来源标记保留", () => {
  const view = makeView(makeState([[4, 11]])); // 第2–3行
  assert.equal(extendLineSelection(view, 1, 1), true, "应接管 Shift+↓");
  assert.deepEqual(pair(view), [4, 15], "head 扩到第4行行末");
  assert.notEqual(view.state.field(lineSelectionField), null, "整行选区来源标记保留");
});

test("Shift+↑：先收缩，到锚点那一行就停住（不塌成光标）", () => {
  const view = makeView(makeState([[4, 15]])); // 第2–4行
  assert.equal(extendLineSelection(view, -1, 1), true);
  assert.deepEqual(pair(view), [4, 11], "收缩到第2–3行");
  assert.equal(extendLineSelection(view, -1, 1), true);
  assert.deepEqual(pair(view), [4, 7], "收缩到第2行");
  assert.equal(extendLineSelection(view, -1, 1), true);
  assert.deepEqual(pair(view), [4, 7], "仍停在第2行，不收成光标");
});

test("向上拖出来的选区：Shift+↑ 继续向上扩展，head 落在上一行行首", () => {
  const view = makeView(makeState([[11, 4]])); // 第2–3行，anchor 在下、head 在上
  assert.equal(extendLineSelection(view, -1, 1), true);
  assert.deepEqual(pair(view), [11, 0], "head 扩到第1行行首");
});

test("不是整行选区时命令返回 false，交回原生按键", () => {
  let state = EditorState.create({
    doc: DOC,
    extensions: [lineSelectionField, lineSelectionGutterClass],
  });
  state = state.update({ selection: EditorSelection.create([EditorSelection.range(4, 6)]) }).state;
  const view = makeView(state);
  assert.equal(extendLineSelection(view, 1, 1), false, "普通文本选择不接管 Shift+↓");
  assert.equal(deleteTrackedLineSelection(view), false, "普通文本选择不接管 Backspace");
  assert.equal(cutTrackedLineSelection(view), false, "普通文本选择不接管剪切");
});

test("Backspace/Delete 补偿：整行选区多删末尾一个换行，不留空行", () => {
  const view = makeView(makeState([[4, 11]])); // 第2–3行
  assert.equal(deleteTrackedLineSelection(view), true);
  assert.equal(view.state.doc.toString(), "aaa\nddd\neee", "第2–3行整行删除");
  assert.deepEqual(pair(view), [4, 4], "光标停在删除处");
});

test("已含换行的选区（includeEOL 单击）不再重复补偿", () => {
  const view = makeView(makeState([[4, 12]])); // 终点在第4行行首
  assert.equal(deleteTrackedLineSelection(view), false);
  assert.equal(view.state.doc.toString(), DOC, "交回原生删除，测试里没人按，文档不变");
});

test("Ctrl/Cmd+X：先把补偿后的文本写进剪贴板，再删除", async () => {
  const written = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    },
  });
  try {
    const view = makeView(makeState([[4, 11]])); // 第2–3行
    assert.equal(cutTrackedLineSelection(view), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(written, ["bbb\nccc\n"], "剪贴板内容带行尾换行，粘贴出去仍是整行");
    assert.equal(view.state.doc.toString(), "aaa\nddd\neee", "剪切后不留空行");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("没有 navigator.clipboard 时剪切交回原生，不删内容", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    const view = makeView(makeState([[4, 11]]));
    assert.equal(cutTrackedLineSelection(view), false);
    assert.equal(view.state.doc.toString(), DOC);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("pageRowStep：按一屏高度换算 PageUp/PageDown 步长", () => {
  const view = makeView(makeState([[4, 11]]));
  assert.equal(pageRowStep(view), 19, "400px / 20px 行高 - 1 = 19");
});
