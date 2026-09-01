# CLAUDE.md — Givsoner

個人用 Git ビューワー **Givsoner**（Tauri v2 + Rust + React/TypeScript）。

設計の全体像と決定理由は [`docs/DESIGN.md`](docs/DESIGN.md) にある。
本ファイルは**実装中に毎回効く制約**だけを抜き出したもの。迷ったら DESIGN.md を読むこと。

---

## 1. このアプリは何をしないか

Givsoner は**ビューワー**である。以下は「未実装」ではなく「実装しないと決めた」もの。
これらを追加する提案・実装をしてはいけない。

- あらゆるコミット操作（commit / amend / rebase / cherry-pick / revert）
- stage / unstage / discard / stash の作成・適用（作業ツリーは **read-only** 表示のみ）
- `--force` 付き checkout、自動 stash
- 非 fast-forward マージ（`merge` は常に `--ff-only`）
- shallow clone (`--depth`)、`--recurse-submodules`
- ブランチ / タグの作成・削除・リネーム（ローカル追跡ブランチの自動作成も v1 では**しない**。
  リモート追跡ブランチの checkout は detached HEAD にする）
- 外部通信（Gravatar 等）。ネットワークに出るのは git の fetch/clone と LLM API だけ
- 自動更新、コード署名

git に対して書き込むのは **checkout / fetch / merge --ff-only / clone** の 4 つだけ。

---

## 2. git 実行の不変条件（破ると静かに壊れる）

**すべての git 実行は `src-tauri/src/git/exec.rs` の単一の関数を通す。**
ここ以外で `Command::new("git")` を書かないこと。

### 固定オプション（全呼び出しに必ず付ける）

```
-c core.quotepath=false    # 無いと日本語ファイル名が 8 進エスケープされる（この環境は未設定＝true）
-c core.autocrlf=false     # ユーザーの .gitconfig に左右されない挙動を得る
-c core.pager=cat          # pager 起動でハングするのを防ぐ
-c color.ui=false          # ANSI エスケープの混入を防ぐ
```

### 固定環境変数（全呼び出しに必ず設定）

```
GIT_TERMINAL_PROMPT=0                    # 無いと認証時に GUI 子プロセスが無言でハングする
GIT_SSH_COMMAND=ssh -o BatchMode=yes     # 無いとパスフレーズ待ちでハングする
```

### その他

- **`git log --all` を使ってはいけない。** `--all` は `refs/tags/`・`refs/stash`・`refs/notes/` を
  含み、「タグを起点 ref にしない」という決定に違反する。正しくは
  **`git log --branches --remotes HEAD --topo-order`**。
- **`.git/index.lock` をアプリから削除しない。** 検出したら表示するだけ。
- 認証は git CLI（Git Credential Manager）に完全委譲する。アプリはパスワードもトークンも扱わない。
- 出力パースは機械可読形式（`--format` / `-z` / `--porcelain=v2` / `--numstat`）のみに依存する。
  人間向け出力をパースしない。
- ahead/behind は `git rev-list --count` を呼ばず、**メモリ上のグラフから計算**する。

---

## 3. レーン割り当ての不変条件

`src-tauri/src/graph/lane.rs`。**このアプリの心臓部。変更したら必ずユニットテストを通すこと。**

1. **lane 0 は幹に予約される。** 既定ブランチ（`origin/HEAD` → `main`/`master` → HEAD の順で決定）の
   第一親チェーンは必ず lane 0 を通り、一直線に描かれる。
2. レーン再利用は最小空きレーンだが、**解放直後の 1〜2 行は再利用を保留**する。
3. マージコミットの第 2 親は**右側に新レーンを起こす**。
4. **レーン数に上限を設けない**（グラフ列を横スクロールさせる）。
5. コミットは**リポジトリ選択時に全件メタ情報を一括取得**し、レーンを一度で確定する。
   増分読み・増分レーン計算はしない（描画中にグラフが踊るため）。
6. 作業ツリーの擬似行は**レーン計算の対象外**。HEAD へ点線で接続する。
7. ブランチ表示 ON/OFF は、可視 ref 集合から**到達可能集合を再計算してレーンを振り直す**
   （淡色化ではない）。

---

## 4. セキュリティ上の必須事項

- **秘匿情報のマスキングは `src-tauri/src/redact.rs` を全出力が通ること。**
  画面表示とログファイルの両方で、`://<user>:<secret>@` パターンと API キーらしき文字列を
  マスクしてから記録する。`git remote -v` や git の stderr に平文トークンが出るため。
- **API キーは Windows 資格情報マネージャーに保存**し、`settings.json` には参照キーのみ書く。
- **リポジトリ内 skill (`<repo>/.gitviewer/skills/*.md`) は既定で無効。**
  リポジトリごとに明示的な信頼操作を要求し、ファイル内容のハッシュが変わったら再確認する。
  他人のリポジトリを開く用途がある以上、リポジトリ内の指示文でレビュー結果を操作されうるため。

---

## 5. データと設定の置き場所

