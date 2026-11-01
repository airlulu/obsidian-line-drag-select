# Line Drag Select（行号区拖动多选）

> Obsidian 插件：在行号区按住鼠标拖动，像 VS Code 一样连续选中整行。
> An Obsidian plugin: drag in the line-number gutter to select whole lines, just like VS Code.

[中文](#中文) · [English](#english)

---

## 中文

### 这是什么

Obsidian 的编辑器（CodeMirror 6）本身不支持「鼠标在行号区拖动选中整行」。本插件补上这一交互：

- **单击行号** → 选中整行
- **按住左键上下拖动** → 以行为单位连续扩展选区
- **拖到编辑器上下边缘** → 笔记自动滚动，可连续选中超出一屏的行
- **Shift + 点击** → 从当前锚点扩展到目标行
- **Ctrl / Cmd + 点击** → 追加或取消一行（多选区）
- **拖动中按 Esc** → 回滚到按下前的选区
- **行号栏高亮** → 被选中的行逐行点亮，松手后保留；表格、嵌入块、折叠块所在的「视觉行」也会整段补亮

技术上有两个刻意的取舍：

1. **零构建**：`main.js` 是手写的 CommonJS 源码，同时就是 Obsidian 直接加载的可执行文件。没有 esbuild / tsc / 打包步骤，改一行源码就是改一行插件行为。
2. **默认零视觉侵入**：默认复用 Obsidian 原生行号列（不接管渲染、与主题天然一致）；如果没开「显示行号」，可切换到插件自绘行号列模式。

### 安装

需要 Obsidian **1.4.0 及以上**。

**从社区插件目录安装**（上架后）：设置 ▸ 第三方插件 ▸ 浏览，搜索 **Line Drag Select**，安装并启用。

**手动安装**：把仓库里的三个文件复制到

```
<Vault>/.obsidian/plugins/line-drag-select/
├── main.js
├── manifest.json
└── styles.css
```

然后在 Obsidian 中打开 设置 ▸ 第三方插件（Community plugins），启用 **Line Drag Select**。

> 不需要 `npm install`，不需要 `npm run build`，也不需要 `main.js` 之外的任何模块：
> `obsidian`、`@codemirror/state`、`@codemirror/view` 三个模块由 Obsidian 运行时注入。

**从源码开发**：克隆仓库后，把整个目录软链/复制到上述插件目录即可；`node_modules` 只服务于单测与类型检查，不会进入插件目录。

### 先用起来：行号显示

默认的「复用原生行号」模式依赖 Obsidian 自身的行号列，请先确认：

**设置 ▸ 编辑器 ▸ 显示行号** 已打开。

如果不想打开系统行号，可在插件设置里把「行号来源」切换为 **自绘行号列**。

启用后如果不确定是否生效，运行命令 **「检查行号是否已开启」**，它会直接告诉你当前状态。

### 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 行号来源 | 复用原生行号 | `复用原生行号`：接管 Obsidian 原生行号列（需先打开「显示行号」）；`自绘行号列`：插件自己画一列，不依赖系统设置 |
| 单击 / Shift 整行时包含行尾换行符 | 关 | 打开后单击 / Shift 产生的整行选区会吞掉行尾换行符，便于一键删整行；**拖动始终严格停在末尾行行末**，不受此项影响 |
| 拖到边缘自动滚动 | 开 | 拖到编辑器上 / 下边缘时笔记跟着滚动，可连续选中超出一屏的行 |

设置变更后会通过 CM6 `Compartment` 热重配到所有已打开的编辑器，无需重载插件。

### 整行选区的键盘语义

拖选出的整行选区一旦建立，插件会接管以下几个按键（只对「行号区产生的整行选区」生效，其它情况交回原生行为）：

| 按键 | 行为 |
| --- | --- |
| `Shift` + `↑` / `↓` | 按整行扩展 / 收缩一行，行号高亮跟随；收缩到锚点那一行就停住，不会塌成光标 |
| `Shift` + `PageUp` / `PageDown` | 同上，步长为一屏可见行数 |
| `Backspace` / `Delete` | 删除整行选区，并额外删掉末尾换行符，避免留下一个空行 |
| `Ctrl/Cmd` + `X` | 剪切整行（剪贴板内容同样带这个换行符） |

选区下界的细节：拖动与整行选区统一采用**严格行尾**（终点停在末尾行行末、不吞换行符），因此光标和选区下界永远落在「鼠标拖到的那一行」，不会越到下一行行头；空行例外（空行会吞掉自己的换行符，否则会得到零宽选区）。`includeEOL` 打开时，只有单击和 Shift 分支吞换行符。

### 项目结构

```
obsidian-line-drag-select/
├── manifest.json        # 插件元信息（id: line-drag-select，minAppVersion 1.4.0）
├── versions.json        # 版本 → minAppVersion 映射（供低版本 Obsidian 回退安装）
├── main.js              # ★ 手写 CommonJS 源码 + Obsidian 直接加载的插件文件（约 1100 行）
├── styles.css           # 自绘模式隐藏原生行号列 + 选中行高亮
├── LICENSE              # MIT 许可证全文（Copyright © 2026 airlulu）
├── package.json         # 仅 devDependencies 与 test / typecheck 脚本
├── tsconfig.json        # 仅做 JSDoc 类型检查（allowJs + checkJs + noEmit）
├── tests/
│   ├── selection.test.js     # 选区纯函数、坐标降级、行号高亮（23 条）
│   ├── commands.test.js      # 键盘命令（9 条）
│   ├── plugin-onload.test.js # 插件装配 / 设置页 / 真实 CM6 扩展冒烟（4 条）
│   └── stubs/obsidian.js     # Node 下的最小 obsidian 桩（CM6 用真实安装包）
├── docs/
│   ├── prd/20261101_Obsidian行号区拖动多选插件-设计方案.md
│   ├── selection-lower-bound-and-gutter-highlight-design.md
│   └── gutter-highlight-block-widget-rows-design.md
└── .github/workflows/release.yml # tag → 发布草稿（attestation + 上传 main.js / manifest.json / styles.css）
```

`main.js` 按 1–10 编号分节：1 配置项与默认值 → 2 选区纯逻辑 → 3 坐标 → 行块（三档降级）→ 4 行号栏高亮 → 5 拖拽状态机（含 5-B 键盘命令）→ 6 两种事件源（6-A / 6-B）→ 7 CM6 扩展工厂 → 8 Plugin 装配 → 9 设置面板 → 10 模块导出。

### 开发

```bash
npm install       # 只安装单测 / 类型检查所需依赖（不参与插件运行）
npm test          # node --test，36 条用例
npm run typecheck # tsc --noEmit，检查 main.js 的 JSDoc 类型
node --check main.js  # 语法检查
```

设计上把**选区计算做成了不依赖 DOM 的纯函数**（`rangeForLine` / `rangeForDrag` / `rangeForShift` / `toggleLineRange` / `extendRowSpan` / `extendedDeleteEnd` 等），所以它们能直接在 Node 里跑单测——这是整套实现里最容易出错、也最值得测试的部分。行定位 `blockAtClientY` 做了三档降级（`lineBlockAtHeight` → `viewportLineBlocks` → `posAtCoords`），以兼容 Obsidian 内置的不同 CM6 版本。

### 实现要点

- **事件源可插拔**：模式 A 在 `view.dom` 上用 capture 阶段监听 `pointerdown`，并用 `closest('.cm-lineNumbers')` 精确限定命中范围（不抢折叠箭头等其它 gutter 列），确定性 `preventDefault + stopPropagation`；模式 B 注册自绘 `gutter({ domEventHandlers })`，事件回调直接拿到 `BlockInfo`。两者共用同一套拖拽状态机与选区算法。
- **只在跨行时 dispatch**：拖动过程中行块没变就不派发事务，避免每像素一次 dispatch。
- **自动滚动**：`requestAnimationFrame` 循环，按超出边缘的距离算滚动增量，滚动后用同一个 `clientY` 重新定位行块（滚动会改变 y 与行的对应关系）再扩展选区。
- **高亮只认插件事务**：用一个 `Annotation` 标记「这是行号区产生的选区」，`StateField` 只接受带标记的选区变化；正文点击、`Ctrl+A`、撤销重做、文档改动都会让高亮立即失效——宁可不亮，也不错亮。
- **block widget 行补高亮**：表格 / 嵌入块 / 折叠块在 Live Preview 里是 block widget，源码行被整体替换、没有文本行块，CM6 的 `gutterLineClass` 落不到它们身上。插件改走 `lineNumberWidgetMarker`（自绘模式则给自家 gutter 配 `widgetMarker`）补一个不带数字的同色高亮元素，且只认「整块被完全覆盖」，未选中时不改变原生外观。

### 已知限制

- 「复用原生行号」模式依赖用户打开 **显示行号**；未打开时插件不会报错，只会表现为「点了没反应」，请用「检查行号是否已开启」命令确认。
- 设置热更新用到 `view.editor.cm`（Obsidian 未公开的 `EditorView` 入口），仅在重配时 try/catch 使用，核心交互不依赖它。
- block widget 行的高亮依赖 CM6 的 `lineNumberWidgetMarker` facet；老版本 CM6 没有这个 facet 时会优雅降级为「只失去这类行的高亮」，其它功能不受影响。
- 移动端（`isDesktopOnly: false`）未针对触摸做专门适配，拖动可能与滚动 / 长按冲突，建议移动端只用单击选行。
- Vim 模式：选区一律通过 `view.dispatch({ selection })` 产生，未做额外适配；与其它 gutter 插件、多光标插件的共存仅做了事件优先级（`Prec.highest`）与命中范围限定。

### 文档

- [可行性分析与设计方案](docs/prd/20261101_Obsidian行号区拖动多选插件-设计方案.md)
- [下界严格按行 + 行号栏高亮设计](docs/selection-lower-bound-and-gutter-highlight-design.md)
- [block widget 行（表格 / 嵌入块 / 折叠块）高亮补齐设计](docs/gutter-highlight-block-widget-rows-design.md)

### 许可

MIT © 2026 airlulu（完整文本见 [LICENSE](LICENSE)）。

---

## English

### What it is

Obsidian's editor (CodeMirror 6) doesn't support dragging in the gutter to select whole lines. This plugin adds that interaction:

- **Click a line number** → select that line
- **Press and drag up/down** → extend the selection line by line
- **Drag past the editor's top/bottom edge** → the note auto-scrolls, so you can keep selecting beyond one screen
- **Shift + click** → extend the selection from the current anchor to the clicked line
- **Ctrl / Cmd + click** → add or remove a line (multiple selections)
- **Esc while dragging** → roll back to the selection from before mouse-down
- **Gutter highlight** → every selected line lights up in the gutter and stays lit after release; "visual lines" occupied by tables, embeds and collapsed blocks are highlighted as a whole block too

Two deliberate trade-offs:

1. **Zero build**: `main.js` is hand-written CommonJS source *and* the executable file Obsidian loads directly. There is no esbuild / tsc / bundling step — editing one line of source changes one line of plugin behavior.
2. **Zero visual footprint by default**: it hooks Obsidian's native line-number gutter (no rendering takeover, native theme integration). If you don't use line numbers, switch to the plugin's own gutter mode.

### Installation

Requires Obsidian **1.4.0 or newer**.

**Install from the community directory** (once published): Settings ▸ Community plugins ▸ Browse, search for **Line Drag Select**, install and enable.

**Manual install** — copy the three files into

```
<Vault>/.obsidian/plugins/line-drag-select/
├── main.js
├── manifest.json
└── styles.css
```

then enable **Line Drag Select** under Settings ▸ Community plugins.

> No `npm install`, no `npm run build`, no module other than `main.js` is needed:
> `obsidian`, `@codemirror/state` and `@codemirror/view` are injected by the Obsidian runtime.

**Developing from source** — clone the repo and symlink/copy the directory into the plugin folder above. `node_modules` only serves unit tests and type checking; it never ships.

### First run: line numbers

The default "native gutter" mode relies on Obsidian's own line-number column. Make sure

**Settings ▸ Editor ▸ Show line number** is enabled.

If you'd rather not enable it, switch **Line number source** to **Plugin-drawn gutter** in the plugin settings.

Unsure whether it's working? Run the command **检查行号是否已开启** ("Check whether line numbers are enabled", id `check-line-numbers`) — it reports the current state.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| Line number source | Native gutter | `Native gutter`: hook Obsidian's own gutter (requires "Show line number"); `Plugin-drawn gutter`: the plugin renders its own column, no system setting needed |
| Include trailing newline on click / Shift | Off | When on, click / Shift line selections swallow the trailing newline, so one keystroke removes the whole line. **Dragging is unaffected** — it always stops strictly at the end of the last line |
| Auto-scroll at edges | On | Scroll the note while dragging past the top/bottom edge, so you can select beyond one screen |

Setting changes are hot-applied to all open editors through a CM6 `Compartment`; no plugin reload needed.

### Keyboard semantics for line selections

Once a line selection created in the gutter exists, the plugin takes over these keys (only for gutter-originated line selections; everything else falls back to native behavior):

| Key | Behavior |
| --- | --- |
| `Shift` + `↑` / `↓` | Extend / shrink the selection by a whole line, keeping the gutter highlight in sync; shrinking stops at the anchor line instead of collapsing to a caret |
| `Shift` + `PageUp` / `PageDown` | Same, stepping by one screenful |
| `Backspace` / `Delete` | Delete the selected lines *including* the trailing newline, so no blank line is left behind |
| `Ctrl/Cmd` + `X` | Cut whole lines (the clipboard text carries that newline too) |

About selection bounds: dragging and line selections use a **strict line end** (the range ends at the end of the last line, without swallowing the newline), so the caret and selection bottom always stay on the line you dragged to and never leak onto the next line's start. Empty lines are the exception (they swallow their own newline, otherwise the range would be zero-width). With `includeEOL` enabled, only the click and Shift branches swallow the newline.

### Project layout

```
obsidian-line-drag-select/
├── manifest.json        # Plugin metadata (id: line-drag-select, minAppVersion 1.4.0)
├── versions.json        # Version → minAppVersion map (fallback installs on older Obsidian)
├── main.js              # ★ Hand-written CommonJS source, also the file Obsidian loads (~1100 lines)
├── styles.css           # Hide native gutter in own mode + highlight selected lines
├── LICENSE              # Full MIT license text (Copyright © 2026 airlulu)
├── package.json         # devDependencies and test / typecheck scripts only
├── tsconfig.json        # JSDoc type checking only (allowJs + checkJs + noEmit)
├── tests/
│   ├── selection.test.js     # Selection pure functions, coordinate fallbacks, gutter highlight (23 tests)
│   ├── commands.test.js      # Keyboard commands (9 tests)
│   ├── plugin-onload.test.js # Plugin wiring / settings tab / real CM6 extension smoke test (4 tests)
│   └── stubs/obsidian.js     # Minimal obsidian stub for Node (CM6 is the real package)
├── docs/
│   ├── prd/20261101_Obsidian行号区拖动多选插件-设计方案.md
│   ├── selection-lower-bound-and-gutter-highlight-design.md
│   └── gutter-highlight-block-widget-rows-design.md
└── .github/workflows/release.yml # tag → draft release (attestation + uploads main.js / manifest.json / styles.css)
```

`main.js` is organized into sections numbered 1–10: 1 settings and defaults → 2 selection pure logic → 3 coordinates → line block (three fallbacks) → 4 gutter highlight → 5 drag state machine (plus 5-B keyboard commands) → 6 the two event sources (6-A / 6-B) → 7 CM6 extension factory → 8 plugin wiring → 9 settings tab → 10 module exports.

### Development

```bash
npm install       # dependencies for tests / typecheck only (not needed at runtime)
npm test          # node --test, 36 tests
npm run typecheck # tsc --noEmit, checks JSDoc types in main.js
node --check main.js  # syntax check
```

The **selection math is deliberately DOM-free pure functions** (`rangeForLine` / `rangeForDrag` / `rangeForShift` / `toggleLineRange` / `extendRowSpan` / `extendedDeleteEnd`, …), so it can be unit-tested directly in Node — that is the most error-prone and most test-worthy part of the implementation. Line lookup `blockAtClientY` degrades through three tiers (`lineBlockAtHeight` → `viewportLineBlocks` → `posAtCoords`) to stay compatible with the different CM6 builds bundled in Obsidian.

### Implementation notes

- **Pluggable event source**: mode A listens for `pointerdown` on `view.dom` in the capture phase and narrows hits with `closest('.cm-lineNumbers')` (so folding arrows and other gutter columns keep working), then deterministically `preventDefault + stopPropagation`. Mode B registers a custom `gutter({ domEventHandlers })` whose callback receives the `BlockInfo` directly. Both share the same drag state machine and selection math.
- **Dispatch only when the line block changes**: no transaction per mouse move — a same-block move just schedules auto-scroll.
- **Auto-scroll**: a `requestAnimationFrame` loop computes the scroll delta from the distance past the edge, then re-resolves the line block with the same `clientY` after scrolling (scrolling changes the y↔line mapping) and extends the selection.
- **Highlight trusts only plugin transactions**: an `Annotation` marks "this selection came from the gutter", and the `StateField` accepts selection changes only with that mark. Clicking in the text, `Ctrl+A`, undo/redo, or any doc change immediately invalidates the highlight — better no highlight than a wrong one.
- **Block-widget rows**: tables, embeds and collapsed blocks are block widgets in Live Preview — their source lines are replaced, there is no text line block, and CM6's `gutterLineClass` never reaches them. The plugin instead uses `lineNumberWidgetMarker` (or its own gutter's `widgetMarker` in own mode) to add a number-less, same-colored highlight element, and only when the whole block is covered; when not selected, the native appearance is untouched.

