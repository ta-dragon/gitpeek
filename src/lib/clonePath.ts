/**
 * clone の URL から既定のフォルダ名を決める純関数（T-19。docs/DESIGN.md §8.4）。
 *
 * **決められないときは空を返す。** 適当な名前を作らない — 利用者が気付かないまま
 * 見当違いの場所へ数百 MB を落とすより、入力させたほうがよい。
 *
 * URL としてパースしない。**SCP 形式（`git@host:owner/repo.git`）は URL ではない**ので、
 * `new URL()` に通すと片方の形式が丸ごと落ちる。区切りを自前で剥がす。
 */

/** `scheme://`。SCP 形式には付かない。 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Windows のフォルダ名に使えない文字。**区切りを含む**ので必ず弾く。 */
const UNUSABLE = /[\\/:*?"<>|]/;

/**
 * URL から既定のフォルダ名を作る。決められなければ空文字列。
 *
 * - `https://github.com/o/repo.git` → `repo`
 * - `git@github.com:o/repo.git` → `repo`（**`:` が区切り**）
 * - `https://host/o/repo/` → `repo`（末尾の `/` は無視する）
 * - `https://github.com` → `""`（リポジトリを指していない）
 */
export function defaultFolderName(url: string): string {
  const trimmed = stripTrailingSeparators(url.trim());
  if (trimmed === "") return "";

  // scheme とユーザー情報（`user:pass@` / SCP の `git@`）を剥がす。
  // **資格情報付き URL を貼られることがある**ので、`@` は最後のものまで飛ばす。
  const withoutScheme = trimmed.replace(SCHEME, "");
  const at = withoutScheme.lastIndexOf("@");
  const withoutUser = at < 0 ? withoutScheme : withoutScheme.slice(at + 1);

  // ホスト（または Windows のドライブレター）を落とす。**最初の区切りで切る** —
  // `host:port/o/repo` の `:` も `host/o/repo` の `/` もここで消える。
  const separator = withoutUser.search(/[/\\:]/);
  if (separator < 0) return "";
  const rest = withoutUser.slice(separator + 1);

  // 残りの最後の区切り以降がフォルダ名の元。
  const segments = rest.split(/[/\\:]/);
  const last = segments[segments.length - 1] ?? "";
  const name = stripDotGit(last);

  return usable(name) ? name : "";
}

/**
 * 親フォルダと名前を繋いだプレビュー用のパス。
 *
 * **実際に作られる場所の正は Rust 側**（`CloneOutcome.path`）。こちらは
 * ダイアログに出す目安であり、区切りの流儀を親フォルダから引き継ぐだけ。
 */
export function joinPath(parent: string, name: string): string {
  const base = stripTrailingSeparators(parent.trim());
  const leaf = name.trim();
  if (base === "" || leaf === "") return "";
  // 区切りは親フォルダに合わせる。Windows のパスに `/` を混ぜない。
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${leaf}`;
}

/**
 * 同じフォルダを指しているか。
 *
 * **Rust 側 (`store/mod.rs` の `same_path`) と同じ判定にする。** 末尾の区切りと
 * 大文字小文字だけが違うものを「別の場所」と読むと、既定の保存先が
 * `C:\Gitwork` と `C:\Gitwork\` の間で往復し、**毎回書き換わっているように見える**
 * （T-19 の目視で報告された）。
 */
export function samePath(a: string, b: string): boolean {
  const left = stripTrailingSeparators(a.trim());
  const right = stripTrailingSeparators(b.trim());
  // Windows 専用アプリなので大文字小文字を区別しない（docs/DESIGN.md §10.1）。
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 「この保存先を次回から既定にする」の状態（T-19）。
 *
 * **どの状態でもチェックボックスを消さない。** 消すと、既定がどこにあるのか
 * 画面から読めなくなり、勝手に変わっているようにしか見えない（目視で報告された）。
 * 押せないときは押せない理由を添えて出す。
 */
export type RememberOption = {
  /** チェックできるか。押しても何も変わらない状態では false。 */
  enabled: boolean;
  /**
   * - `empty`   … 保存先がまだ空欄
   * - `same`    … その場所が既に既定
   * - `unset`   … 既定がまだ無い
   * - `replace` … 既定を別の場所へ移す
   */
  kind: "empty" | "same" | "unset" | "replace";
  /** いま設定されている既定。無ければ null。**文言に必ず出す。** */
  current: string | null;
};

export function rememberOption(parent: string, currentDefault: string | null): RememberOption {
  const trimmed = parent.trim();
  if (trimmed === "") {
    return { enabled: false, kind: "empty", current: currentDefault };
  }
  if (currentDefault === null || currentDefault.trim() === "") {
    return { enabled: true, kind: "unset", current: null };
  }
  if (samePath(trimmed, currentDefault)) {
    return { enabled: false, kind: "same", current: currentDefault };
  }
  return { enabled: true, kind: "replace", current: currentDefault };
}

/**
 * 末尾の `/` と `\` を落とす。**ルート（`C:\` や `/`）は削り切らない。**
 */
function stripTrailingSeparators(value: string): string {
  const stripped = value.replace(/[\\/]+$/, "");
  return stripped === "" ? value : stripped;
}

/** 末尾の `.git` を落とす。`.git` そのものは名前にならないので空になる。 */
function stripDotGit(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -".git".length) : value;
}

/** フォルダ名として使えるか。使えなければ利用者に入力させる。 */
function usable(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (UNUSABLE.test(name)) return false;
  // Windows は末尾の `.` と空白を落とすので、意図と違う名前になる。
  return !/[. ]$/.test(name);
}
