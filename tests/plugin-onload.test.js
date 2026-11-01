"use strict";

/**
 * 插件生命周期冒烟测试：不依赖 Obsidian，也不依赖真实 DOM。
 *
 * 做法：
 *   1. 先把 "obsidian" 的模块解析重定向到 tests/stubs/obsidian.js（Obsidian API 只能在
 *      Obsidian 进程里用，而且插件会 extends Plugin / PluginSettingTab）。
 *   2. 在 require main.js 之前装最小 global document / window：插件的 onload/onunload
 *      会碰 `document.body.classList`，拖拽状态机里还有 window 事件监听（生命周期测试
 *      本身不会真正触发拖拽，只保证代码路径可执行）。
 *   3. `@codemirror/state` 用真实安装包；`@codemirror/view` 也是真实安装包。
 *      注意：view 在模块顶层会做特性检测，缺 `document` 时它自带
 *      `{documentElement: {style: {}}}` 兜底，但一旦我们提供了不完整的 `document`
 *      全局（例如少了 `documentElement`），它就会在读取 `.style` 时抛错。
 *      所以下面的 shim 必须带 `documentElement`。因此
 *      `EditorState.create({extensions: plugin.build()})` 是对真实 CM6 扩展装配的验证，
 *      而不是对着假对象自说自话。
 *
 * 这里只做「装配 + 不抛错 + 关键注册项存在」级验证，不渲染 View。
 */

const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { test } = require("node:test");

/* ------------------------------------------------------------------ *
 * 1. 最小 DOM 全局桩（在 require main.js 之前装好）
 * ------------------------------------------------------------------ */

function makeClassList() {
  const calls = { toggle: [], add: [], remove: [] };
  return {
    calls,
    toggle(name, force) {
      calls.toggle.push([name, force]);
    },
    add(name) {
      calls.add.push(name);
    },
    remove(name) {
      calls.remove.push(name);
    },
    contains() {
      return false;
    },
  };
}

