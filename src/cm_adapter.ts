/**
 * An adapter to make CodeMirror's vim bindings work with monaco
 */
import {
  KeyCode,
  Range,
  Position,
  Selection,
  SelectionDirection,
  editor as monacoEditor,
  type IKeyboardEvent,
} from "monaco-editor/esm/vs/editor/editor.api";
import { ShiftCommand } from "monaco-editor/esm/vs/editor/common/commands/shiftCommand";

import type { InputOptions, ModeEvent } from "./statusbar";
import type VimStatusBar from "./statusbar";

const VerticalRevealType = {
  Bottom: 4,
};

// for monaco 0.19.x where x < 3
const EditorOptConstants = {
  readOnly: 65,
  cursorWidth: 20,
  fontInfo: 32,
};

const nonASCIISingleCaseWordChar =
  /[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;

function isWordCharBasic(ch: string) {
  return (
    /\w/.test(ch) || (ch > "\x80" && (ch.toUpperCase() !== ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch)))
  );
}

class CmPos {
  line: number;
  ch: number;
  constructor(line: number, column: number) {
    this.line = line;
    this.ch = column;
  }
}

function signal(cm: CMAdapter, signal: string, args: ListenerHandlerArg) {
  cm.dispatch(signal, args);
}

function dummy(_key: string) {
  return () => {
    // console.log(_key, 'dummy function called with', Array.prototype.slice.call(arguments));
  };
}

class StringStream {
  pos: number;
  start: number;
  string: string;
  tabSize: number;
  lastColumnPos: number;
  lastColumnValue: number;
  lineStart: number;

  constructor(string: string, tabSize: number) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
  }

  eol(): boolean {
    return this.pos >= this.string.length;
  }

  sol(): boolean {
    return this.pos === this.lineStart;
  }

  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }

  next(): string | undefined {
    if (this.pos < this.string.length) {
      return this.string.charAt(this.pos++);
    }
    return undefined;
  }

  eat(match: string | RegExp | ((char: string) => boolean)): string | undefined {
    const ch = this.string.charAt(this.pos);
    let ok: boolean;
    if (typeof match === "string") {
      ok = ch === match;
    } else {
      ok = !!ch && (match instanceof RegExp ? match.test(ch) : match(ch));
    }

    if (ok) {
      ++this.pos;
      return ch;
    }
    return undefined;
  }

  eatWhile(match: string | RegExp | ((char: string) => boolean)): boolean {
    const start = this.pos;
    while (this.eat(match)) {
      /* The string is advanced as long as it is matched. */
    }
    return this.pos > start;
  }

  eatSpace(): boolean {
    const start = this.pos;
    while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) {
      ++this.pos;
    }
    return this.pos > start;
  }

  skipToEnd() {
    this.pos = this.string.length;
  }

  skipTo(ch: string): boolean {
    const found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
    return false;
  }

  backUp(n: number) {
    this.pos -= n;
  }

  column() {
    throw new Error("not implemented");
  }

  indentation() {
    throw new Error("not implemented");
  }

  match(pattern: string | RegExp, consume?: boolean, caseInsensitive?: boolean): boolean | RegExpMatchArray | null {
    if (typeof pattern === "string") {
      const cased = (str: string): string => (caseInsensitive ? str.toLowerCase() : str);
      const substr = this.string.substring(this.pos, this.pos + pattern.length);

      if (cased(substr) === cased(pattern) && consume !== false) {
        this.pos += pattern.length;
        return true;
      }
      return null;
    }

    const match = RegExp(pattern).exec(this.string.slice(this.pos));
    if (match?.index && match.index > 0) {
      return null;
    }
    if (match && consume !== false) {
      this.pos += match[0].length;
    }
    return match;
  }

  current(): string {
    return this.string.slice(this.start, this.pos);
  }

  hideFirstChars<T>(n: number, inner: () => T) {
    this.lineStart += n;
    try {
      return inner();
    } finally {
      this.lineStart -= n;
    }
  }
}

function toCmPos(pos: Position): CmPos {
  return new CmPos(pos.lineNumber - 1, pos.column - 1);
}

function toMonacoPos(pos: CmPos): Position {
  return new Position(pos.line + 1, pos.ch + 1);
}

class Marker extends Position {
  cm: CMAdapter;
  id: number;
  $insertRight: boolean;

