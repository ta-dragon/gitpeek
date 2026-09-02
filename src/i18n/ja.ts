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
    // 素性の表示。ahead/behind と dirty は T-16 / T-17 で中身が入る。
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
    // 分母は前回の件数なので「約」を外さないこと。
    progressOf: (done: number, total: number) =>
      `${done.toLocaleString()} / 約 ${total.toLocaleString()} 件`,
    progressPercent: (ratio: number) => `約 ${Math.round(ratio * 100)}%`,
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

  phase: {
    title: "Phase 1 — リポジトリ管理",
    body: "リポジトリの登録・切替と、全コミットの一括取得までが動いています。コミットグラフと差分は Phase 2 以降でこの領域に入ります。",
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
