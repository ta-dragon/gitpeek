/**
 * 表示文言はすべてこのファイルに集約する（docs/DESIGN.md §6.1）。
 *
 * コンポーネントに文字列を直書きしないこと。i18n ライブラリは入れないが、
 * ここに集約しておけば将来の差し替えが 1 箇所で済む。
 */
export const ja = {
  app: {
    name: "Givsoner",
    tagline: "個人用 Git ビューワー",
  },

  common: {
    detail: "詳細",
    close: "閉じる",
    cancel: "キャンセル",
    notImplemented: "未実装",
  },

  repositories: {
    title: "リポジトリ",
    add: "リポジトリを追加",
    addShort: "追加",
    scan: "フォルダをスキャン",
    scanShort: "スキャン",
    clone: "URL から clone",
    remove: "登録解除",
    removeHint: "一覧から外すだけで、フォルダは削除しません。",
    relocate: "再指定",
    relocateHint: "移動・リネームしたフォルダを指定し直します。",
    contextHint: "右クリックで登録解除",
    empty: "リポジトリが登録されていません。",
    missing: "フォルダが見つかりません",
    sortLabel: "並び順",
    sortManual: "手動",
    sortRecent: "最終アクセス順",
    dragHint: "ドラッグで並べ替え",
    dragDisabled: "並び順が「手動」のときだけ並べ替えられます。",
    fetch: "fetch",
    fetchHint: "リモートから取ってきます（取ってくるだけで、作業ツリーには触りません）。",
    fetchAll: "全て fetch",
    fetchAllHint: "登録済みのリポジトリを 1 つずつ順に fetch します。",
    // 素性の表示。ahead/behind は T-17 で中身が入る。
    bare: "bare",
    shallow: "shallow",
    detached: "detached",
    unborn: "コミットなし",
    indexLock: "index.lock 残留",
    indexLockDetail:
      "他の git プロセスが動作中の可能性があります。Givsoner はこのファイルを削除しません。",
    notRepository: "git リポジトリではありません",
    selectFolder: "リポジトリのフォルダを選択",
    selectScanRoot: "スキャンするフォルダを選択",
    scanFound: (n: number) => `${n} 個のリポジトリを登録しました。`,
    scanNotFound: "リポジトリは見つかりませんでした。",
    head: "HEAD",
    path: "パス",
    // 放置警告。**アイコンとツールチップだけ**にする（docs/DESIGN.md §8.3）。
    stale: "⏳",
    staleHint: (days: number | null) =>
      days === null
        ? "まだ一度も fetch していません。"
        : `最後に fetch してから ${days} 日経っています。`,
  },

  snapshot: {
    loading: "履歴を読み込んでいます…",
    failedTitle: "履歴を読み込めませんでした",
    reload: "読み直す",
    commits: "コミット",
    branches: "ブランチ",
    branchCounts: (local: number, remote: number) =>
      `ローカル ${local} / リモート ${remote}`,
    tags: "タグ",
    defaultBranch: "幹（lane 0）",
    elapsed: (ms: number) => `${ms} ms`,
    count: (n: number) => `${n} 件`,
    none: "—",
    emptyRepository: "コミットがまだありません。",
    outOfGraph: (n: number) => `グラフ外の ref ${n} 件`,

    // 大きすぎて自動では読まなかったとき。
    oversizedTitle: "大きなリポジトリです",
    oversizedBody: (commits: number) =>
      `前回は ${commits.toLocaleString()} コミットありました。読み込みに数十秒かかり、` +
      `メモリを数 GB 使います。その間このウィンドウは操作できません。`,
    oversizedNote:
      "Givsoner が想定しているのは数万コミットまでです（docs/DESIGN.md §4.1）。" +
      "この規模の正式対応は v1.1 以降で行います。" +
      "リリースビルド（npm run start:release）の方が大幅に速く終わります。",
    oversizedLoad: "それでも読み込む",

    // 途中経過。段階の名前は Rust 側の LoadPhase と対応する。
    progressRefs: "ref を読んでいます…",
    progressCommits: "コミットを読んでいます…",
    progressGraph: "グラフを組み立てています…",
    progressTransfer: "画面へ渡しています…",
    progressCount: (done: number) => `${done.toLocaleString()} 件`,
    // **履歴の読み込みでは分母が前回の件数なので「約」を外さないこと。**
    // 分母が正確な場面（fetch のオブジェクト数など）には exact の方を使う。
    progressOf: (done: number, total: number) =>
      `${done.toLocaleString()} / 約 ${total.toLocaleString()} 件`,
    progressPercent: (ratio: number) => `約 ${Math.round(ratio * 100)}%`,
    // 分母が正確なとき。**「約」を付けると逆に嘘になる。**
    progressExactOf: (done: number, total: number) =>
      `${done.toLocaleString()} / ${total.toLocaleString()} 件`,
    progressExactPercent: (ratio: number) => `${Math.round(ratio * 100)}%`,
    progressElapsed: (seconds: number) => `${seconds} 秒経過`,
  },

  palette: {
    placeholder: "リポジトリ名またはパスで絞り込み",
    empty: "一致するリポジトリがありません",
    hint: "↑↓ で選択 / Enter で開く / Esc で閉じる",
  },

  emptyState: {
    title: "リポジトリを追加してください",
    body: "ローカルの git リポジトリを登録すると、履歴の閲覧を始められます。",
    cloneDisabled: "clone は未実装です（T-19 で実装）。",
  },

  crash: {
    title: "画面の描画で問題が起きました",
    body: "この画面は Givsoner の不具合です。下の内容を添えて報告してください。",
    stack: "発生箇所",
    reload: "再読込",
  },

  theme: {
    label: "テーマ",
    system: "OS に従う",
    light: "ライト",
    dark: "ダーク",
  },

  setup: {
    detecting: "git を確認しています…",
    notFoundTitle: "git が見つかりません",
    notFoundBody:
      "Givsoner は git がインストールされている環境でのみ動作します。git をインストールするか、実行ファイルのフルパスを指定してください。",
    tooOldTitle: "git のバージョンが古すぎます",
    tooOldBody: (found: string, min: string) =>
      `検出されたバージョンは ${found} ですが、Givsoner は ${min} 以上を必要とします。git を更新してください。`,
    unreadableTitle: "git のバージョンを判定できません",
    installLabel: "Git for Windows をダウンロード",
    installUrl: "https://git-scm.com/download/win",
    installUrlHint: "ボタンが動作しない場合は上の URL をブラウザで開いてください。",
    pathLabel: "git 実行ファイルのフルパス（PATH に無い場合のみ）",
    pathPlaceholder: "C:\\Program Files\\Git\\cmd\\git.exe",
    recheck: "再チェック",
    rechecking: "確認中…",
    errorLabel: "エラー",
  },

  settings: {
    recoveredTitle: "settings.json を読み込めなかったため既定値で起動しました",
    recoveredDetail: (backupPath: string, reason: string) =>
      `元の内容は ${backupPath} へ退避しました（${reason}）。`,
    loadFailedTitle: "設定を読み込めませんでした",
    saveFailedTitle: "設定を保存できませんでした",
  },

  status: {
    version: "バージョン",
    path: "パス",
    ready: "git を検出しました",
  },

  commits: {
    graph: "グラフ",
    subject: "メッセージ",
    author: "作者",
    date: "日時",
    sha: "SHA",
    emptySubject: "（メッセージなし）",
    // detached HEAD の行に付ける印。ブランチ名が無い状態。
    detachedHead: "HEAD",
    moreRefs: (n: number) => `+${n}`,
    // orphan ブランチのチップに付ける印と、その説明（ホバーで出る）。
    orphanMark: "⊥",
    orphanHint: "orphan ブランチ（他の履歴と繋がっていません）",
    total: (n: number) => `${n.toLocaleString()} 件`,
    jumpLabel: "SHA へ移動",
    jumpPlaceholder: "SHA を貼り付け（前方一致）",
    jumpNotFound: "見つかりません",
    // Alt+← / Alt+→ で親・子が複数あるときの選択メニュー。
    parent: "親",
    child: "子",
    empty: "コミットがありません。",
  },

  refTree: {
    title: "ブランチ / タグ",
    filterPlaceholder: "ブランチ・タグを絞り込み",
    filterClear: "絞り込みを消す",
    empty: "ref がありません。",
    filterEmpty: "一致する ref がありません。",

    // ツリーの開閉。三角は CSS で描くので、読み上げ用の名前だけ持つ。
    expand: "開く",
    collapse: "畳む",

    // 最上段のグループ。リモートは `リモート > origin` のように名前を添える。
    groupLocal: "ローカル",
    groupRemote: (remote: string) => `リモート > ${remote}`,
    groupTag: "タグ",
    groupCount: (n: number) => `${n}`,

    // 表示 ON/OFF のプリセット（docs/DESIGN.md §4.4）。
    presetAll: "全選択",
    presetNone: "全解除",
    presetLocal: "ローカルのみ",
    presetRemote: "リモートのみ",
    // タグにチェックが無い理由。プリセット行のホバーで出す。
    presetHint:
      "チェックはグラフの起点になるブランチだけに効きます。タグは起点にしないため、" +
      "チェックボックスを置いていません（docs/DESIGN.md §4.2）。",
    checkHint: (shortName: string) => `${shortName} をグラフに出す`,

    // ahead/behind（docs/DESIGN.md §4.5）。上流の無いブランチには何も出さない。
    ahead: (n: number) => `↑${n}`,
    behind: (n: number) => `↓${n}`,
    upstreamSynced: (upstream: string) => `上流 ${upstream} と同じ`,
    upstreamDiff: (upstream: string, ahead: number, behind: number) =>
      `上流 ${upstream} より ${ahead} 件進み / ${behind} 件遅れ`,

    // ref に付く印。
    outOfGraph: "外",
    outOfGraphHint: "読み込んだコミットの外を指しています。ジャンプできません。",
    headHint: "HEAD が乗っています",

    // 右クリックメニュー。
    checkout: "checkout",
    merge: "現在のブランチに FF マージ",
    notYet: "T-18 で実装します。",
    onlyThis: "このブランチだけ表示",
    jump: "先頭コミットへジャンプ",
    copyName: "名前をコピー",
    copySha: "SHA をコピー",
    copied: (text: string) => `コピーしました: ${text}`,
    copyFailed: "クリップボードへコピーできませんでした。",
  },

  // fetch（T-17。docs/DESIGN.md §8.3）。
  fetch: {
    title: "fetch",
    running: (name: string) => `${name} を fetch しています…`,
    ofRepositories: (done: number, total: number) => `リポジトリ ${done} / ${total}`,
    cancel: "中止",
    close: "閉じる",
    // **中止しても取り込み済みの ref は戻らない。** 黙って閉じない。
    cancelling: "中止しています…",

    // 一括の実行前確認。**1 回だけ出す**（1 件ずつ聞かない）。
    confirmTitle: "全て fetch しますか？",
    confirmBody: (n: number) => `${n} 件のリポジトリを 1 つずつ順に fetch します。`,
    confirmAuth:
      "資格情報の期限が切れているリモートがあると、認証ウィンドウが前面に出ることがあります。",
    confirmRun: "実行する",
    confirmCancel: "やめる",

    // 結果。
    summaryTitle: "fetch の結果",
    summary: (success: number, failed: number) => `成功 ${success} / 失敗 ${failed}`,
    cancelledCount: (n: number) => `中止 ${n}`,
    skipped: (n: number) => `未実行 ${n}`,
    statusSuccess: "成功",
    // 一部だけ取り込めた。**失敗と分ける** — ブランチは取り込めているため。
    statusPartial: "一部",
    partialCount: (n: number) => `一部 ${n}`,
    statusFailed: "失敗",
    statusCancelled: "中止",
    details: "詳細",
    // 一括ボタンが押せないときの説明。リモートを持つ登録が 1 つも無い場合。
    noRepositories: "fetch できるリポジトリがありません（リモートが登録されていません）。",
  },

  // 作業ツリー（T-16。docs/DESIGN.md §7.5）。**read-only なので操作の文言は無い。**
  workingTree: {
    row: "作業ツリー",
    title: "作業ツリーの変更",
    reload: "取り直す",
    sections: {
      unmerged: "衝突",
      staged: "ステージ済み",
      unstaged: "未ステージ",
      untracked: "未追跡",
    },
    count: {
      unmerged: (n: number) => `衝突 ${n}`,
      staged: (n: number) => `ステージ済み ${n}`,
      unstaged: (n: number) => `未ステージ ${n}`,
      untracked: (n: number) => `未追跡 ${n}`,
    },
    // 未追跡は差分にしない（全行追加の差分はノイズが大きすぎる）。
    untrackedBody: "まだ git が知らないファイルです。差分ではなく全文を出しています。",
    conflictBody: "衝突しています。解決は git のコマンドで行ってください。",
    readFailed: "ファイルを読めませんでした",
    tooLarge: (size: string) => `大きすぎるので表示しません（${size}）。`,
    indexLock: "`.git/index.lock` が残っています。別の git が動いているかもしれません。",
    empty: "作業ツリーに変更はありません。",
    failed: "作業ツリーの状態を取得できませんでした",
  },

  // 2 点比較（T-15。docs/DESIGN.md §10.3）。
  compare: {
    title: "2 点比較",
    from: "比較元",
    to: "比較先",
    swap: "入れ替え",
    clear: "比較をやめる",
    symmetric: "マージベース起点",
    symmetricHint:
      "分岐したところを起点に、比較先で起きた変更だけを出します（git diff A...B）。",
    outsideGraph: "（読み込んだ範囲の外）",
    // 共通の祖先が無いときの説明は Rust 側（`git/diff.rs` の `explain`）にある。
    // git のエラーを言い換えるものなので、出どころと同じところに置く。
    hint: "Ctrl+クリックで 2 点比較",
  },

  diff: {
    // 右ペイン上段 — コミット詳細。
    empty: "コミットを選んでください。",
    loading: "読み込んでいます…",
    failed: "コミットの内容を取得できませんでした",
    retry: "もう一度試す",
    author: "作者",
    committer: "コミッター",
    parents: "親",
    sha: "SHA",
    noParent: "なし（ルートコミット）",
    // author と committer が同じなら 1 行にまとめる。
    sameAsAuthor: "作者と同じ",
    copySha: "SHA をコピー",
    copied: (text: string) => `コピーしました: ${text}`,
    copyFailed: "クリップボードへコピーできませんでした。",

    // マージコミットの親選択（docs/DESIGN.md §7.4）。
    compareWith: "比較する親",
    parentNth: (n: number) => `第 ${n} 親`,
    mergeNote: "マージコミットの差分は親ごとに異なります。",

    // 右ペイン下段 — 変更ファイル一覧。
    files: "変更ファイル",
    fileCount: (n: number) => `${n} ファイル`,
    additions: (n: number) => `+${n}`,
    deletions: (n: number) => `-${n}`,
    binaryCount: (n: number) => `バイナリ ${n}`,
    noFiles: "変更されたファイルはありません。",
    layoutFlat: "フラット",
    layoutTree: "ツリー",
    layoutLabel: "一覧",
    binary: "バイナリ",
    renamedFrom: (oldPath: string) => `${oldPath} から`,
    modeChanged: (oldMode: string, newMode: string) => `モード ${oldMode} → ${newMode}`,
    // 状態の 1 文字。色はテーマトークンで付ける。
    statusAdded: "A",
    statusModified: "M",
    statusDeleted: "D",
    statusRenamed: "R",
    statusCopied: "C",
    statusTypeChanged: "T",
    statusUnknown: "?",
    statusName: {
      added: "追加",
      modified: "変更",
      deleted: "削除",
      renamed: "リネーム",
      copied: "コピー",
      typeChanged: "型変更",
      unknown: "不明",
    },
    keyHint: "Alt+↑ / Alt+↓ でファイル移動",

    // 中央下 — 差分本体（T-13）。
    selectFile: "ファイルを選ぶと、ここに差分が出ます。",
    diffFailed: "差分を取得できませんでした",
    binaryBody: "バイナリファイルのため、差分は表示できません。",
    /*
     * バイナリは行数の代わりにサイズの変化を出す（docs/DESIGN.md §7.2）。
     * **片側が無いときは「なし」**。0 と書くと「空のファイルになった」に読める。
     */
    binarySize: (before: string, after: string) => `サイズ ${before} → ${after}`,
    sizeUnknown: "なし",

    // 大差分の折りたたみ（T-14）。
    collapsedTitle: "大きな差分です",
    collapsedDetail: (lines: number, size: string) =>
      `${lines} 行 / ${size} あります。開くと表示が重くなることがあります。`,
    expand: "それでも表示する",
    noHunks: "内容の変更はありません（リネームやモードの変更だけです）。",
    symlink: "シンボリックリンク",

    // ツールバー。表示の切替は settings.json に残す（文字コードの上書きだけ残さない）。
    viewLabel: "表示",
    layoutSideBySide: "並べて",
    layoutUnified: "1 列",
    contextLabel: "前後",
    contextLines: (n: number) => `${n} 行`,
    contextAll: "すべて",
    ignoreWhitespace: "空白を無視",
    ignoreWhitespaceHint: "空白だけの違いを差分に出しません（git diff -w）。",
    showLineEndings: "改行を表示",

    // 文字コード（docs/DESIGN.md §9.1）。
    encodingLabel: "文字コード",
    encodingAuto: (name: string) => `自動（${name}）`,
    encodingAutoUnknown: "自動",
    encodingNames: {
      utf8: "UTF-8",
      shiftJis: "Shift_JIS",
      eucJp: "EUC-JP",
    },
    encodingHint:
      "判別は UTF-8 → Shift_JIS → EUC-JP の順です。当たらないときは指定し直してください。",
    lossy: "文字化けの可能性",
    lossyHint: "指定した文字コードで読めない部分がありました。指定を変えてみてください。",

    // 改行コード（docs/DESIGN.md §9.2）。
    lineEndingNames: {
      lf: "LF",
      crlf: "CRLF",
      cr: "CR",
    },
    lineEndingNone: "改行なし",
    lineEndingHint: "このファイルの改行コードです。",
    lineEndingMixed: "改行コード混在",
    lineEndingMixedHint: (lf: number, crlf: number, cr: number) =>
      `1 つのファイルに複数の改行コードがあります（LF ${lf} / CRLF ${crlf} / CR ${cr}）。`,
    /*
     * 可視化記号（サクラエディタに合わせる）。**本文ではない**ので、
     * コピーに混ざらないよう別要素で出す。
     * CR は「行頭へ戻る」、LF は「次の行へ送る」。CRLF はその 2 つが続く。
     */
    eolMarks: {
      lf: "↓",
      crlf: "→↓",
      cr: "→",
    },
    noNewlineMark: "改行なし",
    noNewline: "ファイルの末尾に改行がありません。",

    // hunk の見出し。git の `@@ -a,b +c,d @@` と同じ意味を日本語で添える。
    hunkRange: (oldStart: number, oldLines: number, newStart: number, newLines: number) =>
      `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
  },

  graph: {
    title: "コミットグラフ",
    // 仮想スクロールが入るまでの仮の蓋（T-07 で外す）。
    truncated: (shown: number, total: number) =>
      `先頭 ${shown.toLocaleString()} 行のみ表示しています（全 ${total.toLocaleString()} 行）。`,
    unavailable: "レーンを計算できませんでした。",
    order: "並び順",
    orderTopo: "topo",
    orderDate: "日時",
    // date-order は線が交差する（docs/DESIGN.md §4.3）。
    orderDateNote: "この表示では線が交差します。",
    maxLane: (lanes: number) => `レーン ${lanes}`,
  },

  phase: {
    title: "Phase 2 — コミットグラフ",
    body: "リポジトリの登録・切替、全コミットの一括取得、レーン計算とグラフ描画までが動いています。",
    next: "実装フェーズは CLAUDE.md §9 を参照。",
  },

  commandLog: {
    title: "git コマンドログ",
    show: "コマンドログを表示",
    hide: "コマンドログを隠す",
    empty: "まだ git コマンドを実行していません。",
    showFixedArgs: "固定オプションを表示",
    capacity: (n: number) => `直近 ${n} 件を保持`,
    exit: "exit",
    failedToStart: "起動失敗",
    entryCount: (n: number) => `${n} 件`,
  },
} as const;
