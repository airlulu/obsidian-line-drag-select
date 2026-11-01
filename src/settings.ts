export type GutterMode = "hook" | "own";

export interface Settings {
  /** true：hook Obsidian 原生行号列（需先在 设置 ▸ 编辑器 打开「显示行号」） */
  gutterMode: GutterMode;
  /** 选区是否吞掉行尾换行符（VS Code 行为，便于整行删除/剪切） */
  includeEOL: boolean;
  /** 拖到编辑器上下边缘时自动滚动 */
  autoScroll: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  gutterMode: "hook",
  includeEOL: true,
  autoScroll: true,
};