  constructor(cm: CMAdapter, id: number, line: number, ch: number) {
    super(line + 1, ch + 1);
    this.cm = cm;
    this.id = id;
    cm.marks[this.id] = this;
    this.$insertRight = false;
  }

  clear() {
    delete this.cm.marks[this.id];
  }

  find() {
    return toCmPos(this);
  }
}

function monacoToCmKey(e: IKeyboardEvent, skip = false) {
  const addQuotes = true;
  const keyName = KeyCode[e.keyCode];

  let key = keyName;
  let skipOnlyShiftCheck = skip;

  switch (e.keyCode) {
    case KeyCode.Shift:
    case KeyCode.Meta:
    case KeyCode.Alt:
    case KeyCode.Ctrl:
      return key;
    case KeyCode.Escape:
      skipOnlyShiftCheck = true;
      key = "Esc";
      break;
    case KeyCode.Space:
      skipOnlyShiftCheck = true;
      break;
  }

  // `Key` check for monaco >= 0.30.0
  if (keyName.startsWith("Key") || keyName.startsWith("KEY_")) {
    key = keyName[keyName.length - 1].toLowerCase();
  } else if (keyName.startsWith("Digit")) {
    key = keyName.slice(5, 6);
  } else if (keyName.startsWith("Numpad")) {
    key = keyName.slice(6, 7);
  } else if (keyName.endsWith("Arrow")) {
    skipOnlyShiftCheck = true;
    key = keyName.substring(0, keyName.length - 5);
  } else if (
    keyName.startsWith("US_") ||
    // `Bracket` check for monaco >= 0.30.0
    keyName.startsWith("Bracket") ||
    !key
  ) {
    key = e.browserEvent.key;
  }

  if (!skipOnlyShiftCheck && !e.altKey && !e.ctrlKey && !e.metaKey) {
    key = e.browserEvent.key;
  } else {
    if (e.altKey) {
      key = `Alt-${key}`;
    }
    if (e.ctrlKey) {
      key = `Ctrl-${key}`;
    }
    if (e.metaKey) {
      key = `Meta-${key}`;
    }
    if (e.shiftKey) {
      key = `Shift-${key}`;
    }
  }

  if (key.length === 1 && addQuotes) {
    key = `'${key}'`;
  }

  return key;
}

type KeyMapFnInner = (cm: CMAdapter) => boolean;
type KeyMapFn = (key: string) => KeyMapFnInner;
type KeyMap = {
  default: KeyMapFn;
  vim?: {
    attach: KeyMapFnInner;
    [key: string]: KeyMapFnInner;
  };
} & Partial<{ [key: string]: KeyMapFn }>;

type ScrollInfo = {
  left: number;
  top: number;
  height: number;
  clientHeight: number;
};

type Change = {
  text: string[];
  origin: string;
  next?: Change;
};

type CursorOp = Partial<{
  changeHandlers: ListenerHandler[];
  change: Change;
  lastChange?: Change;
}>;

type OnEventFn = ((mode: ModeEvent) => void) | ((key: string) => void) | (() => void);
type ListenerHandlerArg = (CMAdapter | monacoEditor.ICursorPositionChangedEvent | Change)[];
type ListenerHandler = ((...args: ListenerHandlerArg[]) => void) | OnEventFn;

class CMAdapter {
  static readonly Pos = CmPos;
  static readonly signal = signal;
  static readonly on = dummy("on");
  static readonly off = dummy("off");
  static readonly addClass = dummy("addClass");
  static readonly rmClass = dummy("rmClass");
  static readonly defineOption = dummy("defineOption");
  static readonly keyMap: KeyMap = {
    default: (_key) => (_cm) => true,
  };
  static readonly matchingBrackets = {
    "(": ")>",
    ")": "(<",
    "[": "]>",
    "]": "[<",
    "{": "}>",
    "}": "{<",
    "<": ">>",
    ">": "<<",
  };
  static readonly isWordChar = isWordCharBasic;
  static readonly keyName = monacoToCmKey;
  static readonly StringStream = StringStream;

  static readonly e_stop = (e: Event) => {
    if (e.stopPropagation) {
      e.stopPropagation();
    }
    CMAdapter.e_preventDefault(e);
    return false;
  };

  static readonly e_preventDefault = (e: Event) => {
    if (e.preventDefault) {
      e.preventDefault();
    }

    return false;
  };

