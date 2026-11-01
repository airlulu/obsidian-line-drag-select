# 行号区拖动多选：下界严格按行 + 行号栏高亮 —— 设计文档

> 原型：[selection-lower-bound-and-gutter-highlight-visual.html](selection-lower-bound-and-gutter-highlight-visual.html)

拖动行号区选行时，选区下界目前停在“末尾行行末 + 1”，也就是下一行的行首：CM6 会在选区 head 处画光标，用户于是看到下界落在末尾行下一行的行头；同时行号栏的高亮只点亮按下那一行（而且松手即消失），与“选中行都该亮”的直觉不符。本次把整行选区的终点改为**严格落在末尾行行末**（空行例外吞换行），并让行号栏高亮**由行号区产生的整行选区驱动**、覆盖每一行、松手后保留；为了不让“严格行尾”破坏整行删除，又接管了 Shift+方向键的按行扩展与 Backspace/Delete/剪切时的一个换行补偿。

实现状态：已落地到 `main.js`（纯函数 + 高亮字段 + 三条键盘命令），`tests/selection.test.js`（纯函数 / 高亮状态）与 `tests/commands.test.js`（Shift 扩展、删除、剪切）覆盖上述规则，`npm test` 33 条用例全绿，`npm run typecheck` 通过。

## 术语

- **行号栏**：编辑器左侧显示行号的那一列（CM6 的 `.cm-gutters` / `.cm-lineNumbers`）。本插件的交互都从这里发起。**避免**：侧边栏、边栏。
- **整行选区**：由行号栏点击 / 拖动 / Shift 点击 / Ctrl（Cmd）点击产生、按视觉行块对齐的选区。**避免**：多选区、块选择。
- **下界**：整行选区的终点（选区 head），拖动时跟随鼠标所在行；本次改成严格落在末尾行行末。**避免**：末端、末尾。
- **视觉行块**：CM6 的 `BlockInfo`，折叠标题、嵌入块、软换行都算一个块，也就是用户在行号栏上看到的一“行”。**避免**：逻辑行、物理行。
- **严格行尾**：整行选区的终点取末尾行行块的 `to`，不吞行尾换行符。**避免**：行尾、紧贴行末。
- **整行删除补偿**：在严格行尾的选区上执行删除 / 剪切时，额外多删末尾一个换行符（只在末尾确实是换行时）。**避免**：补删、多删。

## 为什么

用户原话：“1、选中区域下界目前会定位到末尾行下一行的行头，需要严格按照鼠标拖动的行号进行选中；2、选中行的行号栏也应该高亮，与单行选中状态保持一致。”

现状的机制是：`rangeForDrag` 用 `blockEnd()` 作为终点，`blockEnd = block.to + 1`（当 `includeEOL` 为真且不是文末），所以向下拖到第 6 行时选区终点 = 第 7 行行首，CM6 的选区绘制会在 head 处画光标，下界就“越”到了下一行行头；而行号栏高亮是用 `RangeSet.of([marker.range(from, to)])` 放进 `gutterLineClass`，CM6 的 gutter 逐行只认“行首 point marker”，跨行 range 只在 `range.from` 那一行命中，于是只有按下那一行被点亮，`pointerup` 又立刻把 `dragHighlightField` 清空。两处都让“选中的行”和“看见的行”对不上。

## 锁定的决策

### 决策 1：整行选区的下界统一为“严格行尾”（含后来补齐的补偿）

拖动、单击、Shift 点击产生的整行选区，终点一律落在**末尾行行末**；空行例外（见“实现规格”）。`includeEOL` 保留为设置项、默认改为关闭，并且只影响单击 / Shift（见决策 3）。之后按决策 4、5 补上了“Shift+方向键按行扩展”和“删除 / 剪切补偿”。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **B. 统一严格行尾**（选中，后补决策 4/5） | mixed | good | mixed | good |
| A. 只改拖动 | mixed | mixed | good | good |
| C. 严格行尾 + 补偿 | good | mixed | mixed | good |
| D. 保留含换行，只做视觉修复 | mixed | good | mixed | good |