### Known limitations

- The native-gutter mode requires **Show line number**; without it the plugin won't error, it just seems to do nothing — use the "Check whether line numbers are enabled" command to confirm.
- Hot reconfiguration reads `view.editor.cm` (Obsidian's undocumented `EditorView` handle). It is only used there inside try/catch; the core interaction doesn't depend on it.
- Block-widget highlighting relies on CM6's `lineNumberWidgetMarker` facet; on older CM6 builds it degrades gracefully to "those rows just don't light up".
- Mobile (`isDesktopOnly: false`) is not touch-tuned; dragging may fight scrolling/long-press, so click-to-select is the recommended mobile behavior.
- Vim mode: selections are always produced via `view.dispatch({ selection })` and not specially adapted. Coexistence with other gutter / multi-cursor plugins is handled only via event priority (`Prec.highest`) and hit-test narrowing.

### Documentation

- [Feasibility analysis and design proposal (zh)](docs/prd/20261101_Obsidian行号区拖动多选插件-设计方案.md)
- [Strict line-end lower bound + gutter highlight design (zh)](docs/selection-lower-bound-and-gutter-highlight-design.md)
- [Block-widget row highlight design (zh)](docs/gutter-highlight-block-widget-rows-design.md)

### License

MIT © 2026 airlulu (full text in [LICENSE](LICENSE)).