  static readonly commands = {
    redo: (cm: CMAdapter) => {
      cm.editor.getModel()?.redo();
    },
    undo: (cm: CMAdapter) => {
      cm.editor.getModel()?.undo();
    },
    newlineAndIndent: (cm: { triggerEditorAction: (arg0: string) => void }) => {
      cm.triggerEditorAction("editor.action.insertLineAfter");
    },
  };

  static readonly lookupKey = function lookupKey(
    key: string,
    map: string | { fallthrough: any[] },
    handle: { (): boolean; (binding: any): boolean; (arg0: any): any }
  ) {
    if (typeof map === "string") {
      map = CMAdapter.keyMap[map];
    }
    const found = typeof map === "function" ? map(key) : map[key];

    if (found === false) {
      return "nothing";
    }
    if (found === "...") {
      return "multi";
    }
    if (found != null && handle(found)) {
      return "handled";
    }

    if (map.fallthrough) {
      if (!Array.isArray(map.fallthrough)) {
        return lookupKey(key, map.fallthrough, handle);
      }
      for (const element of map.fallthrough) {
        const result = lookupKey(key, element, handle);
        if (result) {
          return result;
        }
      }
    }
  };

  static defineExtension = <T, U>(name: string, fn: (arg: T) => U) => {
    CMAdapter.prototype[name] = fn;
  };
  editor: monacoEditor.IStandaloneCodeEditor;
  state: Partial<{
    theme: string;
    keyMap: string;
    [key: string]: string;
  }>;
  marks: {
    [key: number]: Marker;
  };
  $uid: number;
  disposables: { dispose: () => void }[];
  listeners: {
    [key: string]: ListenerHandler[];
  };
  curOp: CursorOp;
  attached: boolean;
  statusBar: VimStatusBar | null;
  options: {};
  ctxInsert: monacoEditor.IContextKey<boolean>;
  replaceMode?: boolean;
  replaceStack?: string[];
  inVirtualSelectionMode?: boolean;
  initialCursorWidth?: number;

  constructor(editor: monacoEditor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.state = {
      keyMap: "vim",
    };
    this.marks = {};
    this.$uid = 0;
    this.disposables = [];
    this.listeners = {};
    this.curOp = {};
    this.attached = false;
    this.statusBar = null;
    this.options = {};
    this.addLocalListeners();
    this.ctxInsert = this.editor.createContextKey("insertMode", true);
  }

  attach() {
    CMAdapter.keyMap.vim?.attach(this);
  }

  addLocalListeners() {
    this.disposables.push(
      this.editor.onDidChangeCursorPosition(this.handleCursorChange),
      this.editor.onDidChangeModelContent(this.handleChange),
      this.editor.onKeyDown(this.handleKeyDown)
    );
  }

