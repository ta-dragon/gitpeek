/**
 * 表示文言はすべてこのファイルに集約する（docs/DESIGN.md §6.1）。
 *
 * コンポーネントに文字列を直書きしないこと。i18n ライブラリは入れないが、
 * ここに集約しておけば将来の差し替えが 1 箇所で済む。
 */
export const ja = {
  app: {
    name: "GitPeek",
    tagline: "個人用 Git ビューワー",
  },

  common: {
    detail: "詳細",
    close: "閉じる",
    cancel: "キャンセル",
  },

  repositories: {
    title: "リポジトリ",
    add: "リポジトリを追加",
    addShort: "追加",
    scan: "フォルダをスキャン",
    scanShort: "スキャン",
    clone: "URL から clone",
    remove: "登録解除",
    removeHint: "一覧から外すだけ。フォルダは消えません。",
    relocate: "再指定",
    relocateHint: "移動したりリネームしたあとのフォルダを選び直します。",
    reveal: "エクスプローラーで開く",
    revealHint: "フォルダをエクスプローラーで開きます。",
    revealFailed: (reason: string) => `フォルダを開けませんでした。${reason}`,
    contextHint: "右クリックで登録解除",
    empty: "まだ何も登録されていません。",
    missing: "フォルダが見つかりません",
    sortLabel: "並び順",
    sortManual: "手動",
    sortRecent: "最終アクセス順",
    dragHint: "ドラッグで並べ替え",
    dragDisabled: "並び順が「手動」のときだけ並べ替えられます。",
    fetch: "fetch",
    fetchHint: "リモートから取ってくるだけ。作業ツリーには触りません。",
    fetchAll: "全て fetch",
    fetchAllHint: "登録してあるリポジトリを順に fetch します。",
    cloneShort: "clone",
    cloneHint: "URL を指定して新しく取り込みます。履歴は丸ごと持ってきます。",
    // 素性の表示。ahead/behind は T-17 で中身が入る。
    bare: "bare",
    shallow: "shallow",
    detached: "detached",
    unborn: "コミットなし",
    indexLock: "index.lock 残留",
    indexLockDetail:
      "ほかで git が動いているのかもしれません。このファイルには触りません。",
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
        : `fetch してから ${days} 日経っています。`,
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
      `メモリを数 GB 使います。終わるまでこのウィンドウは操作できません。`,
    oversizedNote:
      "想定しているのは数万コミットまでです（docs/DESIGN.md §4.1）。" +
      "この規模にきちんと対応するのは v1.1 以降です。" +
      "リリースビルド（npm run start:release）ならかなり速く終わります。",
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
    title: "まずリポジトリを追加",
    body: "手元の git リポジトリを登録するか、URL から clone すると始まります。",
  },

  /**
   * clone（T-19。docs/DESIGN.md §8.4）。
   *
   * **何が起きるかで書く。** 「clone」は git の用語だが、ここでは
   * 「どこに何ができるのか」を毎回 1 行で見せることで補う（`preview`）。
   */
  clone: {
    title: "URL から clone",
    lead: "URL を入れると、指定した場所にフォルダを作って取り込みます。",

    urlLabel: "URL",
    urlPlaceholder: "https://github.com/owner/repo.git  または  git@github.com:owner/repo.git",
    parentLabel: "保存先の親フォルダ",
    parentPlaceholder: "取り込み先のフォルダをフルパスで",
    folderLabel: "作るフォルダの名前",
    folderPlaceholder: "URL から決められないときだけ",
    browse: "参照…",

    // **どこに何ができるのかを 1 行で見せる。** 2 つの欄をどう繋ぐかは
    // 利用者が気にすることではない。
    preview: (path: string) => `${path} を新しく作って、そこへ取り込みます。`,
    previewEmpty: "URL と保存先を入れると、できあがる場所がここに出ます。",

    // --- 選択肢 -------------------------------------------------------
    //
    // **ラベルだけでは何が変わるか読めない**ので、下に 1 行で結果を書く
    // （T-18 の「FF マージ」と同じ失敗をしないため）。

    // サブモジュール。**既定 OFF**（CLAUDE.md §1 — 黙って取り込まない）。
    submodules: "サブモジュールも取り込む",
    submodulesNote:
      "このリポジトリが参照している別のリポジトリも一緒に取り込みます。そのぶん時間がかかり、リモートごとに認証を求められることがあります。",
    // 実行中に出す。何度も 0 に戻るのを「やり直している」と読まれないように。
    submodulesProgressNote:
      "サブモジュールは 1 つずつ取り込みます。進捗はそのたびに 0 から数え直します。",

    // 保存先を覚える。**T-25 で設定画面からも変えられるようになった**が、
    // clone の流れの中で決められることに意味があるのでこちらも残す。
    //
    // **押せないときも消さずに出す。** 消すと既定がどこにあるのか画面から読めなくなり、
    // 勝手に変わっているようにしか見えない（T-19 の目視で報告された）。
    // どの文言も**いまの既定を必ず出す**こと。
    rememberParent: "この保存先を次回から既定にする",
    // 保存先が空欄。既定はある。
    rememberCurrent: (current: string) =>
      `いまの既定は ${current} です。別の場所を入れると、ここで切り替えられます。`,
    // 保存先が空欄で、既定も無い。
    rememberNoneYet: "既定の保存先はまだありません。保存先を入れると、ここで決められます。",
    // すでにその場所が既定。**押させない。**
    rememberAlready: (current: string) => `この場所（${current}）がすでに既定です。`,
    // 既定がまだ無い。
    rememberFirst: "既定の保存先はまだありません。次に開いたとき、この場所が埋まります。",
    // 既定を別の場所へ移す。
    rememberReplaces: (current: string) =>
      `いまの既定（${current}）を、この場所に置き換えます。`,

    authNote:
      "認証が要るリモートでは、認証ウィンドウが前に出ることがあります。パスワードもトークンも GitPeek は受け取りません。git に任せます。",
    // 提供しないものを先に言う（CLAUDE.md §1）。
    fullHistoryNote:
      "履歴は丸ごと取り込みます。浅い clone やブランチの指定はしません。",

    run: "clone する",
    dismiss: "やめる",

    running: "clone しています",
    runningInto: (path: string) => `${path} に取り込んでいます。`,
    connecting: "リモートに接続しています…",
    cancel: "中止",
    cancelling: "中止しています…",
    // **中止したら残骸は消す**（fetch と扱いが違う）。
    cancelNote: "中止すると、途中まで取り込んだフォルダごと消します。",

    close: "閉じる",
    // **いちばんありそうな続きは「名前を変えてもう一度」。** 入力欄はそのまま残る。
    back: "入力に戻る",
    details: "詳細",
    // 消せなかったときだけ出す。**黙って残さない。**
    leftover: (path: string) =>
      `途中まで取り込んだフォルダを消せませんでした: ${path}（手で消してください）`,
  },

  crash: {
    title: "画面の描画で問題が起きました",
    body: "GitPeek の不具合です。下の内容を添えて報告してください。",
    stack: "発生箇所",
    reload: "再読込",

    // --- ログの案内（T-24）-------------------------------------------
    //
    // **無い場所を案内しない。** 書けていないのに「ここに記録があります」と
    // 出すと、開いて空だったときに何が起きたのか分からなくなる。
    logChecking: "記録の場所を確認しています。",
    logNowhere: "記録の置き場所を決められなかったので、ログは残っていません。",
    logAt: (dir: string) => `詳しい記録は ${dir} にあります。`,
    logNotWriting: (problem: string, dir: string) =>
      `今回の記録は残せませんでした（${problem}）。前回までの記録は ${dir} にあります。`,
    logUnknownProblem: "理由は分かりません",
    logNotWritingTitle: "今回の記録をログファイルに残せません",
    openLogFolder: "ログフォルダを開く",
    openLogFolderFailed: "ログフォルダを開けませんでした。",
    unknownReason: "理由が分かりません。",

    // --- Rust 側が落ちたとき（T-24）------------------------------------
    //
    // **画面は生きているが、以後の操作は当てにならない。** 何が起きたかと、
    // どうすればよいかを出す。
    panicTitle: "内部で問題が起きました",
    panicBody:
      "これ以降の操作は当てになりません。GitPeek を再起動してください。",
    panicDetail: "発生内容",
    close: "閉じる",
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
      "GitPeek は git が無いと動きません。git を入れるか、実行ファイルのフルパスを指定してください。",
    tooOldTitle: "git のバージョンが古すぎます",
    // 下限は 2.38（T-37）。**なぜその版なのか**を書く — 数字だけだと、更新してよいのか迷う。
    tooOldBody: (found: string, min: string) =>
      `見つかったのは ${found} でした。GitPeek には ${min} 以上が要ります（ブランチが取り込まれているかを調べるのに、この版から入った機能を使います）。git を更新してください。`,
    unreadableTitle: "git のバージョンを判定できません",
    installLabel: "Git for Windows をダウンロード",
    installUrl: "https://git-scm.com/download/win",
    installUrlHint: "ボタンが効かないときは、上の URL をブラウザで開いてください。",
    pathLabel: "git 実行ファイルのフルパス（PATH に無い場合のみ）",
    pathPlaceholder: "C:\\Program Files\\Git\\cmd\\git.exe",
    recheck: "再チェック",
    rechecking: "確認中…",
    errorLabel: "エラー",
  },

  settings: {
    // --- 設定画面（T-25）------------------------------------------------
    title: "設定",
    open: "設定",
    close: "閉じる",
    // タブ。**リポジトリ 1 つぶんの設定はここに出さない**（CLAUDE.md §6）。
    tabs: {
      general: "一般",
      view: "表示",
      diff: "差分",
      fetch: "fetch",
      review: "AI レビュー",
      skills: "観点",
      keys: "ショートカット",
      logs: "ログ",
    },
    repositoryElsewhere:
      "リポジトリごとの設定（表示するブランチ・既定の接続先・リポジトリ内の観点）は、一覧を右クリックして開きます。",

    // 一般
    gitPath: "git 実行ファイルのフルパス",
    gitPathNote: "空欄なら PATH の git を使います。変えると、その場で確認し直します。",
    gitPathChecking: "確認しています…",
    gitPathOk: (version: string, path: string) => `${version} を ${path} で使います。`,
    gitPathNg: (reason: string) => `使えません: ${reason}`,
    workspaceRoot: "clone の既定の保存先",
    workspaceRootNote: "URL から clone するとき、保存先の親フォルダに最初から入ります。",
    workspaceRootEmpty: "まだ決めていません。clone の画面で「この保存先を次回から既定にする」を押すと入ります。",
    // **コマンドログの出し入れはここだけ**（T-25。2026-09-06 に利用者が決めた）。
    // ヘッダのボタンは畳んだので、**戻し方を消えたときの文言に書く**（CLAUDE.md §6）。
    showCommandLog: "git コマンドログのパネルを出す",
    showCommandLogOn: "画面の下に、実行した git コマンドと結果（exit code・stderr・所要時間）が出ます。",
    showCommandLogOff: "パネルは出ません。もう一度出すには、ここへ戻ってチェックを入れます。",

    // 表示
    dateFormat: "日時の出し方",
    dateRelative: "経過時間（3 日前）",
    dateAbsolute: "日時（2026-09-06 15:32）",
    commitOrder: "コミットの並び順",
    orderTopo: "枝のつながり順（topo）",
    orderDate: "日時順（date）",

    // 差分
    diffLayout: "差分の並べ方",
    layoutSideBySide: "左右に並べる",
    layoutUnified: "1 列にまとめる",
    contextLines: "変更の前後に出す行数",
    ignoreWhitespace: "空白の違いを無視する",
    showLineEndings: "改行の記号を出す",
    collapseLines: "この行数を超える差分は畳む",
    collapseBytes: "この大きさ（バイト）を超える差分は畳む",
    collapseNote: "どちらか一方でも超えたら畳みます。開くボタンはその場に出ます。",

    // fetch
    staleWarningDays: "fetch していない日数の警告",
    staleWarningNote: (days: number) =>
      days === 0
        ? "0 なので、放置していても警告しません。"
        : `最後の fetch から ${days} 日を過ぎたリポジトリに印を出します。`,

    // AI レビュー
    reviewConcurrency: "同時に投げるファイル数",
    reviewConcurrencyNote:
      "ローカルの接続先では、増やすとかえって遅くなることがあります（既定は 1）。",
    reviewContextLines: "モデルへ渡す変更の前後の行数",

    // ログ
    logsWhere: "ログの置き場所",
    logsNote: "git の実行と、起きた問題を 7 日分残します。差分やレビューの本文は書きません。",

    // 入力の検証。**理由は欄の下に 1 行**（欄は消さない。CLAUDE.md §6）。
    form: {
      empty: "空欄です。数字を入れてください。",
      notANumber: "数字だけを入れてください（小数と符号は使えません）。",
      outOfRange: (min: number, max: number) =>
        `${min.toLocaleString()} から ${max.toLocaleString()} までの数字を入れてください。`,
      unsaved: "この値は保存していません。",
    },

    recoveredTitle: "settings.json を読めなかったので、既定値で起動しました",
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
    // checkout で HEAD が動くと選択行が遠くに残るので、戻る道を見えるところに置く。
    toHead: "HEAD へ",
    toHeadHint: "いまチェックアウトしているコミットへ移動します（Ctrl+H）。",
    // Alt+← / Alt+→ で親・子が複数あるときの選択メニュー。
    parent: "親",
    child: "子",
    empty: "コミットがありません。",

    // 行の右クリック（T-18。docs/DESIGN.md §8.1）。
    // **コミットへの checkout は必ず detached。** ブランチを作る経路はここに置かない。
    checkoutHere: "このコミットを checkout（detached）",
    // ref チップの右クリック。名前を入れて、行のメニューと取り違えないようにする。
    checkoutRef: (name: string) => `${name} を checkout`,
    copySha: "SHA をコピー",
    // **全文。** 一覧が持っているのは要約 1 行なので、git に聞き直している。
    copyMessage: "コミットメッセージをコピー",
    copied: (text: string) => `コピーしました: ${text}`,
    // 全文は長いので、通知には字数だけ出す。
    copiedMessage: (lines: number) => `コミットメッセージをコピーしました（${lines} 行）`,
    copyFailed: "クリップボードへコピーできませんでした。",

    // コミット検索（T-35。docs/DESIGN.md §6.6）。
    // **隣の SHA 欄と見分けが付くよう、書き出しを分けてある**（「SHA」と「ことば」）。
    searchLabel: "ことばで探す",
    searchPlaceholder: "メッセージか作者から探す",
    searchHint:
      "そのまま打つと、メッセージか作者のどちらかに入っているコミットを探します。" +
      "message: / author: / code: を付けると、その指定どうしを重ねて絞り込めます。" +
      "空白を含めたいときは引用符で囲みます。",
    searchRun: "探す",
    searchClear: "やめる",
    searchPrev: "前へ",
    searchNext: "次へ",
    searchRunning: "探しています…",
    // 何件目を見ているか。件数だけだと、辿っている途中かどうかが読めない。
    searchPosition: (current: number, total: number) => `${current} / ${total} 件`,
    searchNone: "当たりませんでした。",
    // 可視 ref の絞り込みで行が無いもの。**黙って落とすと「探したのに出ない」になる。**
    searchHidden: (n: number) =>
      `いま表示していないブランチの側に ${n} 件あります（ブランチ / タグの一覧でチェックを付けると出ます）。`,
    searchDuplicate: (key: string) => `${key} が 2 つあったので、後のほうだけ使いました。`,
    searchEmptyValue: (key: string) => `${key} のあとが空なので、この指定は使っていません。`,
    // コード内容（code:）を探している間（T-36）。**目安と分かる書き方にする。**
    searchEstimate: (seconds: number, elapsed: number) =>
      `コード内容を探しています。およそ ${seconds} 秒かかります（${elapsed} 秒経過）`,
    // 目安を超えたら**残り時間を言わない**（「あと 0 秒」のまま待たせ続けない）。
    searchOverdue: (elapsed: number) =>
      `コード内容を探しています。見込みより時間がかかっています（${elapsed} 秒経過）`,
    searchCancel: "中止",
    // 中止しても当たったぶんは残す。**0 件でも「当たりませんでした」とは言わない。**
    searchCancelled: "中止しました。出ている当たりは途中までのもので、全部ではありません。",
    searchFailed: "探せませんでした。",
    // 当たりが無いときの「次へ / 前へ」。押せない形で残し、理由を出す（CLAUDE.md §6）。
    searchNothingToStep: "まだ当たりがありません。",
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
      "チェックが効くのはグラフの起点になるブランチだけです。タグは起点にしないので、" +
      "チェックボックスを置いていません（docs/DESIGN.md §4.2）。",
    checkHint: (shortName: string) => `${shortName} をグラフに出す`,

    // 日付でチェックを付け直す（T-33）。**プリセットと同じ「一度きりの操作」**なので、
    // 文言も「〜のみ」に揃えず、押したら終わりだと分かる言い方にする。
    // 日付は `input type="date"` なので、書式の説明は要らない。
    sinceLabel: "更新日で選ぶ",
    sinceApply: "この日以降だけ",
    sinceHint:
      "最後のコミットがこの日以降のブランチだけにチェックを付け直します。ほかのチェックは外れます。" +
      "読み込んだコミットの外を指しているブランチは、いつ動いたか分からないので選びません。",
    // 押せない理由（CLAUDE.md §6）。**項目は消さない。**
    sinceNoDate: "日付を選ぶと押せます",
    // 結果は数で返す。0 件のときに「壊れた」ではなく「その日以降が無い」と読めるように。
    sinceApplied: (n: number) => `${n} 件にチェックを付けました。`,

    // ブランチ一覧の CSV 保存（T-32）。
    csv: {
      save: "CSV に保存",
      saveHint: (n: number) => `チェックが入っている ${n} 件を CSV に保存します`,
      // 押せない理由。プリセットの「全選択」で戻せると分かるように書く。
      saveEmpty: "チェックが入っているブランチがありません。全選択で戻せます",
      saveTitle: "ブランチ一覧を CSV に保存",
      saved: (path: string) => `${path} に保存しました。`,
      // ファイルの中の見出し。**画面には出ないが、利用者が読む文字**なのでここに置く。
      headerName: "ブランチ",
      headerTime: "最終コミット時刻",
    },

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
    // **何が起きるかで書く**（CLAUDE.md §6）。GitPeek がやるのは早送りだけなので、
    // 「取り込む」ではなく「**進める**」と言う（2026-09-08 に利用者が決めた）。
    // 履歴を合流させるのではなく、**ローカルのブランチを相手の位置まで動かすだけ**。
    // こう書くと、**手元にだけあるコミットがあると進められない**ことが言葉から分かる。
    //
    // **違いは書き出しに置く。** 末尾や語の途中に置くと、2 つが並んだときに
    // 同じ書き出しのまま数文字しか違わず、見分けられない（T-31 の目視 1 巡目）。
    // いまは「取ってきてから、」が付くかどうかで、**片方がもう片方＋α**だと読める。
    mergeInto: (into: string, from: string) =>
      `ローカルの ${into} を ${from} まで進める`,
    // detached では進める対象が無い。理由はダイアログで説明する。
    merge: "現在のブランチを進める",
    mergeHint:
      "リモートには問い合わせません。いま手元にある位置まで進めるだけで、作業ツリーもその状態になります。早送り（fast-forward）なので、マージコミットは作らず、手元のコミットも書き換えません。",
    // 取ってきてから進める（T-31）。**merge 側の文をそのまま含む形にする。**
    fetchMergeInto: (into: string, from: string) =>
      `取ってきてから、ローカルの ${into} を ${from} まで進める`,
    fetchMerge: "取ってきてから、現在のブランチを進める",
    fetchMergeHint:
      "先にリモートへ問い合わせて新しくしてから、進められるときだけ進めます。進められないときは、何もせずに理由を出します。",
    // 押せないときの理由。**項目は消さずに出す**（CLAUDE.md §6）。
    fetchMergeDetached:
      "いまブランチから外れている（detached HEAD）ので、進める対象のブランチがありません。先にブランチへ切り替えてください。",
    fetchMergeLocal:
      "手元にしかないブランチなので、取ってくる先がありません。origin などのリモート追跡ブランチを右クリックしてください。",
    onlyThis: "このブランチだけ表示",
    jump: "先頭コミットへジャンプ",
    copyName: "名前をコピー",
    copySha: "SHA をコピー",
    copied: (text: string) => `コピーしました: ${text}`,
    copyFailed: "クリップボードへコピーできませんでした。",
  },

  // ブランチが取り込まれているか（T-38。docs/DESIGN.md §7.6）。
  //
  // **「マージされました」と言わない。** 中身で判断しているので、squash でも cherry-pick でも、
  // 同じ変更を手で書き直した場合でも当たる。言うのは「〈相手〉に入っています」。
  containment: {
    // ブランチ一覧の印。**種類の違いは書き出しに置く**（CLAUDE.md §6）。
    mark: {
      merged: "マージ済み",
      contained: "入っている",
      partial: (upto: number, total: number) => `${upto}/${total} まで`,
      changed: "入った後に変更",
      failed: "調べられず",
    },
    // チップの中の印。幅が無いので記号だけにし、違いは色とホバーで出す。
    chipMark: {
      merged: "✓",
      contained: "✓",
      partial: "◐",
      changed: "✓",
      failed: "?",
    },
    // ホバーの根拠。1 行目に結論、2 行目以降に何で分かったか。
    merged: (target: string) =>
      `${target} に入っています。\nふつうにマージされています（このブランチの先端が ${target} の履歴にあります）。`,
    contained: (target: string, squash: string) =>
      `${target} に入っています。\n${squash} と同じ変更です（squash してマージされたとみられます）。`,
    containedNoSquash: (target: string) =>
      `${target} に入っています。\n仮に ${target} へマージしても中身が変わりません。まとめて入れたコミットは見つかりませんでした（cherry-pick などで少しずつ入ったとみられます）。`,
    partial: (target: string, upto: number, total: number) =>
      `${target} に入っているのは、${total} 個のコミットのうち古いほうから ${upto} 個目までです。\n残りの ${total - upto} 個は入っていません。`,
    partialSquash: (squash: string) => `入っているぶんは ${squash} と同じ変更です。`,
    changed: (target: string, squash: string) =>
      `${target} に入っています。\n${squash} として入ったあと、${target} で同じ所がさらに書き換えられています。`,
    failed: (target: string, reason: string) =>
      `${target} に入っているか調べられませんでした。\n${reason}`,
    // 限界（DESIGN.md §7.6）。どの根拠にも添える。
    byContent:
      "中身で判断しています。同じ変更を別に書き直した場合も「入っている」になります。",
    jumpHint: (squash: string) => `クリックで ${squash} へ移動します。`,
    squashHidden:
      "移動先のコミットはいまグラフに出していません。ブランチ一覧で相手のブランチにチェックを付けると出ます。",

    // 調べている間（ブランチ一覧の見出しの下）。
    progress: (target: string, done: number, total: number) =>
      `${target} に入っているかを調べています（${done} / ${total}）`,
    progressHint:
      "ローカルブランチを 1 本ずつ調べています。調べ終わったものから印が付きます。",
    noTarget:
      "比べる相手が決まらないので、取り込まれているかは調べていません（既定ブランチが見つかりません）。",

    // 右クリック。**方向を名前で書く**（CLAUDE.md §6）。
    check: (target: string) => `${target} に入っているか調べる`,
    checkNoTarget: "取り込まれているか調べる",
    checkHint: "結果はブランチ一覧とチップに印で出ます。",
    // **何が起きるかで書く。** 全部のブランチと比べるので時間がかかることも言っておく。
    findContainers: "このブランチを取り込んでいる可能性があるブランチを調べる…",
    findContainersHint:
      "このブランチより後に動いたブランチを調べ、中身が入っているものを並べます。ブランチが数千本あると数分かかります（途中で止められます）。",
    whyTag: "タグはグラフの起点ではないので、比べる対象にしていません。",
    whyOutOfGraph: "読み込んだコミットの外を指しているので調べられません。",
    whyIsTarget: "比べる相手そのものです。",
    whyNoTarget: "既定ブランチが見つからないので、比べる相手が決まりません。「取り込んでいる可能性があるブランチを調べる…」なら調べられます。",

    // 取り込んでいる可能性があるブランチ（T-38）。結果はこの画面にだけ出す（印にはしない）。
    containersTitle: (branch: string) => `${branch} を取り込んでいる可能性があるブランチ`,
    containersLead:
      "このブランチより後に動いたブランチを調べています。中身で判断するので、squash や cherry-pick で入ったものも見つかります。",
    containersProgress: (done: number, total: number, found: number) =>
      `${total} 本のうち ${done} 本を調べました（見つかったのは ${found} 本）`,
    containersRemaining: (seconds: number) =>
      seconds < 60 ? `（残り 約 ${seconds} 秒）` : `（残り 約 ${Math.ceil(seconds / 60)} 分）`,
    containersStarting: "調べる相手を数えています…",
    containersStop: "止める",
    containersStopping: "止めています（いま調べている 1 本が終わるまで待ちます）…",
    containersNoCandidates:
      "このブランチより後に動いたブランチがありません。取り込んでいるブランチは無いとみられます。",
    containersNone: (checked: number) =>
      `${checked} 本を調べましたが、このブランチを取り込んでいるブランチは見つかりませんでした。`,
    containersFound: (count: number, checked: number) =>
      `${checked} 本を調べ、${count} 本に入っていました。`,
    // **止めたのは利用者**。どこまで調べたか、何が見つかったか、残りをどうしたかの順で書く。
    containersCancelled: (count: number, checked: number, total: number) =>
      count > 0
        ? `止めました。${total} 本のうち ${checked} 本まで調べ、${count} 本に入っていました。残りは調べていません。`
        : `止めました。${total} 本のうち ${checked} 本まで調べ、入っているブランチはまだありません。残りは調べていません。`,
    containersFailures: (n: number) => `${n} 本は調べられませんでした（ホバーで理由）。`,
    containersJumpBranch: "ブランチへ移動",
    containersJumpSquash: (squash: string) => `${squash} へ移動`,
    close: "閉じる",
  },


  // checkout と FF マージ（T-18。docs/DESIGN.md §8.1, §8.2）。
  //
  // **止める理由と注意を混ぜない。** 止める理由が出ているときは実行ボタンを出さない。
  writeOps: {
    close: "閉じる",
    cancel: "やめる",
    details: "詳細",

    // --- checkout -----------------------------------------------------
    checkoutTitle: "checkout",
    // 対象の説明。リモート追跡ブランチだけは切り替え方を選ばせる。
    leadBranch: (name: string) => `ブランチ ${name} に切り替えます。`,
    leadTag: (name: string) => `タグ ${name} に切り替えます。`,
    leadCommit: (sha: string) => `コミット ${sha} に切り替えます。`,
    leadRemote: (name: string) =>
      `リモート追跡ブランチ ${name} です。切り替え方を選んでください。`,

    // 選択肢のボタン。
    actionSwitch: (name: string) => `${name} に切り替える`,
    actionTrack: (name: string) => `ローカルブランチ ${name} を作って切り替える`,
    actionDetach: "detached で開く",

    // 注意（止める理由ではない）。
    noteDetach:
      "detached HEAD になります。ブランチから外れた状態で履歴を見るだけなら、これで足ります。",
    noteTrack: (branch: string, remote: string) =>
      `ローカルブランチ ${branch} を作り、${remote} を追跡します。ref を新しく作る唯一の操作です。`,
    // 未追跡は止めない（docs/DESIGN.md §8.1）。ただし黙って通さない。
    noteUntracked: (n: number) =>
      `未追跡ファイルが ${n} 件あります。checkout で消えることはありませんが、切り替え先に同じ名前のファイルがあると git が拒みます。`,
    // detached から離れると辿れなくなる場合。
    noteLeavingDetached: (sha: string) =>
      `いまの HEAD (${sha}) はどのブランチからも辿れません。離れると戻る手段が無くなるので、必要なら SHA を控えてください。`,

    // --- ブランチを進める（FF マージ）--------------------------------------
    //
    // **「FF マージ」と書かない。** 何が起きるのか分からないという指摘を受けて、
    // まず「早送り」と言い換え、さらに **「進める」** に変えた（2026-09-08）。
    // 履歴を合流させるのではなく、**ローカルのブランチを相手の位置まで動かすだけ**である。
    mergeTitle: "ブランチを進める",
    mergeLead: (branch: string, from: string, n: number) =>
      `ローカルの ${branch} を、いま手元にある ${from} の位置まで進めます。${branch} に無い ${n} 件のコミットが足されます。`,
    // 進められないときも出す。**何ができないのかを先に説明する。**
    mergeHelp:
      "リモートには問い合わせません。取ってくるところからやるなら、右クリックの「取ってきてから」が付いているほうを使ってください。進めるというのは、手元のブランチを相手の位置まで動かす早送り（fast-forward）のことです。マージコミットは作らず、手元のコミットを書き換えたり消したりもしません。だから、手元にだけあるコミットが 1 件でもあると進められません。",
    mergeRun: "進める",
    mergeAhead: (n: number) =>
      `手元にだけあるコミットが ${n} 件あるので、進めるだけでは追いつけません（相手に無いものが手元にあります）。GitPeek は早送り（fast-forward）しかしません。合流させたいときは、ターミナルで merge か rebase を使ってください。`,
    // **「進める先がありません」とは書かない。** 先が無いのではなく、もう並んでいる。
    mergeUpToDate: "もう同じ位置です。相手のコミットはすべて手元にあります。",
    mergeDetached:
      "いまブランチから外れた状態（detached HEAD）なので、進める対象のブランチがありません。先にブランチへ切り替えてください。",
    mergeUnknown:
      "読み込んだコミットの外を指しているので判定できません。fetch してからもう一度試してください。",

    // --- 取ってきてから進める（T-31。docs/DESIGN.md §8.6）------------------
    //
    // **「pull」と書かない。** 何が起きるのかを、起きる順に書く。
    // **merge 側と同じ語彙で、同じ文を含む形にする** — 片方がもう片方＋αだと読めるように。
    fetchMergeTitle: "取ってきてから、ブランチを進める",
    fetchMergeLead: (branch: string, from: string) =>
      `先にリモートへ問い合わせて ${from} を新しくしてから、ローカルの ${branch} をそこまで進めます。`,
    fetchMergeHelp:
      "こちらは先にリモートから取ってきて、そのあと早送り（fast-forward）で進められるときだけ進めます。進められるかどうかは取ってきてから決まるので、いまの数とは変わることがあります。進められないときは、何もせずに理由を出します。取ってこずに、いま手元にある位置まででよければ、右クリックの「取ってきてから」が付いていないほうを使ってください。",
    // **覚えている値・いまの値は画面に出す**（CLAUDE.md §6）。
    fetchMergeNow: (ahead: number, behind: number) =>
      `いまは手元にだけあるコミットが ${ahead} 件、相手にだけあるコミットが ${behind} 件です。`,
    fetchMergeNowUnknown:
      "いまの差は判定できていません。読み込んだコミットの外を指しているかもしれません。",
    // **中止の効き方をあらかじめ言う。** 押しても効かない場面があるため。
    fetchMergeCancelNote:
      "取ってくる間は中止できます。進め始めたあとは中止できません。",
    fetchMergeRun: "取ってきて進める",

    // 実行中。**段で言うことが変わる**（中止できるのは取ってくる間だけ）。
    fetchMergeFetching: "取ってきています…",
    fetchMergeMerging: "進めています…",
    fetchMergeCancel: "中止",
    fetchMergeCancelling: "中止しています…",
    fetchMergeNoCancel: "進め始めたので、ここからは中止できません。",

    // 結果。**どこまで進んだかを最初の 1 行で言う。**
    fetchMergeMerged: "取ってきて、進めました。",
    fetchMergeMergeFailed: "取ってきましたが、進められませんでした。",
    fetchMergeFetchFailed: "取ってくるところで止まったので、ブランチは進めていません。",
    fetchMergeFetchCancelled:
      "取ってくるのを中止したので、ブランチは進めていません。そこまでに取ってきた分は残っています。",
    fetchMergeNotMerged: "取ってきましたが、ブランチは進めませんでした。",

    // --- 止める理由（docs/DESIGN.md §8.1）-----------------------------
    blockerBare: "bare リポジトリには作業ツリーがないので切り替えられません。",
    blockerDirty: (n: number) =>
      `作業ツリーに ${n} 件の変更があります。GitPeek は stash も --force も使わないので、片付けてからもう一度試してください。`,
    blockerIndexLock:
      "index.lock が残っています。別の git が動いているかもしれません（GitPeek は消しません）。",
    blockerUnborn: "コミットが 1 件もありません。",

    // --- 結果 ---------------------------------------------------------
    resultOk: "完了しました",
    resultFailed: "実行できませんでした",
    // 判定してから実行するまでの間に状態が変わった場合。**走っていない。**
    refused: "確認してから実行するまでの間に状態が変わったので、実行しませんでした。",
    running: "実行しています…",
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
    confirmBody: (n: number) => `${n} 件のリポジトリを順に fetch します。`,
    confirmAuth:
      "資格情報の切れたリモートがあると、認証ウィンドウが前に出ることがあります。",
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
    noRepositories: "fetch できるリポジトリがありません。どれもリモートを持っていません。",
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
    conflictBody: "衝突しています。GitPeek では直せないので、ターミナルの git で解決してください。",
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
    mergeNote: "マージコミットの差分は、どの親と比べるかで変わります。",

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
    binaryBody: "バイナリなので差分は出せません。",
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

  /**
   * LLM の接続先（T-20）。**入口はヘッダの「設定」ボタン 1 つ**で、
   * T-25 で設定画面へ中身を移す。
   *
   * 文言は「何が起きるか」で書く（CLAUDE.md §6）。用語をそのまま出さない。
   */
  llm: {
    // **入口は設定画面のタブ**（T-25 でヘッダのボタンを畳んだ）。`open` は要らなくなった。
    title: "AI レビューの接続先",
    lead: "AI レビューに使う接続先を登録します。API キーは Windows の資格情報マネージャーに預けるので、設定ファイルには残りません。",
    empty: "接続先はまだありません。",

    add: "接続先を追加",
    edit: "編集",
    remove: "削除",
    removeConfirm: (name: string) =>
      `接続先「${name}」を削除します。預けてある API キーも一緒に消えます。`,

    // --- 編集フォーム -------------------------------------------------
    nameLabel: "この接続先の呼び名",
    namePlaceholder: "手元の Ollama / 仕事用 など",
    baseUrlLabel: "接続先の URL",
    baseUrlPlaceholder: "http://localhost:11434/v1",
    baseUrlNote:
      "OpenAI 互換の入口を入れてください。たいてい末尾は /v1 です。Ollama なら http://localhost:11434/v1。",
    modelLabel: "モデル名",
    modelPlaceholder: "qwen2.5-coder:14b",
    contextWindowLabel: "一度に渡せる長さ（トークン）",
    contextWindowNote: "これを超えそうなときだけ、差分を分けて渡します。",
    temperatureLabel: "temperature（0 に近いほど答えがぶれません）",
    maxTokensLabel: "1 回の返答の上限（トークン）",

    // 入力の問題。**押せないボタンを消さず、ここに理由を出す。**
    problem: {
      nameEmpty: "呼び名を入れてください。一覧でこの名前を出します。",
      baseUrlEmpty: "接続先の URL を入れてください。",
      baseUrlNotHttp: "URL は http:// か https:// で始めてください。",
      modelEmpty: "モデル名を入れてください。下の「モデル名を取り出す」で候補を出せます。",
      contextWindowNotNumber: "半角の数字で入れてください。",
      contextWindowRange: "1 以上の数字を入れてください。",
      temperatureNotNumber: "0 から 2 までの数字を入れてください。",
      temperatureRange: "0 から 2 までの数字を入れてください。",
      maxTokensNotNumber: "半角の数字で入れてください。",
      maxTokensRange: "1 以上の数字を入れてください。",
    },

    // --- API キー -----------------------------------------------------
    //
    // **保存済みのキーは読み出さない。** 表示するのは「預かっている」ことだけ。
    apiKeyLabel: "API キー",
    apiKeyPlaceholderSaved: "預かっています（変えるときだけ入力してください）",
    apiKeyPlaceholderEmpty: "キーの要らない接続先（Ollama など）なら空のままで",
    apiKeySaved: "このパソコンの資格情報マネージャーに預かっています。ここには表示しません。",
    apiKeyNone: "まだ預かっていません。キーの要らない接続先なら、このままで大丈夫です。",
    apiKeyReplaceNote: "保存すると、預かっているキーが入力した内容に入れ替わります。",
    // 「消す」の選択肢。**押せないときも消さない**（CLAUDE.md §6）。
    apiKeyClear: "預かっている API キーを消す",
    apiKeyClearReady: "保存すると資格情報マネージャーから消えます。以後は認証なしで接続します。",
    apiKeyClearNoKey: "この接続先には API キーを預かっていないので、消すものがありません。",
    apiKeyClearTyped: "新しいキーを入力しているので、消すのではなく入れ替わります。",

    // --- 保存・テスト -------------------------------------------------
    save: "保存",
    saving: "保存しています…",
    cancel: "やめる",
    close: "閉じる",
    savedAt: (name: string) => `接続先「${name}」を保存しました。`,

    fetchModels: "モデル名を取り出す",
    fetchingModels: "モデル名を取り出しています…",
    modelsFound: (n: number) => `モデル名が ${n} 件返りました。候補から選べます。`,
    modelsEmpty: "モデル名は返りませんでした。手で入れてください。",

    test: "つながるか試す",
    testing: "試しています…",
    testOk: (model: string, ms: number) =>
      `${model} から返事が来ました（${ms.toLocaleString()} ミリ秒）。`,
    testReply: (reply: string) => `返ってきた内容: ${reply}`,
    details: "詳しい内容",
    // JSON として読めたときは整形して出す。**整形したことを名乗る** —
    // 生のままだと思って読むと、改行がサーバ由来かこちら由来か分からない。
    detailsJson: "詳しい内容（読みやすく整形しています）",

    // **押せない理由を必ず出す**（消すと何が効いているのか読めなくなる）。
    probeNote: {
      invalid: "上の入力を直すと試せます。",
      unsaved: "先に保存すると試せます。API キーは保存したものを使います。",
      dirty: "編集した内容が保存されていません。保存すると、その内容で試せます。",
      ready: "保存してある内容と API キーで実際に 1 往復します。",
    },

    // 失敗したときの続き。**何をすればいいかまで書く。**
    failureHint: {
      unauthorized: "API キーを入力し直して保存してから、もう一度試してください。",
      notFound: "URL の末尾が /v1 になっているか確かめてください。",
      status: "接続先に断られています。しばらく待つか、モデル名を確かめてください。",
      unreachable:
        "サーバが起動しているか確かめてください。Ollama なら `ollama serve` が動いている必要があります。",
      timeout: "ローカルのモデルは初回の読み込みに時間がかかります。もう一度試してください。",
      badResponse: "OpenAI 互換の入口を指しているか確かめてください。多くは末尾が /v1 です。",
      badUrl: "URL を入れ直してください。",
      config: "設定を読み込めませんでした。アプリを開き直してください。",
    },

    // 一覧の 1 行。
    keyBadgeSaved: "キーあり",
    keyBadgeNone: "キーなし",
  },

  /**
   * レビュー観点（skill。T-21）。
   *
   * **画面は 2 つに分かれている。** 内蔵とグローバルはアプリ全体の「設定」、
   * リポジトリの中のものはリポジトリの右クリックから開く（`repositorySettings`）。
   * リポジトリに紐づくものをアプリ全体の設定へ混ぜると、どのリポジトリの話をして
   * いるのか読めなくなるため（2026-09-05 に利用者の指摘）。
   *
   * 文言は「何が起きるか」で書く（CLAUDE.md §6）。とくに信頼の話は、
   * **なぜ既定で使わないのか**が読めないと、ただ手間が増えたようにしか見えない。
   */
  skills: {
    tab: "レビュー観点",
    close: "閉じる",
    globalLead: (dir: string) =>
      `AI レビューで何をどう見るかを決めるファイルです。内蔵のものが 1 つあり、${dir} に .md を置くと増やせます。`,
    repositoryElsewhere:
      "リポジトリに置いてある観点はここには出ません。一覧を右クリックして「このリポジトリの設定」から見てください。",
    empty: "観点のファイルはまだありません。内蔵のものだけを使います。",

    // --- 出どころ -----------------------------------------------------
    originBuiltIn: "内蔵",
    originGlobal: "このパソコン",
    originRepository: "このリポジトリの中",

    // --- 状態 ---------------------------------------------------------
    stateReady: "使います",
    stateOff: "使いません",
    stateUndecided: "まだ決めていません",
    stateChanged: "中身が変わりました",
    stateUnreadable: "読めません",
    // **効かない理由は必ず出す。** 消さない代わりにここで説明する。
    stateNote: {
      untrusted:
        "このリポジトリの中にあるファイルなので、中身を読んで決めるまで使いません。",
      recheck:
        "決めたあとで中身が変わりました。読み直してから決め直してください。",
    },
    // 同名で押しのけられた。**どちらが効いているのか必ず出す。**
    shadowed: (winner: string) => `同じ名前の「${winner}」のほうを使っています。`,

    // --- 一覧 ---------------------------------------------------------
    counts: (n: number) => `${n} 件を使います`,
    countsUndecided: (n: number) => `${n} 件は決めていません`,
    countsChanged: (n: number) => `${n} 件は中身が変わりました`,
    countsUnreadable: (n: number) => `${n} 件は読めません`,
    always: "どの変更でも使います。",
    onlyWhen: (globs: string) => `${globs} に当てはまる変更があるときだけ使います。`,
    readBody: "この観点の中身を読む",

    // --- 使う / 使わない ------------------------------------------------
    use: "このスキルを使う",
    stop: "使うのをやめる",
    // **押せない理由といまの値を出す。** ボタンを消さない代わりにここで説明する。
    actionNote: {
      use: "押すと、これからのレビューでこの観点を使います。",
      // リポジトリ内は「使う」＝「この中身を信頼する」。**そう書く。**
      useRepository:
        "押すと、いま出ている中身を確かめたものとして使います。中身が変わったら、また確認をお願いします。",
      stop: "押すと使うのをやめます。",
      stopFileDefault:
        "ファイルの指定で最初から使うことになっています。押すと使うのをやめます。",
      unreadable: "読めないので使えません。ファイルを直すと選べるようになります。",
      shadowed: "同じ名前の別の観点が優先されているので、使っても効きません。",
    },

    // --- 追加の指示 ----------------------------------------------------
    extraLabel: "この観点に足す一言",
    extraPlaceholder: "例: 変数名の指摘は要りません",
    extraNote:
      "観点の本文の後ろに足して渡します。ファイルは書き換えないので、他人のリポジトリの観点にも足せます。",

    // **なぜ既定で使わないのかを最初に書く。** 手間の理由が読めないと、
    // 「とりあえず押す」ボタンになってしまう。
    trustWhy:
      "リポジトリに置いてある観点は、そのリポジトリを作った人が書いたものです。他人のリポジトリを開くこともあるので、中身を読んで決めるまで使いません。",
  },

  /** リポジトリ 1 つぶんの設定（T-21）。**右クリックから開く。** */
  repositorySettings: {
    open: "このリポジトリの設定",
    openHint: "このリポジトリだけに効く設定です。",
    title: (name: string) => `${name} の設定`,
    skillsLead:
      "このリポジトリの .gitpeek\\skills\\ に置いてある観点です。使うものを 1 つずつ決めてください。",
    noSkills:
      "観点のファイルはまだありません。.gitpeek\\skills\\ に .md を置くとここに出ます。",

    // 既定の接続先（T-23 で覚えるようにしたが、**画面から読めなかった**）。
    // **いまの値を必ず出す**（clone の「既定の保存先」と同じ扱い。CLAUDE.md §6）。
    profile: "AI レビューの既定の接続先",
    profileLead:
      "このリポジトリでレビューするとき、最初に選ばれる接続先です。実行前の画面で選び直すと、こちらも変わります。",
    profileNone: "決めていない（毎回選ぶ）",
    profileMissing: "前に選んだ接続先が見つかりません（消したか、名前が変わりました）。",
    profileEmpty: "接続先がまだありません。設定の「AI レビュー」で追加すると選べます。",
  },

  /**
   * AI レビュー（T-23）。
   *
   * **「何が起きるか」で書く。** git や LLM の用語をそのまま出さない
   * （「hunk 分割」は通じない。CLAUDE.md §6）。
   */
  review: {
    title: "AI レビュー",
    open: "AI レビュー",
    close: "閉じる",
    back: "戻る",
    run: "レビューを実行",
    cancel: "中止",
    cancelling: "中止しています…",
    running: "レビュー中",
    rerun: "もう一度レビューする",
    exportMarkdown: "Markdown で書き出し",
    exported: (path: string) => `${path} に書き出しました。`,
    historyTab: "履歴",
    profile: "接続先",
    profilePlaceholder: "接続先を選んでください",
    noProfiles: "接続先がまだありません。設定で追加すると実行できます。",
    skillsUsed: "使う観点",
    noSkills: "使う観点がありません。",
    fallbackDefault: "決まった形で返ってこなかったので、モデルの出力をそのまま出しています。",
    offDiffNote: "この差分に無い行を指しています。",
    // 指摘を押すと差分へ飛ぶ（利用者の要望。2026-09-06）。**何が起きるかで書く。**
    jumpHint: "押すとその行を差分に表示します",
    jumpFileOnlyHint: "押すとそのファイルを差分に表示します（行は指定できません）",
    wholeFileNote: "ファイル全体への指摘です。",
    noFindings: "指摘はありませんでした。",
    emptyResult: "応答がありませんでした。",
    summaryHeading: "全体の要約",
    findingsHeading: (n: number) => `指摘 ${n} 件`,
    detail: "接続先からの応答",

    gate: {
      noPlan: "レビューの対象を調べています。",
      noProfile: "接続先がまだありません。設定で接続先を追加すると実行できます。",
      alreadyRunning: "いまレビューを実行中です。終わるか中止すると次を始められます。",
      nothingSelected: "ファイルが 1 つも選ばれていません。チェックを 1 つ以上入れてください。",
      noProfileChosen: "接続先が選ばれていません。上のドロップダウンから選んでください。",
    },

    plan: {
      lead: "この内容でレビューします。要らないファイルはチェックを外してください。",
      tokens: (n: number) => `送る量はおよそ ${n.toLocaleString()} トークンです。`,
      counts: (sending: number, skipped: number) =>
        skipped === 0
          ? `${sending} 件を送ります。`
          : `${sending} 件を送ります（${skipped} 件は送りません）。`,
      splitInto: (parts: number) => `大きいので ${parts} 回に分けて送ります。`,
      selectAll: "すべて選ぶ",
      selectNone: "すべて外す",
      empty: "レビューできるファイルがありません。",
    },

    status: {
      waiting: "待機中",
      running: "実行中",
      done: "済",
      failed: "失敗",
      skipped: "送りません",
    },

    source: {
      staged: "コミット予定の変更（ステージ済み）",
      unstaged: "まだコミットしていない変更",
      root: (to: string) => `最初のコミット ${to}`,
      range: (from: string, to: string) => `${from} から ${to} への変更`,
      symmetric: (from: string, to: string) => `${from} と ${to}（分かれたところから）`,
      // **記録に何も残っていないとき。** 古い形式や壊れた 1 件でも行は消さない。
      unknown: "何をレビューしたのか、この記録には残っていません。",
      // コミット 1 つの呼び名。**要約が引けたときだけ添える**（読み込んでいない
      // コミットや、消えたコミットでは SHA だけになる）。
      commit: (sha: string, subject: string) => `${sha}「${subject}」`,
    },

    // **何をレビューしたのかを結果と履歴の両方に出す**（利用者の要望。2026-09-06）。
    // 履歴が増えると、日時とモデルだけではどれがどれだか読めなくなる。
    target: {
      repository: "リポジトリ",
      what: "対象",
      when: "実行日時",
      model: "モデル",
    },

    history: {
      title: "レビュー履歴",
      // **どのリポジトリの履歴かを出す。** 履歴はリポジトリごとに積んであるが、
      // 画面にリポジトリ名が無いと、切り替えたあとで読めなくなる。
      of: (name: string) => `${name} のレビュー履歴`,
      empty: "このリポジトリではまだレビューしていません。",
      emptyWhere: (dir: string) => `結果は ${dir} に積まれます。`,
      unreadable: "読めません",
      findings: (n: number) => `指摘 ${n} 件`,
      failed: (n: number) => `${n} 件失敗`,
      cancelled: "中止",
      open: "開く",
      viewing: "履歴を表示しています。",
    },

    markdown: {
      title: "AI レビュー結果",
      savedAt: "実行日時",
      model: "モデル",
      // **どのリポジトリの結果か。** 書き出したファイルだけを後から読むことがある。
      repository: "リポジトリ",
      target: "対象",
      counts: "件数",
      skills: "観点",
      summary: "全体の要約",
      fileCount: (n: number) => `ファイル ${n} 件`,
      findingCount: (n: number) => `指摘 ${n} 件`,
      failed: (n: number) => `${n} 件のファイルはレビューに失敗しました`,
      cancelled: "途中で中止しました",
      noFindings: "指摘はありませんでした。",
      noResult: "応答がありませんでした。",
      saveTitle: "Markdown で書き出し",
    },
  },

  /**
   * ショートカットの説明（T-25）。**鍵は `lib/shortcuts.ts` の `Action`。**
   * 設定画面の一覧はこの 2 つを突き合わせて作るので、片方だけ足すと型で落ちる。
   */
  shortcuts: {
    openPalette: "リポジトリを切り替える",
    fetchCurrent: "いまのリポジトリを fetch する",
    fetchAll: "登録した全リポジトリを fetch する",
    openReview: "AI レビューを開く（実行はしない）",
    openSettings: "設定を開く",
    findInDiff: "差分の中を探す",
    findCommits: "コミットをことばで探す",
    reload: "履歴と作業ツリーを読み直す",
    gotoHead: "HEAD のコミットへ移動する",
    commitDown: "1 つ下のコミットへ",
    commitUp: "1 つ上のコミットへ",
    commitFirst: "いちばん上のコミットへ",
    commitLast: "いちばん下のコミットへ",
    parentCommit: "親のコミットへ（複数なら選ぶ）",
    childCommit: "子のコミットへ（複数なら選ぶ）",
    fileNext: "次のファイルへ",
    filePrev: "前のファイルへ",
    focusDiff: "差分へフォーカスを移す",
    close: "開いているものを閉じる",
  },

  /**
   * 差分の中の検索（T-25。DESIGN.md §6.5 の `Ctrl+F`）。
   *
   * **探すのは開いているファイルの差分の中だけ。** 見つけた行へ移動して囲む
   * （文字そのものは塗らない — 語単位差分と構文色に 3 つ目の色を重ねると、
   * どれが変更でどれが検索結果か読めなくなる）。
   */
  diffSearch: {
    open: "差分の中を探す",
    placeholder: "差分の中を探す",
    prev: "前へ",
    next: "次へ",
    close: "閉じる",
    counts: (current: number, total: number) => `${current} / ${total}`,
    none: "見つかりません",
    empty: "探す言葉を入れてください。",
    scope: "開いているファイルの中だけを探します。",
  },

  commandLog: {
    title: "git コマンドログ",
    empty: "まだ git コマンドを実行していません。",
    showFixedArgs: "固定オプションを表示",
    capacity: (n: number) => `直近 ${n} 件を保持`,
    exit: "exit",
    failedToStart: "起動失敗",
    entryCount: (n: number) => `${n} 件`,
  },
} as const;
