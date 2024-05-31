import { default as VimMode } from "./cm/keymap_vim";
import StatusBar from "./statusbar";

import type { Sanitizer, ModeEvent } from "./statusbar";
import type { editor } from "monaco-editor";

export function initVimMode(
  editor: editor.IStandaloneCodeEditor,
  statusbarNode = null,
  StatusBarClass = StatusBar,
  sanitizer: Sanitizer | null = null
) {
  const vimAdapter = new VimMode(editor);

  if (!statusbarNode) {
    vimAdapter.attach();
    return vimAdapter;
  }

  const statusBar = new StatusBarClass(statusbarNode, editor, sanitizer);
  let keyBuffer = "";

  vimAdapter.on("vim-mode-change", (mode: ModeEvent) => {
    statusBar.setMode(mode);
  });

  vimAdapter.on("vim-keypress", (key: string) => {
    if (key === ":") {
      keyBuffer = "";
    } else {
      keyBuffer += key;
    }
    statusBar.setKeyBuffer(keyBuffer);
  });

  vimAdapter.on("vim-command-done", () => {
    keyBuffer = "";
    statusBar.setKeyBuffer(keyBuffer);
  });

  vimAdapter.on("dispose", () => {
    statusBar.toggleVisibility(false);
    statusBar.closeInput();
    statusBar.clear();
  });

  statusBar.toggleVisibility(true);
  vimAdapter.setStatusBar(statusBar);
  vimAdapter.attach();

  return vimAdapter;
}

export { VimMode, StatusBar };
