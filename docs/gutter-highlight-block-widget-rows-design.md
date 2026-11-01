# 行号栏高亮补齐 block widget 行（表格 / 嵌入块 / 折叠块）—— 设计文档

> 现象：表格所在行被选中时行号栏没有高亮。本文记录根因证据、修复决策与验证结果。

## 现象

用户原话：“表格所在行选中时行号栏没有高亮”。

Live Preview 里，表格在行号栏上占的是一段**空白**（没有行号数字）。用行号区单击 / 拖动选中表格所在的行时，行号栏不出现 `.cm-lds-selected` 高亮；跨表格拖选时，高亮在表格那一段**断成两截**（表格上方亮、表格下方也亮，中间空着）。单独选中表格所在行时，行号栏没有任何高亮。

## 根因（已用真实 CM6 复现验证，不是推测）

1. **Obsidian 的表格是 block widget**：1.14.5 的 `app.js` 里，表格渲染器（`oU`，容器 class 为 `cm-embed-block cm-table-widget markdown-rendered`）用 `Decoration.replace({ widget, side: 1, block: true }, Y, X)` 把表格源码行**整体替换**。嵌入块、代码块预览、折叠内容同理。
2. **CM6 的 gutter 不把 `gutterLineClass` 用在 widget 行块上**：`@codemirror/view`（6.43.13 的 `gutterView.syncGutters`）遍历 `viewportLineBlocks`，只有 `BlockType.Text` 行块走 `cx.line()` 并消费 `gutterLineClass`；遇到 widget 行块走 `cx.widget()`，只问该 gutter 的 `widgetMarker`——内置行号列内部问的是 `lineNumberWidgetMarker` facet（`lineNumberGutter.widgetMarker`）。
3. **Obsidian 没有给 widget 行块提供行号元素**：`app.js` 里 `lineNumberWidgetMarker` 只出现在 CM6 导出映射中，没有任何调用点；`gutterWidgetClass` 同样没有使用。所以原生行号列对 widget 行块**根本不生成 `.cm-gutterElement`**（只有前后文本行的元素靠 `margin-top` 空出表格高度），行号栏自然没有东西可以被点亮。
4. **实测（Chrome headless + 真实 CM6 + 复刻 Obsidian 的 block widget）**：7 行文档、第 3–5 行被一个 120px 的 block widget（`cm-embed-block cm-table-widget`）替换。选中第 1–6 行时行号栏只有 `1`、`2`、`6` 三个元素被点亮，widget 那 120px 是断的；单独选中表格块时点亮元素数 = **0**。修复后同一场景点亮 4 个元素：`1`、`2`、一个 `top=57 / height=120` 的空白元素、`6`，背景色与文本行完全一致；未选中时元素数回到 5，不多出空白元素。

## 决策 1：widget 行块用 `lineNumberWidgetMarker` 补一个“空白高亮元素”

给被整行选区覆盖的 widget 行块返回一个**不带数字**的 `GutterMarker`（`elementClass = "cm-lds-selected"`），接进 `lineNumberWidgetMarker` facet。CM6 的 `addElement` 会用该 block 的 `height` 生成等高的 `.cm-gutterElement`，于是行号栏上得到一段与文本行同色的连续高亮。

- 未选中时返回 `null`：Obsidian 原本“widget 旁边不显示行号”的外观不变，也不会多出空白元素。
- 不补数字：表格块跨多行，补“首行行号”会让行号序列出现跳号（如 2 之后直接 6），属于本次需求之外的外观变更。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **A. `lineNumberWidgetMarker` 补空白高亮元素**（选中） | good | good | good | good |
| B. `gutterWidgetClass` facet | mixed | good | mixed | good |
| C. 补带数字的 marker | mixed | good | mixed | mixed |
| D. ViewPlugin 手动改 gutter DOM | poor | mixed | poor | poor |

被否掉的选项：**B** 会对**所有** gutter（折叠箭头列等）都注入元素，副作用面比需求大；**C** 改变原生行号显示的既有外观；**D** 绕开 CM6 的 gutter 生命周期，滚动 / 重排时容易错位。

## 决策 2：own（自绘行号列）模式给自家 gutter 配同一个 `widgetMarker`

自绘行号列不是 CM6 内置的 `lineNumbers()`，`lineNumberWidgetMarker` facet 管不到它，所以在 `ownLineNumbers` 的 gutter 配置里直接写 `widgetMarker: widgetSelectionMarker`，行为与原生列一致。