被否掉的选项：**A** 只改拖动会让单击与拖动出现两套复制/删除语义（点一行后 Backspace 删整行，拖几行后 Backspace 留空行），用户分不清；**C** 在当轮被否是因为补偿范围最大，但决策 4/5 先后把它的两项补偿补了回来，所以最终形态其实等于 C；**D** 只是把下一行行头的光标藏起来，选区端点仍在下一行行头（程序读选区、Shift 微调都会露馅），治标不治本。

### 决策 2：行号栏高亮由“行号区产生的整行选区”驱动，松手后保留

高亮只对行号区自己产生的整行选区生效：拖动、单击、Shift 点击、Ctrl（Cmd）点击追加的每个选区都算；内容区里随手拖的文本选择、Ctrl+A 不点亮行号。高亮在 `pointerup` 之后继续保留，随选区变化而更新，直到选区被其它来源的事务改掉为止。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **A. 行号区整行选区驱动、保留**（选中） | good | good | good | good |
| B. 任意跨行选区驱动 | mixed | mixed | good | good |
| C. 只在拖动过程中亮 | poor | mixed | good | good |

被否掉的选项：**B** 最省事，但 Ctrl+A、普通文本跨行选择都会把整列行号点亮，视觉噪声大且会让“行号栏高亮”失去“这是行号区选区”的语义；**C** 松手即灭，等于“选中了却没有选中反馈”，与需求 2 直接冲突。

### 决策 3：`includeEOL` 只影响单击 / Shift，拖动永远严格行尾

开关打开后，单击整行 / Shift 点击的目标行仍然吞掉行尾换行符（保留“点一行后一键删整行”的能力）；但拖动在任何配置下都严格行尾，避免用户打开开关后，刚修好的下界问题在拖动里复发。开关的默认值从 `true` 改为 `false`。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **B. 只对单击 / Shift 生效**（选中） | good | mixed | good | good |
| A. 全局生效 | mixed | good | good | good |

被否掉的选项：**A** 更可预期，但只要打开开关，拖动就回到“终点在下一行行头”的旧行为——那正是这次要修的问题，等于给用户埋了一个会复现的开关。

### 决策 4：接管 Shift+↑/↓（含 PageUp/PageDown），继续按整行扩展，高亮跟随

严格行尾后，松手时 head 停在末尾行行末，CM6 原生的 Shift+↓ 会按列移动，选区不再是整行对齐。插件接管这四个组合键：当当前选区是“行号区整行选区”时，按视觉行块整行扩展 / 收缩，head 用严格行尾规则落位；高亮跟着新选区走。不是整行选区时一律不拦截，交给原生。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **A. 接管，按整行扩展**（选中） | good | mixed | mixed | good |
| B. 不接管，逐字扩展并清高亮 | mixed | good | good | good |
| C. 不接管，高亮按覆盖行继续亮 | mixed | mixed | good | good |

被否掉的选项：**B** 改动最小，但拖完想再扩一行就变成“扩到下一行同一列”，与 VS Code 手感差一截；**C** 选区已经不是严格整行了还继续亮行号，会让“高亮 = 整行选区”的规则失真，用户会怀疑高亮乱闪。

### 决策 5：Backspace / Delete / Ctrl（Cmd）+X 对整行选区做“多删一个换行”的补偿

严格行尾意味着拖选第 3–6 行后按 Backspace / 剪切只会清空内容、留下一个空行，而“拖选几行然后整行删掉 / 剪走”是最常用场景。补偿只对**行号区产生的、末尾正好落在行末**的整行选区生效：执行删除 / 剪切时把末尾扩一个换行符；已经在下一行行首的选区（`includeEOL` 打开时的单击）不会重复补偿。

| 选项 | ux | correct | risk | cost |
| --- | --- | --- | --- | --- |
| **A. 补全（Backspace / Delete / 剪切）**（选中） | good | mixed | mixed | good |
| B. 不补，记为已知限制 | poor | good | good | good |
| C. 只补 Backspace / Delete | mixed | mixed | good | good |

