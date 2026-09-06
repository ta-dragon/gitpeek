# GitPeek

個人用の Git **ビューワー**。Windows 向け、ポータブル zip 1 つで動く。

履歴グラフを読み、差分を読み、必要なら AI にレビューさせる。**コミットはしない。**

---

## 何をするものか

主な用途は 2 つ。

- **自分が書いていないコードを読む** — OSS、上流リポジトリ、他人の変更
- **複数リポジトリの状況を横断的に見る**

できること:

- 全コミットの履歴グラフ（レーン付き。数万コミットまで）
- ブランチ / タグのツリー、表示 ON/OFF、ahead/behind
- コミット詳細と変更ファイル一覧、差分表示（構文色 / 左右並べ / 語単位）
- 任意 2 コミット間の差分、作業ツリーの差分（**read-only**）
- 文字コードの自動判別（UTF-8 / Shift_JIS / EUC-JP）と改行コードの混在検出
- fetch / checkout / fast-forward マージ / clone
- OpenAI 互換 API による差分のレビュー（Ollama も可）
- 実行した git コマンドのログ

## 何を「しない」と決めたか

以下は未実装ではなく、**作らないと決めたもの**。要望があっても入らない。

| しないこと | なぜ |
|---|---|
| commit / amend / rebase / cherry-pick / revert | 製品定義。git は CLI で操作する前提 |
| stage / unstage / discard / stash の作成・適用 | 作業ツリーは read-only。ビューワーが未保存の作業を壊す経路を構造的に断つ |
| `--force` 付き checkout、自動 stash | 同上 |
| 非 fast-forward マージ | 競合解決の画面を持たないので、中途半端に着手しない |
| 浅い clone（`--depth`）、ブランチ指定の clone | 履歴を読むための道具なので本末転倒 |
| サブモジュールの**自動**取り込み | 黙って別のリポジトリを取りに行かない。clone の確認画面でチェックしたときだけ |
| タグ・ブランチの作成 / 削除 / リネーム | 同上（ローカル追跡ブランチだけは checkout の確認画面で選べる） |
| 自動更新、コード署名 | 配布先が作者のみ |
| 外部サービスへの通信（Gravatar 等） | ネットワークに出るのは git の fetch / clone と、設定した LLM だけ |

git に書き込むのは **checkout / fetch / merge --ff-only / clone** の 4 つだけ。

10 万コミットを超えるモノレポは v1 の想定外（開けないのではなく、読み込みに時間と
メモリを使う。確認してから読む形になっている）。

---

## 動かすのに要るもの

| | |
|---|---|
| OS | Windows 10 / 11 |
| git | PATH に通っているか、設定でフルパスを指定する |
| WebView2 Runtime | Windows 11 なら標準で入っている |

認証は git（Git Credential Manager）に任せている。**GitPeek はパスワードもトークンも
受け取らない。**

## 使い方

1. zip を好きな場所へ展開する
2. `GitPeek.exe` を実行する
3. 左のサイドバーからリポジトリを登録する（フォルダを選ぶ／親フォルダをスキャンする／
   URL から clone する）

初回起動時に git が見つからない場合は、その画面からフルパスを指定できる。

### 置き場所

```
%APPDATA%\com.tatsu.gitpeek\
├── settings.json    設定。手で編集してよい
├── state.json       開いていたリポジトリなど。壊れたら捨ててよい
├── skills\          AI レビューの観点（*.md）
├── reviews\         レビュー結果の履歴
└── logs\            gitpeek-YYYY-MM-DD.log（7 日で消える）
```

`settings.json` は手編集を想定している。範囲外の値を書いても捨てられず、
近いほうの端に寄せて読み込まれる。

API キーは `settings.json` には入らない。**Windows の資格情報マネージャー**
（サービス名 `com.tatsu.gitpeek`）に入る。

### 主なキー操作

全部の一覧は 設定 → ショートカット にある（v1 では変更できない）。

| キー | 動作 |
|---|---|
| `Ctrl+P` | リポジトリを切り替える |
| `Ctrl+R` / `Ctrl+Shift+R` | いまのリポジトリを fetch / 全部を fetch |
| `Ctrl+F` | 開いている差分の中を探す |
| `Ctrl+Shift+A` | AI レビュー |
| `Ctrl+,` | 設定 |
| `↓` `↑`（`j` `k`）| コミットを移動 |
| `Alt+←` `Alt+→` | 親 / 子のコミットへ |
| `Alt+↑` `Alt+↓` | ファイルを移動 |
| `Esc` | 閉じる |

---

## AI レビュー

OpenAI 互換の API を 1 つ設定すると、差分をレビューさせられる。ローカルの Ollama も
`http://localhost:11434/v1` で使える。

- 設定 → AI レビュー で接続先を登録する（接続テストは実際に 1 往復させる）
- モデルに渡すのは **パス ＋ 差分 ＋ コミットメッセージ ＋ 観点（skill）** だけ。
  **ファイルの全文は渡さない**
- 秘匿情報らしき文字列は、送る前と表示・保存の両方でマスクする
- 結果は `reviews\` に積む。上書きしない

### リポジトリの中に置かれた観点は、既定で使わない

`<リポジトリ>\.gitpeek\skills\*.md` を読むと、**他人のリポジトリの指示文で
レビュー結果を操作されうる**。そのため既定では無効で、**ファイル 1 つずつ**
「このスキルを使う」と決めたものだけが渡る。内容が変わったら、そのファイルだけが
未決に戻る。

---

## 起動が遅い / 真っ白になるとき

起動直後に数十秒ウィンドウが白いままなら、**フィルタリング系ソフト**をまず疑う。
AdGuard は WebView2 のページにスクリプトを差し込むために外部へ問い合わせに行き、
それが返らない間ページが止まる（実測 29 秒）。フィルタリングの対象から
`msedgewebview2.exe` または `localhost` を外すと直る。

---

## 開発

```
GitPeek.bat          開発モードで起動（ダブルクリック可）
npm run start:release Rust をリリースで起動（大きいリポジトリを触るとき）
npm run package:zip   配布用 zip を作る
```

変更したら通すもの:

```
npm run test:rust    cargo test
npm run check:rust   cargo clippy -- -D warnings
npm run test         vitest（純関数のみ）
npm run typecheck    tsc --noEmit
```

Rust は **1.88 以上**が必要。ビルドが通らなくなったらまず `rustup update stable`。

設計と決定の理由は [`docs/DESIGN.md`](docs/DESIGN.md)、実装中に効く制約は
[`CLAUDE.md`](CLAUDE.md)、進捗は [`task_lists.md`](task_lists.md) にある。