  handleKeyDown = (e: IKeyboardEvent) => {
    // Allow previously registered keydown listeners to handle the event and
    // prevent this extension from also handling it.
    if (e.browserEvent.defaultPrevented && e.keyCode !== KeyCode.Escape) {
      return;
    }

    if (!this.attached) {
      return;
    }

    const key = monacoToCmKey(e);

    if (this.replaceMode) {
      this.handleReplaceMode(key, e);
    }

    if (!key) {
      return;
    }

    const keymap = this.state.keyMap;
    if (keymap && CMAdapter.keyMap[keymap]?.call) {
      const cmd = CMAdapter.keyMap[keymap]?.(key);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();

        try {
          cmd(this);
        } catch (err) {
          console.error(err);
        }
      }
    }
  };

  handleReplaceMode(key: string, e: { preventDefault: () => void; stopPropagation: () => void }) {
    let fromReplace = false;
    let char = key;
    const pos = this.editor.getPosition();
    if (pos === null) {
      return;
    }

    let range = new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 1);
    const forceMoveMarkers = true;

    if (key.startsWith("'")) {
      char = key[1];
    } else if (char === "Enter") {
      char = "\n";
    } else if (char === "Backspace") {
      const lastItem = this.replaceStack?.pop();

      if (!lastItem) {
        return;
      }

      fromReplace = true;
      char = lastItem;
      range = new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column - 1);
    } else {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (!this.replaceStack) {
      this.replaceStack = [];
    }

    if (!fromReplace) {
      const value = this.editor.getModel()?.getValueInRange(range);
      if (value) {
        this.replaceStack.push(value);
      }
    }

    this.editor.executeEdits("vim", [
      {
        text: char,
        range,
        forceMoveMarkers,
      },
    ]);

    if (fromReplace) {
      this.editor.setPosition(range.getStartPosition());
    }
  }

  handleCursorChange = (e: monacoEditor.ICursorPositionChangedEvent) => {
    const { position, source } = e;
    const { editor } = this;
    const selection = editor.getSelection();

    if (!this.ctxInsert.get() && e.source === "mouse" && selection?.isEmpty()) {
      const maxCol = editor.getModel()?.getLineMaxColumn(position.lineNumber);

      if (e.position.column === maxCol) {
        editor.setPosition(new Position(e.position.lineNumber, maxCol - 1));
        return;
      }
    }

    this.dispatch("cursorActivity", [this, e]);
  };

  handleChange = (e: monacoEditor.IModelContentChangedEvent) => {
    const { changes } = e;
    const change = {
      text: changes.reduce((acc: string[], change: { text: string }) => {
        acc.push(change.text);
        return acc;
      }, []),
      origin: "+input",
    };

    const curOp = this.curOp || {};
    if (!curOp.changeHandlers) {
      curOp.changeHandlers = this.listeners.change?.slice();
    }

    if (this.virtualSelectionMode()) {
      return;
    }

    if (!curOp.lastChange) {
      curOp.lastChange = curOp.change = change;
    } else {
      curOp.lastChange.next = curOp.lastChange = change;
    }

    this.dispatch("change", [this, change]);
  };

  setOption(key: string, value: string) {
    this.state[key] = value;

    if (key === "theme") {
      monacoEditor.setTheme(value);
    }
  }

  getConfiguration() {
    const { editor } = this;
    let opts = EditorOptConstants;

    if (typeof editor.getRawOptions === "function") {
      return editor.getRawOptions();
    }
    if ("EditorOption" in monacoEditor) {
      // for monaco 0.19.3 onwards
      opts = monacoEditor.EditorOption;
    }

    return {
      readOnly: editor.getOption(opts.readOnly),
      viewInfo: {
        cursorWidth: editor.getOption(opts.cursorWidth),
      },
      fontInfo: editor.getOption(opts.fontInfo),
    };
  }

  getOption(key: keyof monacoEditor.IEditorOptions) {
    if (key === "readOnly") {
      return this.getConfiguration().readOnly;
    }
    return this.editor.getRawOptions()[key];
  }

  dispatch(signal: string, ...args: ListenerHandlerArg[]) {
    const listeners = this.listeners[signal];
    if (!listeners) {
      return;
    }

    for (const handler of listeners) {
      handler(...args);
    }
  }

  on(event: string, handler: ((mode: ModeEvent) => void) | ((key: string) => void) | (() => void)) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event].push(handler);
  }

  off(event: string, handler: ListenerHandler) {
    const listeners = this.listeners[event];
    if (!listeners) {
      return;
    }

    this.listeners[event] = listeners.filter((l) => l !== handler);
  }

  firstLine() {
    return 0;
  }

  lastLine() {
    const lineCount = this.lineCount();
    if (lineCount) {
      return lineCount - 1;
    }
    return null;
  }

  lineCount() {
    return this.editor.getModel()?.getLineCount();
  }

  defaultTextHeight() {
    return 1;
  }

  getLine(line: number) {
    if (line < 0) {
      return "";
    }
    const model = this.editor.getModel();
    const maxLines = model?.getLineCount();

    if (maxLines && line + 1 > maxLines) {
      line = maxLines - 1;
    }

    return this.editor.getModel()?.getLineContent(line + 1);
  }

  getAnchorForSelection(selection: Selection) {
    if (selection.isEmpty()) {
      return selection.getPosition();
    }

    const selDir = selection.getDirection();
    return selDir === SelectionDirection.LTR ? selection.getStartPosition() : selection.getEndPosition();
  }

  getHeadForSelection(selection: Selection) {
    if (selection.isEmpty()) {
      return selection.getPosition();
    }

    const selDir = selection.getDirection();
    return selDir === SelectionDirection.LTR ? selection.getEndPosition() : selection.getStartPosition();
  }

  getCursor(type: "anchor" | "head" | null = null) {
    if (!type) {
      const pos = this.editor.getPosition();
      if (pos) {
        return toCmPos(pos);
      }
    }

    const sel = this.editor.getSelection();
    let pos = null;

    if (sel?.isEmpty()) {
      pos = sel.getPosition();
    } else if (sel && type === "anchor") {
      pos = this.getAnchorForSelection(sel);
    } else if (sel) {
      pos = this.getHeadForSelection(sel);
    }

    if (pos) {
      return toCmPos(pos);
    }
    return null;
  }

  getRange(start: CmPos, end: CmPos) {
    const p1 = toMonacoPos(start);
    const p2 = toMonacoPos(end);

    return this.editor.getModel()?.getValueInRange(Range.fromPositions(p1, p2));
  }

  getSelection() {
    const list: string[] = [];
    const { editor } = this;
    editor.getSelections()?.map((sel: Selection) => {
      const value = editor.getModel()?.getValueInRange(sel);
      if (value) {
        list.push();
      }
    });
    return list.join("\n");
  }

  replaceRange(text: string, start: CmPos, end: CmPos) {
    const p1 = toMonacoPos(start);
    const p2 = end ? toMonacoPos(end) : p1;

    this.editor.executeEdits("vim", [
      {
        text,
        range: Range.fromPositions(p1, p2),
      },
    ]);
    // @TODO - Check if this breaks any other expectation
    this.pushUndoStop();
  }

  pushUndoStop() {
    this.editor.pushUndoStop();
  }

  setCursor(line: number | CmPos, ch: number) {
    let pos: CmPos;
    if (line instanceof CmPos) {
      pos = line;
    } else {
      pos = new CmPos(line, ch);
      pos.line = line;
      pos.ch = ch;
    }

    const monacoPos = this.editor.getModel()?.validatePosition(toMonacoPos(pos));
    this.editor.setPosition(toMonacoPos(pos));
    if (monacoPos) {
      this.editor.revealPosition(monacoPos);
    }
  }

  somethingSelected() {
    return !this.editor.getSelection()?.isEmpty();
  }

  operation<T>(fn: () => T) {
    return fn();
  }

  listSelections() {
    const selections = this.editor.getSelections();

    if (!selections?.length || this.inVirtualSelectionMode) {
      return [
        {
          anchor: this.getCursor("anchor"),
          head: this.getCursor("head"),
        },
      ];
    }

    return selections.map((sel: Selection) => {
      return {
        anchor: this.clipPos(toCmPos(this.getAnchorForSelection(sel))),
        head: this.clipPos(toCmPos(this.getHeadForSelection(sel))),
      };
    });
  }

  focus() {
    this.editor.focus();
  }

  setSelections(selections: Selection[], primIndex: number) {
    const hasSel = !!this.editor.getSelections()?.length;
    const sels = selections.map((sel, _index) => {
      const { anchor, head } = sel;

      if (hasSel) {
        return Selection.fromPositions(toMonacoPos(anchor), toMonacoPos(head));
      }
      return Selection.fromPositions(toMonacoPos(head), toMonacoPos(anchor));
    });

    if (sels[primIndex]) {
      sels.push(sels.splice(primIndex, 1)[0]);
    }

    if (!sels.length) {
      return;
    }

    const sel = sels[0];
    let posToReveal: Position;

    if (sel.getDirection() === SelectionDirection.LTR) {
      posToReveal = sel.getEndPosition();
    } else {
      posToReveal = sel.getStartPosition();
    }

    this.editor.setSelections(sels);
    this.editor.revealPosition(posToReveal);
  }

  setSelection(frm: CmPos, to: CmPos) {
    const range = Range.fromPositions(toMonacoPos(frm), toMonacoPos(to));
    this.editor.setSelection(range);
  }

  getSelections() {
    const { editor } = this;

    const selections: string[] = [];
    editor.getSelections()?.map((sel) => {
      const value = editor.getModel()?.getValueInRange(sel);
      if (value) {
        selections.push(value);
      }
    });
    return selections;
  }

  replaceSelections(texts: string[]) {
    const { editor } = this;

    editor.getSelections()?.forEach((sel, index) => {
      editor.executeEdits("vim", [
        {
          range: sel,
          text: texts[index],
          forceMoveMarkers: false,
        },
      ]);
    });
  }

  toggleOverwrite(toggle: boolean) {
    if (toggle) {
      this.enterVimMode();
      this.replaceMode = true;
    } else {
      this.leaveVimMode();
      this.replaceMode = false;
      this.replaceStack = [];
    }
  }

  charCoords(pos: CmPos) {
    return {
      top: pos.line,
      left: pos.ch,
    };
  }

  clipPos(p: CmPos) {
    const pos = this.editor.getModel()?.validatePosition(toMonacoPos(p));
    if (pos) {
      return toCmPos(pos);
    }
    return null;
  }

  setBookmark(cursor: { line: number; ch: number }, options: { insertLeft: boolean }) {
    const bm = new Marker(this, this.$uid++, cursor.line, cursor.ch);

    if (!options?.insertLeft) {
      bm.$insertRight = true;
    }

    this.marks[bm.id] = bm;
    return bm;
  }

  getScrollInfo(): ScrollInfo {
    const { editor } = this;
    const [range] = editor.getVisibleRanges();

    return {
      left: 0,
      top: range.startLineNumber - 1,
      height: editor.getModel()?.getLineCount() ?? 0,
      clientHeight: range.endLineNumber - range.startLineNumber + 1,
    };
  }

  triggerEditorAction<T, U>(action: (arg: T) => U) {
    this.editor.trigger("vim", "vim-handler", action);
  }

  dispose() {
    this.dispatch("dispose");
    this.removeOverlay();

    if (CMAdapter.keyMap.vim) {
      CMAdapter.keyMap.vim.detach(this);
    }

    for (const d of this.disposables) {
      d.dispose();
    }
  }

  getInputField() {
    /* TODO document why this method 'getInputField' is empty */
  }
  getWrapperElement() {
    /* TODO document why this method 'getWrapperElement' is empty */
  }

  enterVimMode(toVim = true) {
    this.ctxInsert.set(false);
    const config = this.getConfiguration();
    this.initialCursorWidth = config.viewInfo.cursorWidth || 0;

    this.editor.updateOptions({
      cursorWidth: config.fontInfo.typicalFullwidthCharacterWidth,
      cursorBlinking: "solid",
    });
  }

  leaveVimMode() {
    this.ctxInsert.set(true);

    this.editor.updateOptions({
      cursorWidth: this.initialCursorWidth ?? 0,
      cursorBlinking: "blink",
    });
  }

  virtualSelectionMode() {
    return this.inVirtualSelectionMode;
  }

  markText() {
    // only used for fat-cursor, not needed
    return { clear: () => {}, find: () => {} };
  }

  getUserVisibleLines() {
    const ranges = this.editor.getVisibleRanges();
    if (!ranges.length) {
      return {
        top: 0,
        bottom: 0,
      };
    }

    const res = {
      top: Number.POSITIVE_INFINITY,
      bottom: 0,
    };

    ranges.reduce((acc: { top: number; bottom: number }, range: { startLineNumber: number; endLineNumber: number }) => {
      if (range.startLineNumber < acc.top) {
        acc.top = range.startLineNumber;
      }

      if (range.endLineNumber > acc.bottom) {
        acc.bottom = range.endLineNumber;
      }

      return acc;
    }, res);

    res.top -= 1;
    res.bottom -= 1;

    return res;
  }

  findPosV(startPos: CmPos, amount: number, unit: string) {
    const { editor } = this;
    let finalAmount = amount;
    let finalUnit = unit;
    const pos = toMonacoPos(startPos);

    if (unit === "page") {
      const editorHeight = editor.getLayoutInfo().height;
      const { lineHeight } = this.getConfiguration().fontInfo;
      finalAmount *= Math.floor(editorHeight / lineHeight);
      finalUnit = "line";
    }

    if (finalUnit === "line") {
      pos.lineNumber += finalAmount;
    }

    return toCmPos(pos);
  }

  findMatchingBracket(pos: CmPos) {
    const mPos = toMonacoPos(pos);
    const model = this.editor.getModel();
    let res;
    // for monaco versions >= 0.28.0
    if (model?.bracketPairs) {
      res = model.bracketPairs.matchBracket(mPos);
    } else {
      res = model.matchBracket?.(mPos);
    }

    if (!res || res.length !== 2) {
      return {
        to: null,
      };
    }

    return {
      to: toCmPos(res[1].getStartPosition()),
    };
  }

  findFirstNonWhiteSpaceCharacter(line: number) {
    const column = this.editor.getModel()?.getLineFirstNonWhitespaceColumn(line + 1);
    return column ? column - 1 : 0;
  }

  scrollTo(x: number, y: number) {
    if (!x && !y) {
      return;
    }
    if (!x) {
      if (y < 0) {
        y = (this.editor.getPosition()?.lineNumber ?? 1) - y;
      }
      this.editor.setScrollTop(this.editor.getTopForLineNumber(y + 1));
    }
  }

  moveCurrentLineTo(viewPosition: string) {
    const { editor } = this;
    const pos = editor.getPosition() ?? new Position(0, 0);
    const range = Range.fromPositions(pos, pos);

    switch (viewPosition) {
      case "top":
        editor.revealRangeAtTop(range);
        return;
      case "center":
        editor.revealRangeInCenter(range);
        return;
      case "bottom":
        // private api. no other way
        editor.revealRange?.(range, VerticalRevealType.Bottom);
        return;
    }
  }

  getSearchCursor(query: RegExp | string, pos: CmPos) {
    let strQuery = "";
    let matchCase = false;
    let isRegex = false;

    if (typeof query === "string") {
      strQuery = query;
    }
    if (query instanceof RegExp && !query.global) {
      matchCase = !query.ignoreCase;
      strQuery = query.source;
      isRegex = true;
    }

    if (pos.ch === undefined) {
      pos.ch = Number.MAX_VALUE;
    }

    const monacoPos = toMonacoPos(pos);
    const context = this;
    const { editor } = this;
    let lastSearch: Range | null = null;
    const model = editor.getModel();
    const matches = model?.findMatches(strQuery, false, isRegex, matchCase, null, true) ?? [];

    return {
      getMatches() {
        return matches;
      },
      findNext() {
        return this.find(false);
      },
      findPrevious() {
        return this.find(true);
      },
      jumpTo(index: number) {
        if (!matches.length) {
          return false;
        }
        const match = matches[index];
        lastSearch = match.range;
        context.highlightRanges([lastSearch], "currentFindMatch");
        context.highlightRanges(matches.map((m) => m.range).filter((r) => !r.equalsRange(lastSearch)));

        return lastSearch;
      },
      find(back: boolean) {
        if (!matches.length) {
          return false;
        }

        let match;

        if (back) {
          const pos = lastSearch ? lastSearch.getStartPosition() : monacoPos;
          match = model?.findPreviousMatch(strQuery, pos, isRegex, matchCase, null, true);

          if (!match?.range.getStartPosition().isBeforeOrEqual(pos)) {
            return false;
          }
        } else {
          const pos =
            (lastSearch ? model?.getPositionAt(model.getOffsetAt(lastSearch.getEndPosition()) + 1) : monacoPos) ??
            monacoPos;
          match = model?.findNextMatch(strQuery, pos, isRegex, matchCase, null, true);
          if (!match || !pos.isBeforeOrEqual(match.range.getStartPosition())) {
            return false;
          }
        }

        lastSearch = match.range;
        context.highlightRanges([lastSearch], "currentFindMatch");
        context.highlightRanges(matches.map((m) => m.range).filter((r) => !r.equalsRange(lastSearch)));

        return lastSearch;
      },
      from() {
        return lastSearch && toCmPos(lastSearch.getStartPosition());
      },
      to() {
        return lastSearch && toCmPos(lastSearch.getEndPosition());
      },
      replace(text: string) {
        if (lastSearch) {
          editor.executeEdits(
            "vim",
            [
              {
                range: lastSearch,
                text,
                forceMoveMarkers: true,
              },
            ],
            (edits: { range: { endLineNumber: number; endColumn: number } }[]) => {
              const { endLineNumber, endColumn } = edits[0].range;
              const range = lastSearch?.setEndPosition(endLineNumber, endColumn);
              if (range) {
                lastSearch = range;
              }
            }
          );
          editor.setPosition(lastSearch.getStartPosition());
        }
      },
    };
  }

  highlightRanges(ranges: Range[], className = "findMatch") {
    const decorationKey = `decoration${className}`;
    this[decorationKey] = this.editor.deltaDecorations(
      this[decorationKey] || [],
      ranges.map((range) => ({
        range,
        options: {
          stickiness: monacoEditor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          zIndex: 13,
          className,
          showIfCollapsed: true,
        },
      }))
    );

    return this[decorationKey];
  }

  addOverlay({ query }: { query: string | RegExp }, _hasBoundary: boolean, _style: string) {
    let matchCase = false;
    let isRegex = false;
    let strQuery = "";

    if (typeof query === "string") {
      strQuery = query;
    }
    if (query instanceof RegExp && !query.global) {
      isRegex = true;
      matchCase = !query.ignoreCase;
      strQuery = query.source;
    }

    const pos = this.editor.getPosition();
    if (pos === null) {
      return;
    }

    const match = this.editor.getModel()?.findNextMatch(strQuery, pos, isRegex, matchCase, null, true);
    if (!match?.range) {
      return;
    }

    this.highlightRanges([match.range]);
  }

  removeOverlay() {
    for (const key in ["currentFindMatch", "findMatch"]) {
      this.editor.deltaDecorations(this[`decoration${key}`] ?? [], []);
    }
  }

  scrollIntoView(pos: CmPos | null) {
    if (!pos) {
      return;
    }
    this.editor.revealPosition(toMonacoPos(pos));
  }

  moveH(units: number, type: string) {
    if (type !== "char") {
      return;
    }
    const pos = this.editor.getPosition();
    if (pos) {
      this.editor.setPosition(new Position(pos.lineNumber, pos.column + units));
    }
  }

  scanForBracket(pos: CmPos, dir: number, _dd: never, config: { bracketRegex: any }) {
    const { bracketRegex } = config;
    let mPos = toMonacoPos(pos);
    const model = this.editor.getModel();

    if (model === null) {
      return undefined;
    }

    const searchFunc = (dir === -1 ? model.findPreviousMatch : model.findNextMatch).bind(model);
    const stack = [];
    let iterations = 0;

    while (true) {
      if (iterations > 10) {
        // Searched too far, give up.
        return undefined;
      }

      const match = searchFunc(bracketRegex.source, mPos, true, true, null, true);
      const thisBracket = match?.matches?.[0];

      if (thisBracket === undefined || match == null) {
        return undefined;
      }

      const matchingBracket = CMAdapter.matchingBrackets[thisBracket];
      if (matchingBracket && (matchingBracket.charAt(1) === ">") === dir > 0) {
        stack.push(thisBracket);
      } else if (stack.length === 0) {
        const res = match.range.getStartPosition();

        return {
          pos: toCmPos(res),
        };
      } else {
        stack.pop();
      }

      mPos = model.getPositionAt(model.getOffsetAt(match.range.getStartPosition()) + dir);
      iterations += 1;
    }
  }

  indexFromPos(pos: CmPos) {
    return this.editor.getModel()?.getOffsetAt(toMonacoPos(pos));
  }

  posFromIndex(offset: number) {
    const pos = this.editor.getModel()?.getPositionAt(offset);
    if (pos) {
      return toCmPos(pos);
    }
    return null;
  }

  indentLine(line: number, indentRight = true) {
    const { editor } = this;
    let cursorConfig;
    // Monaco >= 0.21.x
    if (editor._getViewModel) {
      cursorConfig = editor._getViewModel().cursorConfig;
    } else {
      cursorConfig = editor._getCursors().context.config;
    }
    const pos = new Position(line + 1, 1);
    const sel = Selection.fromPositions(pos, pos);
    // no other way than to use internal apis to preserve the undoStack for a batch of indents
    editor.executeCommand(
      "vim",
      new ShiftCommand(sel, {
        isUnshift: !indentRight,
        tabSize: cursorConfig.tabSize,
        indentSize: cursorConfig.indentSize,
        insertSpaces: cursorConfig.insertSpaces,
        useTabStops: cursorConfig.useTabStops,
        autoIndent: cursorConfig.autoIndent,
      })
    );
  }

  setStatusBar(statusBar: VimStatusBar) {
    this.statusBar = statusBar;
  }

  openDialog(html: string, callback?: (value: string) => void, options?: InputOptions) {
    if (!this.statusBar) {
      return;
    }

    return this.statusBar.setSec(html, callback, options);
  }

  openNotification(html: string) {
    if (!this.statusBar) {
      return;
    }

    this.statusBar.showNotification(html);
  }

  smartIndent() {
    // Only works if a formatter is added for the current language.
    // reindentselectedlines does not work here.
    this.editor.getAction("editor.action.formatSelection")?.run();
  }

  moveCursorTo(to: string) {
    const newPos = this.editor.getPosition();

    let newColumn = newPos?.column;
    if (newPos) {
      if (to === "start") {
        newColumn = 1;
      } else if (to === "end") {
        newColumn = this.editor.getModel()?.getLineMaxColumn(newPos.lineNumber);
      }
      this.editor.setPosition(new Position(newPos.lineNumber, newColumn ?? newPos.column));
    }
  }

  execCommand(command: string) {
    switch (command) {
      case "goLineLeft":
        this.moveCursorTo("start");
        break;
      case "goLineRight":
        this.moveCursorTo("end");
        break;
      case "indentAuto":
        this.smartIndent();
        break;
    }
  }
}

export default CMAdapter;