被否掉的选项：**B** 每天都会在文末留下一个空行，等于把“整行删除”彻底让出去；**C** 只补一半，剪切仍然漏空行，用户会认为补偿没做完。

## 常规选择

- **高亮视觉**：沿用 `styles.css` 里现有的 `.cm-lds-selected`（背景取 `var(--text-selection)`），单行与多行完全一致，不加新颜色、不加设置项；主题里的选择色变化时自动跟随。
- **空行例外**：终点落在空行（`block.from === block.to`）时吞掉它的换行符，保证空行选区可见、可整行删除；文首空行、连续空行、文末空行（无换行可吞）都要覆盖。否则空行是零宽选区，按 Backspace 会删掉上一行的换行、把两行并一行。
- **两种行号模式行为一致**：hook（复用原生行号列）与 own（自绘行号列）共用同一套选区、高亮和命令，`ownLineNumbers` 只负责画数字。
- **拖拽中的 anchor 行即时高亮**：按下即选中整行，高亮由选区驱动，按下那一行立刻亮，随后随拖动扩展。
- **Esc 回滚**：拖拽中按 Esc 仍回滚到按下前的选区；若回滚后的选区也是整行选区，高亮按同一规则显示，否则清除。
- **自动滚动**：滚动后重算行块并扩展选区，高亮随选区更新；不给滚动单独开高亮路径。

## 已验证的事实（不是推测）

1. `main.js` 的 `blockEnd()`（约 L89–91）返回 `block.to + 1`（`includeEOL` 为真且 `block.to < doc.length` 时），`rangeForDrag`（约 L117–122）用它作终点；这是“下界落在下一行行头”的直接来源。
2. CM6 的 `gutterLineClass` 逐行只收集“行首 marker”：`@codemirror/view` 的 `advanceCursor`（dist 约 L11598–11604）只在 `cursor.from == line.from` 时把 marker 收进该行；`activeLineGutterHighlighter`（约 L11861–11871）也因此每行单独 `marker.range(line.from)`。实测 `RangeSet.of([marker.range(4, 16)])` 只在第 4 位置那一行命中（`GutterMarker.point = true` 也不能让它按行铺开）。
3. `endDrag()`（约 L389–403）在 `pointerup` 时 dispatch `setDragHighlight.of(null)`，所以拖拽结束高亮立即消失。
4. CM6 的选区绘制在非空选区的 head 处画光标（`drawSelection` 的 `drawRangeCursor` 默认 `true`，`.cm-cursor` 在聚焦的 cursorLayer 里可见）；这是用户看到“下界在下一行行头”的可见来源。
5. 内容区的选区蓝底本身不会铺到下一行：`rectanglesForRange`（dist 约 L9380–9410）用 `blockAt(to, -1)` 取**上一行**行块画末段，所以越界的只是光标 / 行号栏那一侧的观感。
6. Obsidian 没有启用活动行行号高亮：内置 `obsidian.asar/app.js` 里 `highlightActiveLineGutter` 只出现在导出映射中、没有任何调用点，`app.css` 也没有 `activeLine` 规则。所以“单行选中时的行号高亮”实际来自插件自己的 `.cm-lds-selected`，把多行也点亮就能与单行一致。
7. 用户测试库的设置：`showLineNumber: true`、`cssTheme: Blue Topaz`、`theme: moonstone`；插件默认 `includeEOL` 已在本次实现中改为 `false`。测试库 `E:\知识库_公司\.obsidian\plugins\obsidian-line-drag-select` 里装的仍是旧的 esbuild 版本，验收前需要把本项目零构建版 `main.js` 部署进去。

## 实现规格（可直接照此落地）

纯逻辑全部放 `main.js` §2，并以 `__test` 导出，便于在 Node 里单测。