```
%APPDATA%\com.tatsu.givsoner\
├── settings.json          # 手編集を想定。schemaVersion 必須
├── state.json             # アプリが随時上書き。壊れたら捨てて再生成できること
├── skills\                # グローバル skill (*.md)
├── reviews\<repo-id>\     # レビュー結果 (<timestamp>.json)。上書きせず履歴として積む
└── logs\                  # givsoner-YYYY-MM-DD.log（7 日ローテーション）
```

**OneDrive 配下に設定を置かない**（同期競合とファイルロックの温床）。

---

## 6. UI の固定事項

- 日本語 UI。**全表示文言は `src/i18n/ja.ts` に集約**し、コンポーネントからはキーで参照する
  （i18n ライブラリは入れない）。文言をコンポーネントに直書きしないこと。
- レイアウト: 左サイドバー（リポジトリ一覧 / ブランチ・タグツリー）＋ 中央上グラフ ＋ 中央下差分
  ＋ 差分右の AI レビュードロワー。
- テーマは OS 追従が既定。色はライト / ダークで別定義する。
- グラフ寸法: 行高 28px、レーン幅 14px、ノード列の左マージン 12px。
- **git コマンドログパネルを常設**（直近 500 件、リポジトリ切替でクリアしない）。
  実行コマンド・exit code・stderr・所要時間を表示。エラーは「人間向けメッセージ＋展開で生 stderr」。

---

## 7. AI レビューの固定事項

- **OpenAI 互換 API 1 系統のみ**。Ollama も `http://localhost:11434/v1` で扱う。
- 投入単位は**ファイル単位＋最後に全体サマリ**。超過時のみ hunk 分割にフォールバック。
- モデルに渡すのは **パス ＋ unified diff (`-U10`) ＋ コミットメッセージ ＋ skill 本文**のみ。
  **ファイル全文は渡さない。**
- **JSON スキーマを要求し、パース失敗時は生出力を Markdown として表示するフォールバックが必須。**
  この経路はテストで必ず通すこと（ローカル小型モデルはスキーマを守れないことがある）。
- 実行は既定逐次（並列度 1、最大 3）。1 ファイルの失敗で全体を止めない。

---

## 8. テストで必ず担保すること

- **レーン割り当て**: 直線 / 単純分岐 / 連続マージ / オクトパスマージ / ルートコミット複数 /
  lane 0 予約 / 可視 ref を絞ったときの再計算
- **git 出力パーサ**: 日本語ファイル名 / 空 subject / 複数親 / 署名付きコミット / 改行を含む subject
- **LLM**: JSON パース失敗時の Markdown フォールバック経路
- 結合テスト用リポジトリはスクリプトで生成する（手元の実リポジトリに依存しない）
- フロントは「レーン配列 → SVG パス」の純関数のみテストする

---

## 9. 実装フェーズ

**進捗とタスクの詳細は [`task_lists.md`](task_lists.md) を見ること。** 進捗の唯一の正はそちらであり、
ここには Phase の一覧だけを文脈として残す。

縦切りで進める。**各 Phase 終了時に必ず起動して触れる状態にすること。**

| Phase | 内容 |
|---|---|
| 0 | Tauri v2 雛形 ＋ git 検出 ＋ git コマンドログパネル |
| 1 | リポジトリ登録・一覧・切替 ＋ `git log` 全件取得とパース |
| 2 | レーン計算（テスト付き）＋ SVG グラフ ＋ 仮想スクロール ← **最初の判定ポイント** |
| 3 | ブランチ / タグツリー、ref チップ、表示 ON/OFF、ahead/behind |
| 4 | コミット詳細 ＋ 変更ファイル一覧 ＋ 差分表示（Shiki / side-by-side / word diff） |
| 5 | 任意 2 コミット間差分、作業ツリー差分 |
| 6 | fetch / checkout / FF マージ ＋ 各種ガード |
| 7 | clone |
| 8 | AI レビュー |
| 9 | 設定画面、テーマ、ショートカット、エラー処理の仕上げ、配布ビルド |

**Phase 2 完了時に「美しいグラフ」の合否を判定する**（task_lists.md の T-08）。不合格ならレーン
割り当てと描線仕様の決定に戻る。後の Phase を作ってからでは戻れない。

**v1 の DoD**: Phase 9 完了 ＋ 実リポジトリ 5 個以上で 1 週間実運用し、既存 GUI クライアントを
一度も開かずに済んだこと。

---

## 10. 開発環境メモ

- ビルド・実行は Windows のみ。ただし**閲覧対象には Linux 由来のソースが含まれる**前提で
  文字コード（UTF-8 / Shift_JIS / EUC-JP 自動判別）と改行コード（LF/CRLF 混在の警告）を扱う。
- **Rust は 1.85 以上が必須**（Tauri v2 自体は 1.77.2+ だが、依存の `time` が edition2024 を
  要求する）。ビルドが通らなくなったらまず `rustup update stable`。
- 配布はポータブル zip のみ。**Tauri の bundler に zip ターゲットは無い**ので、
  `src-tauri/target/release/Givsoner.exe` を npm script で zip 化する。