## 实现规格（已落地到 `main.js`）

```js
/** 块级 widget（表格 / 嵌入块 / 折叠块）是否被整行选区整体覆盖 */
function blockCoveredByRanges(state, ranges, block) {
  if (!block || block.to <= block.from) return false;
  const first = state.doc.lineAt(block.from).from;
  const last = state.doc.lineAt(block.to - 1).from; // to 可能落在新行行首，减一落回真正覆盖的末行
  return ranges.some((range) => range.from <= first && range.to > last);
}

/** 被选中的 widget 行块 -> 不带数字的高亮 marker；未选中 -> null */
function widgetSelectionMarker(view, _widget, block) {
  const value = view.state.field(lineSelectionField, false);
  if (!value || !block) return null;
  return blockCoveredByRanges(view.state, value.ranges, block) ? new SelectedLineMarker() : null;
}

// 内置行号列（Obsidian 原生）走 facet；老版本 CM6 没有该 facet 时优雅降级
const lineSelectionWidgetMarker = lineNumberWidgetMarker
  ? lineNumberWidgetMarker.of(widgetSelectionMarker)
  : [];

// 自绘行号列：直接配给本 gutter
gutter({
  class: "cm-lineNumbers cm-lds-own",
  lineMarker: ...,
  widgetMarker: widgetSelectionMarker,
  ...
});
```

**配色 / CSS 不变**：复用 `.cm-lds-selected`（`var(--text-selection)`），只染 `.cm-lineNumbers` 列。

**刷新时机（为什么不用额外的更新通道）**：widget marker 每次 `syncGutters` 时被重新询问。`lineSelectionGutterClass` 仍会为 widget 内的每个源码行生成 marker（它们落在 widget 块内部，虽不产生元素，但会让 `gutterLineClass` 的 RangeSet 变化），CM6 的 `updateGutters` 检测到 facet 变化就会重跑 `syncGutters`。实测在“文字行 → 跨表格 → 只选表格 → 清空”之间切换，行号栏元素数在 5 / 6 之间正确增减，没有残留高亮。

## 已验证的事实

1. `@codemirror/view` 6.43.13 `gutterView.syncGutters`：`BlockType.Text` → `cx.line()`（消费 `gutterLineClass`）；`line.widget` → `cx.widget()`（只问 `widgetMarker`）。
2. Obsidian 1.14.5 `app.js`：表格 block widget 用 `block: true` 的 replace decoration；`lineNumberWidgetMarker` / `gutterWidgetClass` 均无调用点。
3. Chrome headless 实测（7 行文档，第 3–5 行为 120px widget）：修复前选中跨表格行只亮 1/2/6 三个元素、表格区间断开，单独选表格块点亮 0 个；修复后点亮 1/2/空白(120px)/6 四个元素，`own` 模式结果一致；未选中时无多余元素。
4. `npm test` 36 条用例全绿（新增 `blockCoveredByRanges`、`widgetSelectionMarker` 与两种模式的 facet 装配用例），`npm run typecheck` 通过。

## 风险

- **老版本 CM6 没有 `lineNumberWidgetMarker`**：已用 `lineNumberWidgetMarker ? ... : []` 守卫，降级为“widget 行块不高亮”，不抛错、不影响其它功能。
- **与其它 gutter 插件共存**：只影响内置行号列（和自绘列），不会向折叠箭头等 gutter 注入元素——这正是没有选 `gutterWidgetClass` 的原因。
- **刷新依赖 `gutterLineClass` 变化**：如果将来逐行高亮改走别的通道（例如不再为 widget 内部行生成 marker），widget 行块高亮可能不再自动刷新；`main.js` §4 的注释已记录这一耦合。
- **超高 widget**（高度大于一屏）：元素高度等于 block 高度，由 CM6 正常定位；真机滚动验收需覆盖长表格。

## 真机验收清单

1. Live Preview 下单击表格所在行的行号 → 整块表格被选中，行号栏整段高亮；
2. 从表格上方拖到下方 → 高亮连续、不再断开；
3. 只选表格（上下不挨文字行）→ 整段高亮；
4. 选中后点击正文清空 → 高亮消失，且行号列 DOM 不再保留空白元素；
5. 图片 / 嵌入块（`![[note]]`）/ 代码块预览 / 折叠块等其它 block widget 行同理；
6. hook 与 own 两种行号模式结果一致；
7. 老版本 Obsidian（无该 facet）下插件不报错、其它功能正常。