```
// 严格行尾 + 空行例外
function selectionEnd(state, block) {
  if (block.to === block.from) return block.to < state.doc.length ? block.to + 1 : block.to;
  return block.to;
}

rangeForLine(state, block, opts)  = EditorSelection.range(block.from,
                                    opts.includeEOL ? blockEnd(state, block, opts) : selectionEnd(state, block))
rangeForDrag(state, anchor, current, opts)  // 忽略 includeEOL，永远严格
  = current.from >= anchor.from
      ? EditorSelection.range(anchor.from, selectionEnd(state, current))
      : EditorSelection.range(selectionEnd(state, anchor), current.from)
rangeForShift(state, anchorPos, block, opts)  // includeEOL 只影响“目标行在锚点之后”的末端
  = anchorPos <= block.from
      ? EditorSelection.range(anchorPos, opts.includeEOL ? blockEnd(state, block, opts) : selectionEnd(state, block))
      : EditorSelection.range(anchorPos, block.from)
```

**行号栏高亮**（替换 `dragHighlightField` + `dragHighlightGutterClass`）：

- 新状态：`Annotation.define()` 的 `gutterSelection`，以及 `lineSelectionField`（值：`{from,to}[] | null`）。
- 插件所有产生 / 扩展整行选区的事务都带 `annotations: gutterSelection.of(true)`；字段 `update` 规则：带 annotation → 写入新选区区间；`tr.docChanged` → 清空（宁可不亮也不错亮）；`tr.selection` 但无 annotation → 清空；其余事务保留。
- `gutterLineClass.compute([lineSelectionField], ...)`：对字段里的每个区间，从 `lineAt(from)` 起逐行收集，**只收集 `line.from < to` 的行**（这样 `includeEOL` 打开时终点在下一行行首也不会点亮下一行），为每行 `marker.range(line.from)` 建 point marker；零宽区间（文末空行单击）按 `lineAt(from)` 单行点亮。
- 高亮 class 与颜色不变（`.cm-lds-selected`，`var(--text-selection)`），只在 `styles.css` 里把选择器收窄到 `.cm-lineNumbers`（避免把折叠箭头列也染色）。

**Shift 扩展**（新 keymap，`Prec.highest`，命令返回 `false` 时交回原生）：

- 触发条件：主选区是“行号区整行选区”（`lineSelectionField` 非空），且当前按的是 Shift+↑/↓ 或 Shift+PageUp/PageDown；否则返回 `false`。
- 向下：从 head 所在视觉行块出发，head 在块尾时取 `block.to + 1` 处的块，否则取当前块；新 head = `selectionEnd(state, targetBlock)`。
- 向上：head 在块首时取 `block.from - 1` 处的块，否则取当前块；新 head = `targetBlock.from`。
- PageUp/PageDown：重复上面的单步直到竖直位移覆盖一屏（`scrollDOM.clientHeight`）或到达文档首尾。
- anchor 保持 `state.selection.main.anchor`，其它 range 原样保留，dispatch 时带 `gutterSelection` annotation 与 `userEvent: "select.keyboard"`。

**删除 / 剪切补偿**（新 keymap，`Prec.highest`）：

```
extendedTo(state, range):
  若 range 不属于整行选区 → 不补偿
  若 range.to >= state.doc.length → 不补偿（文末没有换行可多删）
  若 doc.lineAt(range.to).from === range.to && range.to > range.from → 已含换行（includeEOL 单击），不补偿
  若 doc.lineAt(range.to).to === range.to → 返回 range.to + 1
  否则不补偿
```

- Backspace / Delete：把每个 range 的 `to` 扩成 `extendedTo` 后按多选区删除（`changeByRange` 返回新光标），带 `userEvent: "delete"`。
- Ctrl（Cmd）+X：先把各 range 的文本（补偿后的区间）按 CM6 的做法用换行连接写入剪贴板（`navigator.clipboard.writeText`，失败则退回原生剪切、不补偿），再执行同样的删除。
- 只要选区里有一个 range 不是整行选区（例如用户自己拼的混合选区），整次按键都交回原生行为，避免误删。

**设置项**：`includeEOL` 默认 `false`；名称 / 描述改成“单击 / Shift 整行选区是否包含行尾换行符（拖动始终严格行尾）”。不新增“高亮开关”。

