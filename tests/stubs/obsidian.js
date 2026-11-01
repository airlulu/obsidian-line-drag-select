"use strict";

/*
 * 这个文件只服务于 Node 单测。
 *
 * main.js 是给 Obsidian 运行时用的 CommonJS 插件模块，模块顶层就 `require("obsidian")`。
 * Obsidian 的 API 包只能在 Obsidian 进程里用（依赖 Electron / DOM / 应用单例），
 * 在纯 Node 下 require 会失败。因此测试通过 Module._resolveFilename 劫持，
 * 把 "obsidian" 的解析结果指向本文件——这里只提供 main.js 在「加载 + 纯函数」路径上
 * 真正碰到的类与方法，空实现即可，不模拟任何真实行为。
 *
 * 不要在这里实现业务逻辑：它只是让 `require("../main.js")` 能跑通的占位符。
 */

/** 供 Setting 等使用的最小元素占位符（只实现链式调用需要的方法）。 */
function createStubEl() {
  const el = {
    setText() {
      return el;
    },
    addClass() {
      return el;
    },
    removeClass() {
      return el;
    },
    empty() {
      return el;
    },
    createEl() {
      return createStubEl();
    },
    appendChild(child) {
      return child;
    },
  };
  return el;
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    // 记录插件注册了什么，供 tests/plugin-onload.test.js 断言生命周期装配。
    this.registeredEditorExtensions = [];
    this.settingTabs = [];
    this.commands = [];
    this.registeredEvents = [];
  }
  registerEditorExtension(extension) {
    this.registeredEditorExtensions.push(extension);
    return extension;
  }
  registerEvent(eventRef) {
    this.registeredEvents.push(eventRef);
    return eventRef;
  }
  addSettingTab(tab) {
    this.settingTabs.push(tab);
    return tab;
  }
  addCommand(command) {
    this.commands.push(command);
    return command;
  }
  addRibbonIcon() {
    return createStubEl();
  }
  async loadData() {
    return null;
  }
  async saveData() {
    return;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createStubEl();
  }
  display() {}
  hide() {}
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.components = [];
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setClass() {
    return this;
  }
  addDropdown(cb) {
    const dropdown = {
      addOption() {
        return dropdown;
      },
      setValue() {
        return dropdown;
      },
      onChange() {
        return dropdown;
      },
    };
    if (typeof cb === "function") cb(dropdown);
    return this;
  }
  addToggle(cb) {
    const toggle = {
      setValue() {
        return toggle;
      },
      onChange() {
        return toggle;
      },
    };
    if (typeof cb === "function") cb(toggle);
    return this;
  }
  addButton(cb) {
    const button = {
      setButtonText() {
        return button;
      },
      setCta() {
        return button;
      },
      onClick() {
        return button;
      },
    };
    if (typeof cb === "function") cb(button);
    return this;
  }
  addText(cb) {
    const text = {
      setPlaceholder() {
        return text;
      },
      setValue() {
        return text;
      },
      onChange() {
        return text;
      },
    };
    if (typeof cb === "function") cb(text);
    return this;
  }
}

class MarkdownView {}

class Notice {
  constructor(message) {
    this.message = message;
  }
  setMessage(message) {
    this.message = message;
    return this;
  }
  hide() {}
}

class App {}

module.exports = {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  Notice,
  App,
};