/** 只实现「不抛错」所需的最少 DOM 元素接口。 */
function makeElement(tagName) {
  const el = {
    tagName: String(tagName || "").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    classList: makeClassList(),
    textContent: "",
    setAttribute(name, value) {
      el.attributes[name] = value;
      return el;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name)
        ? el.attributes[name]
        : null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setText(text) {
      el.textContent = String(text);
      return el;
    },
    addClass() {
      return el;
    },
    createEl(childTag) {
      const child = makeElement(childTag);
      el.children.push(child);
      return child;
    },
    empty() {
      el.children.length = 0;
      return el;
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    focus() {},
  };
  return el;
}

const bodyClassList = makeClassList();
const bodyEl = makeElement("body");
bodyEl.classList = bodyClassList;

globalThis.document = {
  // 真实 @codemirror/view 在模块顶层会读 document.documentElement.style 做特性检测
  documentElement: makeElement("html"),
  body: bodyEl,
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
// main.js 的拖拽状态机里用的是裸 requestAnimationFrame / cancelAnimationFrame。
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;

/* ------------------------------------------------------------------ *
 * 2. 只 stub "obsidian"，其余（含 @codemirror/*）用真实包
 * ------------------------------------------------------------------ */

const OBSIDIAN_STUB = path.join(__dirname, "stubs", "obsidian.js");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (request === "obsidian") return OBSIDIAN_STUB;
  return originalResolveFilename.call(this, request, ...rest);
};

const pluginModule = require("../main.js");
const { EditorState } = require("@codemirror/state");

const PluginClass = (pluginModule && pluginModule.default) || pluginModule;

/**
 * 构造一个「无活动编辑器、无 markdown 叶子」的假 App。
 * （行号模式检查 / reportGutterState / reconfigureAll 的空路径都走这里。）
 */
function createPlugin() {
  const app = {
    workspace: {
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
    },
  };
  const manifest = {
    id: "line-drag-select",
    name: "Line Drag Select",
    version: "0.1.0",
    minAppVersion: "1.0.0",
  };
  return new PluginClass(app, manifest);
}

function findCommand(plugin, id) {
  return plugin.commands.find((command) => command.id === id);
}

/* ------------------------------------------------------------------ *
 * 3. 生命周期测试
 * ------------------------------------------------------------------ */

test("插件类可实例化，onload 注册 CM6 扩展 / 设置页 / 检查行号命令且不抛错", async () => {
  assert.equal(typeof PluginClass, "function", "默认导出应是插件构造函数");
  const plugin = createPlugin();
  assert.equal(plugin.app.workspace !== undefined, true, "插件实例应拿到 fakeApp");
  assert.equal(plugin.manifest.id, "line-drag-select", "插件实例应拿到 manifest");

  await assert.doesNotReject(() => plugin.onload(), "plugin.onload() 不应抛错");

  assert.equal(plugin.registeredEditorExtensions.length, 1, "应注册 1 个 editor extension");
  assert.notEqual(plugin.registeredEditorExtensions[0], undefined, "注册的扩展不应为 undefined");

  assert.equal(plugin.settingTabs.length, 1, "应注册 1 个设置页");
  const tab = plugin.settingTabs[0];
  assert.equal(typeof tab.display, "function", "设置页实例应有 display()");
  assert.ok(tab.containerEl, "设置页实例应有 containerEl");

  const command = findCommand(plugin, "check-line-numbers");
  assert.ok(command, '应注册 id 为 "check-line-numbers" 的命令');
  assert.equal(typeof command.callback, "function", "命令应有 callback");
  assert.doesNotThrow(() => command.callback(), "检查行号命令回调不应抛错");

  assert.deepEqual(
    { ...plugin.settings },
    { gutterMode: "hook", includeEOL: true, autoScroll: true },
    "loadSettings 应把默认配置合并进 plugin.settings"
  );
});

test("syncBodyClass / reportGutterState / onunload：无活动视图时安全且 body class 正确", async () => {
  const plugin = createPlugin();
  await plugin.onload();

  const before = bodyClassList.calls.toggle.length;
  assert.doesNotThrow(() => plugin.syncBodyClass(), "syncBodyClass() 不应抛错");
  assert.deepEqual(
    bodyClassList.calls.toggle.slice(before),
    [["lds-own-gutter", false]],
    "默认 hook 模式下 syncBodyClass 应把 lds-own-gutter 设为 false"
  );

  plugin.settings.gutterMode = "own";
  assert.doesNotThrow(() => plugin.syncBodyClass(), "own 模式下 syncBodyClass() 不应抛错");
  assert.deepEqual(
    bodyClassList.calls.toggle.at(-1),
    ["lds-own-gutter", true],
    "own 模式下 syncBodyClass 应把 lds-own-gutter 设为 true"
  );

  assert.doesNotThrow(
    () => plugin.reportGutterState(),
    "无活动 MarkdownView 时 reportGutterState() 应静默返回"
  );

  assert.doesNotThrow(() => plugin.onunload(), "onunload() 不应抛错");
  assert.ok(
    bodyClassList.calls.remove.includes("lds-own-gutter"),
    "onunload 应移除 lds-own-gutter body class"
  );
});

test("设置面板 display() 在 stub 环境下可完整执行（不抛错）", async () => {
  const plugin = createPlugin();
  await plugin.onload();

  const tab = plugin.settingTabs[0];
  assert.doesNotThrow(() => tab.display(), "设置面板 display() 不应抛错");
});

test("build() 产出真实 CM6 扩展：hook / own 两种行号模式都能被 EditorState 接受", async () => {
  const plugin = createPlugin();
  await plugin.onload();

  for (const mode of ["hook", "own"]) {
    plugin.settings.gutterMode = mode;
    let state;
    assert.doesNotThrow(() => {
      state = EditorState.create({
        doc: "aaa\nbbb\nccc",
        extensions: plugin.build(),
      });
    }, `gutterMode="${mode}" 时 EditorState.create() 不应抛错`);
    assert.equal(state.doc.lines, 3, `gutterMode="${mode}" 时文档应有 3 行`);
    assert.equal(
      state.facet(EditorState.allowMultipleSelections),
      true,
      `gutterMode="${mode}" 时插件扩展应开启 allowMultipleSelections（多选区）`
    );
  }
});
