<div align="center">

<img src="src-tauri/icons/128x128.png" width="88" height="88" alt="">

# GitPeek

**読むための Git クライアント。**

履歴グラフを読み、差分を読み、必要なら AI にレビューさせる。<br>
**コミットはしません。**

<p>
<img alt="platform: Windows 10 / 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square">&nbsp;
<img alt="built with Tauri v2" src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square">&nbsp;
<img alt="Rust 1.88+" src="https://img.shields.io/badge/Rust-1.88%2B-CE422B?style=flat-square">&nbsp;
<img alt="React + TypeScript" src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square">&nbsp;
<img alt="portable zip" src="https://img.shields.io/badge/distribution-portable%20zip-555555?style=flat-square">&nbsp;
<img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-1F6FEB?style=flat-square">
</p>

<p>
<a href="https://gitlab.com/tatsunoko7324/gitpeek/-/releases"><img alt="ダウンロード" src="https://img.shields.io/badge/download-Releases-FC6D26?style=for-the-badge&logo=gitlab&logoColor=white"></a>
</p>

</div>

<!-- スクリーンショットは docs/images/top.png を撮り直してから入れる（作者のメールアドレスと
     ローカルパスが写り込まないダミーのリポジトリで撮ること）。 -->

---

## 目次

- [ダウンロード](#ダウンロード)
- [GitPeek とは](#gitpeek-とは)
- [できること](#できること)
- [何を「しない」と決めたか](#何をしないと決めたか)
- [はじめかた](#はじめかた)
- [キーボード操作](#キーボード操作)
- [AI レビュー](#ai-レビュー)
- [設定とデータの置き場所](#設定とデータの置き場所)
- [ソースから動かす](#ソースから動かす)
- [設計ドキュメント](#設計ドキュメント)
- [ライセンス](#ライセンス)

---

## ダウンロード

[**Releases**](https://gitlab.com/tatsunoko7324/gitpeek/-/releases) からポータブル版の zip を落として、
展開するだけで動きます。インストーラーはありません。各リリースには **SHA-256** を載せてあるので、
落としたファイルと突き合わせられます。

コード署名はしていないので、初回起動時に SmartScreen の警告が出ます
（「詳細情報」→「実行」で進めてください）。

## GitPeek とは

Windows 向けの Git **ビューワー**です。単一の実行ファイルで動き、インストーラーもサービスも要りません。

普通の Git クライアントは「自分のコミットを作る」ための道具ですが、GitPeek は逆側に振ってあります。
想定しているのは次の 2 つです。

- **自分が書いていないコードを読む** — OSS、上流のリポジトリ、他の人の変更
- **複数のリポジトリの状況をまとめて眺める** — どれが遅れているか、どれに未取り込みの変更があるか

書き込み系の操作は意図的に絞ってあり、git に対して行うのは **checkout / fetch / merge --ff-only / clone**
の 4 つだけです。作業ツリーは読むだけで、GitPeek があなたの未保存の変更を壊すことはありません。

## できること

- [x] **履歴グラフ** — 全コミットをレーン付きで一度に描画（数万コミット規模まで）
- [x] **ブランチ / タグのツリー** — 表示の ON/OFF、ahead / behind の表示
- [x] **差分** — 構文色、左右に並べる表示、語単位の差分、差分の中の検索
- [x] **任意の 2 コミット間の差分**と、作業ツリーの差分（**read-only**）
- [x] **文字コードの自動判別**（UTF-8 / Shift_JIS / EUC-JP）と、改行コードの混在の検出
- [x] **fetch / checkout / clone** — 実行前に何が起きるかを確認する画面つき
- [x] **ブランチを進める**（fast-forward）— リモートから**取ってきてからまとめて**進めることもできます
  （`git pull --ff-only` に当たる操作。早送りできないときは、何もせずに理由を出します）
- [x] **AI レビュー** — OpenAI 互換の API に差分を渡して指摘をもらう（ローカルの Ollama も可）
- [x] **git コマンドのログ** — 実行したコマンド、終了コード、標準エラー出力、所要時間

読み込みは開いた時点で 1 回だけです。スクロール中にグラフが描き変わることはありません。
10 万コミットを超えるモノレポは v1 の想定外です（開けないわけではなく、読み込みに時間とメモリを使います。
実行する前に確認が出ます）。

## 何を「しない」と決めたか

以下は未実装ではなく、**作らないと決めたもの**です。

| しないこと | なぜ |
|---|---|
| commit / amend / rebase / cherry-pick / revert | 履歴を作る操作は git の CLI に任せる前提 |
| stage / unstage / discard / stash の作成・適用 | 作業ツリーは read-only。ビューワーが未保存の作業を壊す経路そのものを断つ |
| `--force` 付きの checkout、自動 stash | 同上 |
| 非 fast-forward マージ | 競合を解決する画面を持たないので、中途半端に手を出さない |
| 浅い clone（`--depth`）、ブランチを絞った clone | 履歴を読むための道具なので本末転倒 |
| サブモジュールの**自動**取り込み | 黙って別のリポジトリを取りに行かない（clone の確認画面でチェックしたときだけ） |
| タグ・ブランチの作成 / 削除 / リネーム | 同上（ローカル追跡ブランチだけは checkout の確認画面で選べる） |
| 外部サービスへの通信（Gravatar など） | ネットワークに出るのは git の fetch / clone と、あなたが設定した LLM だけ |
| 自動更新、コード署名 | 配布はポータブル zip のみ |

**認証情報は GitPeek を通りません。** 認証は git（Git Credential Manager）に任せてあり、
パスワードもトークンも受け取りません。画面とログに出る文字列は、URL に埋め込まれた資格情報や
API キーらしき形をマスクしてから記録します。

## はじめかた

### 動作条件

| | |
|---|---|
| OS | Windows 10 / 11 |
| git | PATH が通っていること（通っていなければ、初回起動時の画面でフルパスを指定できます） |
| WebView2 Runtime | Windows 11 なら標準で入っています |

### インストール

1. [Releases](https://gitlab.com/tatsunoko7324/gitpeek/-/releases) から zip を落とす
2. 好きな場所に展開して `GitPeek.exe` を起動する
3. 左のサイドバーからリポジトリを登録する

登録の方法は 3 通りです — **フォルダを選ぶ**、**親フォルダをスキャンして一括で見つける**、
**URL から clone する**。

## キーボード操作

一覧は 設定 → ショートカット にもあります（v1 では変更できません）。

| キー | 動作 |
|---|---|
| `Ctrl+P` | リポジトリを切り替える |
| `Ctrl+R` | いま開いているリポジトリを fetch |
| `Ctrl+Shift+R` | 登録した全リポジトリを fetch |
| `Ctrl+Shift+A` | AI レビューを開く |
| `Ctrl+F` | 開いている差分の中を探す |
| `Ctrl+H` | HEAD へ戻る |
| `Ctrl+,` | 設定 |
| `F5` | 読み直す |
| `↓` `↑`（`j` `k`）| コミットを 1 つ動かす |
| `Home` `End` | 先頭 / 末尾のコミットへ |
| `Alt+←` `Alt+→` | 親 / 子のコミットへ |
| `Alt+↑` `Alt+↓` | 変更ファイルを 1 つ動かす |
| `Enter` | 差分へフォーカスを移す |
| `Esc` | 閉じる |

## AI レビュー

OpenAI 互換の API を 1 つ設定すると、選んだ差分をレビューさせられます。
ローカルの Ollama も `http://localhost:11434/v1` で扱えます。

- 設定 → AI レビュー で接続先を登録します。**接続テストは実際に 1 往復させます**
  （モデル一覧が返るだけでは、生成まで通るとは限らないため）
- 渡すのは **ファイルのパス ＋ 差分 ＋ コミットメッセージ ＋ 観点（skill）** だけです。
  **ファイルの全文は渡しません**
- 送る前と、画面に出すとき・保存するときの両方で、秘匿情報らしき文字列をマスクします
- 結果は履歴として積みます（上書きしません）。途中で中止したものも残ります
- API キーは設定ファイルではなく **Windows の資格情報マネージャー**に入ります

### リポジトリの中に置かれた観点は、既定で使いません

`<リポジトリ>\.gitpeek\skills\*.md` に置かれたレビュー観点は、**他人のリポジトリの指示文で
レビュー結果を操作されうる**ものです。そのため既定では無効で、**ファイル 1 つずつ**
「このスキルを使う」と決めたものだけがモデルに渡ります。
内容が書き換わったら、そのファイルだけが未決の状態に戻ります。

## 設定とデータの置き場所

```
%APPDATA%\com.tatsu.gitpeek\
├── settings.json    設定。手で編集してかまいません
├── state.json       開いていたリポジトリなど。壊れたら捨ててかまいません
├── skills\          AI レビューの観点（*.md）
├── reviews\         レビュー結果の履歴
└── logs\            gitpeek-YYYY-MM-DD.log（7 日で消えます）
```

`settings.json` は手編集を前提にしています。範囲外の数値を書いても捨てられることはなく、
近いほうの端に寄せて読み込まれます。ログには差分やレビューの本文は残りません。

## ソースから動かす

必要なもの: Node.js、Rust **1.88 以上**、WebView2 Runtime。

```
GitPeek.bat             開発モードで起動（ダブルクリックでも可）
npm run start:release   Rust をリリースビルドで起動（大きなリポジトリを触るとき）
npm run package:zip     配布用の zip を作る
```

変更したら次の 4 つを通します。

```
npm run test:rust       cargo test（単体 ＋ 結合）
npm run check:rust      cargo clippy -- -D warnings
npm run test            vitest（純関数のみ）
npm run typecheck       tsc --noEmit
```

結合テストで使うリポジトリはスクリプトが生成するので、手元の実リポジトリには依存しません。

リリースは手元で作って上げます（`npm run release`）。GitLab.com の共有ランナーに Windows のものが
無く、Tauri の Windows 向けビルドを Linux で作るのは現実的でないためです。詳しくは
[`docs/DESIGN.md`](docs/DESIGN.md) §2.3.2 を見てください。

## 設計ドキュメント

なぜそう作ったかは [`docs/DESIGN.md`](docs/DESIGN.md) にまとめてあります。
レーン割り当てのアルゴリズム、git の呼び出し方針、秘匿情報の扱い、AI レビューの実行制御など、
決めたことと決めた理由が一通り書いてあります。

## ライセンス

[MIT License](LICENSE)。無保証です。

コードの大半は Anthropic の Claude との対話で書いています。設計上の判断と、それを採否した
記録は [`docs/DESIGN.md`](docs/DESIGN.md) に残してあります。
