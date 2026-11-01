import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { lineDragSelect } from "./gutter";
import { DEFAULT_SETTINGS, Settings } from "./settings";

export default class LineDragSelectPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private compartment = new Compartment();

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
    document.body.classList.remove("lds-own-gutter");
  }

  private build(): Extension {
    return lineDragSelect(() => this.settings);
  }

  private syncBodyClass() {
    document.body.classList.toggle("lds-own-gutter", this.settings.gutterMode === "own");
  }

  /** 设置变更后让已打开的编辑器就地生效（CM6 的动态重配） */
  private reconfigureAll() {
    const ext = this.build();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      // @ts-expect-error - Obsidian 未公开 editor.cm
      const cm: EditorView | undefined = (leaf.view as MarkdownView)?.editor?.cm;
      if (!cm) continue;
      try {
        cm.dispatch({ effects: this.compartment.reconfigure(ext) });
      } catch {
        /* 编辑器可能正在销毁 */
      }
    }
  }

  private reportGutterState() {
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

class LineDragSelectSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LineDragSelectPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
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
            this.plugin.settings.gutterMode = v as Settings["gutterMode"];
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
