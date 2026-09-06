/**
 * キーボードショートカットの対応表（T-25。純関数。docs/DESIGN.md §6.5）。
 *
 * **実装は 4 か所に散っている**（`App.tsx` / `hooks/useCommitNavigation.ts` /
 * `hooks/useFileNavigation.ts` / `components/diff/useWorkingTree.ts`）。
 * 1 つのフックへ統合すると、動いているものを全部書き直すことになるので、
 * **キーの形だけをここへ集める**。各ハンドラは [`matches`] で判定し、
 * 設定画面の一覧は [`SHORTCUTS`] から作る。
 *
 * こうしておくと、**一覧と実際のキーがずれない**（一覧が飾りにならない）。
 *
 * **修飾キーは「書いていないものは押されていないこと」を要求する。**
 * `Ctrl+R` と `Ctrl+Shift+R` は別の動作なので、緩く見ると両方に当たる。
 */

/** 何をするか。**画面の一覧もこの順で出す。** */
export type Action =
  | "openPalette"
  | "fetchCurrent"
  | "fetchAll"
  | "openReview"
  | "openSettings"
  | "findInDiff"
  | "reload"
  | "gotoHead"
  | "commitDown"
  | "commitUp"
  | "commitFirst"
  | "commitLast"
  | "parentCommit"
  | "childCommit"
  | "fileNext"
  | "filePrev"
  | "focusDiff"
  | "close";

/**
 * キーの形。
 *
 * `keys` は**そのどれか 1 つ**に当たればよい（`↓` と `j` のような別名）。
 * 修飾キーは**明示したものだけが押されている**ことを求める。
 */
export type Binding = {
  action: Action;
  keys: string[];
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 画面の一覧に出す表記。**キーと別に持たない** — ここから作る。 */
  label: string;
};

/** 押されたキーの形（`KeyboardEvent` から要るところだけ取り出したもの）。 */
export type KeyPress = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

/**
 * v1 の全ショートカット（DESIGN.md §6.5）。**編集はしない。**
 *
 * **`Ctrl+R` は WebView のページ再読込に取られる**ので、当たったら必ず
 * `preventDefault` すること（表ではなく呼び出し側の責務）。
 */
export const SHORTCUTS: Binding[] = [
  { action: "openPalette", keys: ["p"], ctrl: true, label: "Ctrl+P" },
  { action: "fetchCurrent", keys: ["r"], ctrl: true, label: "Ctrl+R" },
  { action: "fetchAll", keys: ["r"], ctrl: true, shift: true, label: "Ctrl+Shift+R" },
  { action: "openReview", keys: ["a"], ctrl: true, shift: true, label: "Ctrl+Shift+A" },
  { action: "openSettings", keys: [","], ctrl: true, label: "Ctrl+," },
  { action: "findInDiff", keys: ["f"], ctrl: true, label: "Ctrl+F" },
  { action: "reload", keys: ["F5"], label: "F5" },
  { action: "gotoHead", keys: ["h"], ctrl: true, label: "Ctrl+H" },
  { action: "commitDown", keys: ["ArrowDown", "j"], label: "↓ / j" },
  { action: "commitUp", keys: ["ArrowUp", "k"], label: "↑ / k" },
  { action: "commitFirst", keys: ["Home"], label: "Home" },
  { action: "commitLast", keys: ["End"], label: "End" },
  { action: "parentCommit", keys: ["ArrowLeft"], alt: true, label: "Alt+←" },
  { action: "childCommit", keys: ["ArrowRight"], alt: true, label: "Alt+→" },
  { action: "filePrev", keys: ["ArrowUp"], alt: true, label: "Alt+↑" },
  { action: "fileNext", keys: ["ArrowDown"], alt: true, label: "Alt+↓" },
  { action: "focusDiff", keys: ["Enter"], label: "Enter" },
  { action: "close", keys: ["Escape"], label: "Esc" },
];

const BY_ACTION = new Map(SHORTCUTS.map((binding) => [binding.action, binding]));

/** 1 つの動作の割り当て。**表に無い動作は呼ばない**（型で防いである）。 */
export function bindingOf(action: Action): Binding {
  const found = BY_ACTION.get(action);
  if (found === undefined) throw new Error(`割り当てがありません: ${action}`);
  return found;
}

/**
 * その押し方がその動作に当たるか。
 *
 * **修飾キーは書いていないものが押されていないことまで見る。** 緩く見ると
 * `Ctrl+Shift+R`（全 fetch）が `Ctrl+R`（現在のリポジトリ）にも当たる。
 * `metaKey`（Windows キー / Cmd）は**どの割り当てにも使っていない**ので、
 * 押されていたらすべて外れる。
 */
export function matches(event: KeyPress, action: Action): boolean {
  const binding = bindingOf(action);
  if (event.metaKey) return false;
  if (event.ctrlKey !== (binding.ctrl ?? false)) return false;
  if (event.shiftKey !== (binding.shift ?? false)) return false;
  if (event.altKey !== (binding.alt ?? false)) return false;

  // 英字はどちらの大小でも当たるようにする（Shift を求める割り当てもあるため）。
  const pressed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return binding.keys.some((key) => (key.length === 1 ? key.toLowerCase() : key) === pressed);
}

/**
 * 入力欄で打っているか。**打っている間はどのショートカットも横取りしない。**
 *
 * ここに `j` / `k` があるので、緩めると SHA ジャンプ欄で文字が打てなくなる。
 */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (element === null) return false;
  return (
    /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable === true
  );
}
