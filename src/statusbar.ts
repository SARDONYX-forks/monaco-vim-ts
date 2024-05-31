import type { editor } from "monaco-editor";

export interface ModeEvent {
  mode: string;
  subMode?: string;
}

export type InputOptions = Partial<{
  selectValueOnOpen: boolean;
  value: string;
  onKeyUp: (e: KeyboardEvent, value: string, closeInput: () => void) => void;
  onKeyInput: (e: Event, value: string, closeInput: () => void) => void;
  onKeyDown: (e: KeyboardEvent, value: string, closeInput: () => void) => boolean;
  // _onKeyDown: typeof window.onkeydown;
  closeOnEnter: boolean;
  closeOnBlur: boolean;
}>;

export type Sanitizer = (input: string) => Node;

export default class VimStatusBar {
  node: HTMLElement;
  modeInfoNode: HTMLSpanElement;
  secInfoNode: HTMLSpanElement;
  notifyNode: HTMLSpanElement;
  keyInfoNode: HTMLSpanElement;
  editor: editor.IStandaloneCodeEditor;
  sanitizer: Sanitizer | null;
  input: {
    callback?: (value: string) => void;
    options?: InputOptions;
    node: HTMLInputElement;
  } | null;
  notifyTimeout?: number;

  constructor(node: HTMLElement, editor: editor.IStandaloneCodeEditor, sanitizer: Sanitizer | null = null) {
    this.node = node;
    this.modeInfoNode = document.createElement("span");
    this.secInfoNode = document.createElement("span");
    this.notifyNode = document.createElement("span");
    this.notifyNode.className = "vim-notification";
    this.keyInfoNode = document.createElement("span");
    this.keyInfoNode.setAttribute("style", "float: right");
    this.node.appendChild(this.modeInfoNode);
    this.node.appendChild(this.secInfoNode);
    this.node.appendChild(this.notifyNode);
    this.node.appendChild(this.keyInfoNode);
    this.toggleVisibility(false);
    this.editor = editor;
    this.sanitizer = sanitizer;
    this.input = null;
  }

  setMode(ev: ModeEvent) {
    if (ev.mode === "visual") {
      if (ev.subMode === "linewise") {
        this.setText("--VISUAL LINE--");
      } else if (ev.subMode === "blockwise") {
        this.setText("--VISUAL BLOCK--");
      } else {
        this.setText("--VISUAL--");
      }
      return;
    }

    this.setText(`--${ev.mode.toUpperCase()}--`);
  }

  setKeyBuffer(key: string) {
    this.keyInfoNode.textContent = key;
  }

  setSec(text?: string, callback?: (value: string) => void, options?: InputOptions) {
    this.notifyNode.textContent = "";
    if (text === undefined) {
      return this.closeInput;
    }

    this.setInnerHtml_(this.secInfoNode, text);
    const input = this.secInfoNode.querySelector("input");

    if (input) {
      input.focus();
      this.input = {
        callback,
        options,
        node: input,
      };

      if (options) {
        if (options.selectValueOnOpen) {
          input.select();
        }

        if (options.value) {
          input.value = options.value;
        }
      }

      this.addInputListeners();
    }

    return this.closeInput;
  }

  setText(text: string) {
    this.modeInfoNode.textContent = text;
  }

  toggleVisibility(toggle: boolean) {
    if (toggle) {
      this.node.style.display = "block";
    } else {
      this.node.style.display = "none";
    }

    if (this.input) {
      this.removeInputListeners();
    }

    clearInterval(this.notifyTimeout);
  }

  closeInput = () => {
    this.removeInputListeners();
    this.input = null;
    this.setSec("");

    if (this.editor) {
      this.editor.focus();
    }
  };

  clear = () => {
    this.setInnerHtml_(this.node, "");
  };

  inputKeyUp = (e: KeyboardEvent) => {
    if (this.input === null) {
      return;
    }

    const { options } = this.input;
    if (options?.onKeyUp && e.target instanceof HTMLInputElement) {
      options.onKeyUp(e, e.target.value, this.closeInput);
    }
  };

  inputKeyInput = (e: Event) => {
    if (this.input === null) {
      return;
    }

    const { options } = this.input;
    if (options?.onKeyInput && e.target instanceof HTMLInputElement) {
      options.onKeyInput(e, e.target.value, this.closeInput);
    }
  };

  inputBlur = () => {
    if (this.input === null) {
      return;
    }

    const { options } = this.input;
    if (options?.closeOnBlur) {
      this.closeInput();
    }
  };

  inputKeyDown = (e: KeyboardEvent) => {
    if (this.input === null) {
      return;
    }
    const { options, callback } = this.input;

    if (!(e.target instanceof HTMLInputElement)) {
      return;
    }
    if (options?.onKeyDown?.(e, e.target.value, this.closeInput)) {
      return;
    }

    // - "Escape": e.keyCode === 27
    // - "Enter": e.keyCode === 13
    if (e.key === "Escape" || (options && options.closeOnEnter !== false && e.key === "Enter")) {
      this.input.node.blur();
      e.stopPropagation();
      this.closeInput();
    }

    if (e.key === "Enter" && callback && e.target?.value) {
      e.stopPropagation();
      e.preventDefault();
      callback(e.target.value);
    }
  };

  addInputListeners() {
    if (this.input === null) {
      return;
    }

    const { node } = this.input;
    node.addEventListener("keyup", this.inputKeyUp);
    node.addEventListener("keydown", this.inputKeyDown);
    node.addEventListener("input", this.inputKeyInput);
    node.addEventListener("blur", this.inputBlur);
  }

  removeInputListeners() {
    if (!this.input?.node) {
      return;
    }

    const { node } = this.input;
    node.removeEventListener("keyup", this.inputKeyUp);
    node.removeEventListener("keydown", this.inputKeyDown);
    node.removeEventListener("input", this.inputKeyInput);
    node.removeEventListener("blur", this.inputBlur);
  }

  showNotification(text: string) {
    const sp = document.createElement("span");
    this.setInnerHtml_(sp, text);
    this.notifyNode.textContent = sp.textContent;
    this.notifyTimeout = setTimeout(() => {
      this.notifyNode.textContent = "";
    }, 5000);
  }

  setInnerHtml_(element: HTMLElement, htmlContents: string) {
    // Clear out previous contents first.
    while (element.childNodes.length) {
      element.removeChild(element.childNodes[0]);
    }
    if (!htmlContents) {
      return;
    }
    if (this.sanitizer) {
      element.appendChild(this.sanitizer(htmlContents));
    } else {
      element.innerHTML = htmlContents;
    }
  }
}