**文件改动点**：`main.js` §2（纯函数）、§4（高亮字段 / gutterLineClass）、§5（拖拽状态机）、§5-B（键盘命令）、§7（扩展装配）、§9（设置面板文案）；`styles.css` 只把高亮选择器收窄到 `.cm-lineNumbers`（不染折叠箭头列）；`tests/selection.test.js`、`tests/commands.test.js`（新增）与 `tests/plugin-onload.test.js` 同步更新；`docs/prd/20261101_Obsidian行号区拖动多选插件-设计方案.md` 的交互矩阵、样例与 `includeEOL` 说明同步改掉。

**新增单测**：`tests/selection.test.js` 覆盖非末行向下拖 / 向上拖的严格终点、`includeEOL` 开 / 关的单击与 Shift、空行（文首 / 中间 / 文末）例外、`rowSpan` 与 `gutterLineStarts`（含“终点在下一行行首时不多亮一行”、零宽空行的行首 marker）、`extendRowSpan` 的收缩与首尾钳制、`extendedDeleteEnd` 的补偿 / 不补偿分支，以及高亮字段的“插件事务点亮、其它来源失效”行为；`tests/commands.test.js` 用最小假 view 驱动真实命令，覆盖 Shift 按行扩展 / 收缩、Backspace 整行删除补偿、Ctrl+X 的剪贴板文本与删除、无 clipboard 时交回原生、页步长换算。

**真机验收清单**：向下 / 向上拖动、单击、Shift+点击、Ctrl（Cmd）+点击多选区；空行（文首 / 连续 / 文末）；末行、只有空行的文档；折叠标题块与嵌入块；拖到边缘自动滚动；Esc 回滚；Backspace / Delete / Ctrl+X（单选区与多选区、文末、`includeEOL` 开 / 关）；hook 与 own 两种行号模式；万行文档拖动手感。

## 风险

- **补偿路径是本设计最危险的部分**：Backspace / Delete / Ctrl+X 三条路径被插件接管后，任何边界判断错误都会变成“多删一行 / 少删一行”；纯函数单测只能覆盖选区数学，剪贴板与真实按键必须真机逐条验收。
- **Shift 键接管**可能与其它插件（Vim、多光标、表格编辑器）抢键；只在“行号区整行选区”存在时拦截、其余返回 `false`，是唯一安全的降级方式，仍需实测共存。
- **默认值翻转**（`includeEOL: true → false`）会改变已有用户（包括测试库）的整行删除手感；想让旧行为回来需要手动打开开关，而开关对拖动无效（决策 3），文档与设置文案必须写清。
- **“整行选区”来源标记**依赖事务 annotation：撤销 / 重做、外部插件改选区、切换笔记后标记必须失效（本设计选择任何非插件选区事务都清空），否则会出现“没选中却一直亮”的假高亮。
- **空行例外**让“严格行尾”多了一条规则，文首空行、连续空行、文末空行都要单独测；文末空行没有换行可吞，选区仍是零宽。
- **选区严格行尾后，`includeEOL` 打开时单击单行的下界仍会落在下一行行头**——这是开关语义的一部分（保留整行删除能力），接受该取舍；若用户抱怨，再讨论把开关拆成“单击含换行 / 拖动含换行”两个开关。
- 高亮重算频率：每次选区变化重建一次 RangeSet（按行数，通常几行到几百行），忽略不计；万行文档整体 Ctrl+A 不在高亮范围（决策 2），不会造成性能问题。

## 待定（Deferred）

- **复制时补尾随换行**：决策 1 之后拖动选区复制不带行尾换行（粘贴不会多出空行），若有人希望“复制出来一定以换行结尾”，需要另做剪贴板输出过滤；出现真实抱怨时再开。
- **高亮开关 / 自定义颜色**：本轮沿用选区色、不加设置；等有主题适配投诉再开。
- **Alt 列选择（矩形选择）**、**移动端长按拖动**：沿用 PRD 里的 P2 定位，本次不碰。
- **中键 / 双击行号栏选全段**：未讨论，属于新交互，另行提案。

## 未收敛的讨论

无：本轮讨论的每个分支都已落到上面的决策或待定项。
