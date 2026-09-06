#!/usr/bin/env bash
#
# 結合テスト用の git リポジトリを生成する。
#
#   scripts/make-test-repos.sh <出力ディレクトリ>
#
# 出力ディレクトリは毎回作り直す。手元の実リポジトリに依存したテストを書かないための
# 道具であり、生成物はコミットしない（docs/DESIGN.md §14.3）。
#
# Windows では **Git Bash で実行すること**。PATH 上の `bash` が WSL のことがあり、
# その場合 Windows 側から見えるパスにならない。
#
# 生成するリポジトリ:
#   linear         直線履歴
#   branch-merge   分岐と合流
#   merges         連続マージ
#   octopus        オクトパスマージ（親 3 つ）
#   two-roots      ルートコミット 2 つ（無関係な履歴の合流）
#   orphan         合流しない orphan ブランチ（幹と繋がらない島）
#   japanese       日本語ファイル名・日本語ディレクトリ
#   changes        追加 / 変更 / 削除 / リネーム / バイナリ（T-11, T-14）
#                  ＋ Shift_JIS のファイルと CRLF のファイル（T-13）
#   empty-subject  subject が空のコミット
#   empty          コミット 0 件（unborn HEAD）
#   detached       detached HEAD
#   messages       複数行メッセージ（subject と本文の切れ目）
#   tags           軽量タグ・注釈付きタグ・グラフ外のタグ
#   bare.git       bare リポジトリ
#   cloned         bare.git のクローン（リモート追跡ブランチと upstream）
#   upstream.git   diverged の上流（bare）
#   diverged       上流と分岐したクローン（ahead 2 / behind 3）
#   dirty          作業ツリーが汚れたリポジトリ（ステージ済み / 未ステージ / 未追跡）
#   conflict       マージ衝突で止まったリポジトリ（unmerged なパス）
#   fetch-src      fetch の上流を動かすための作業用リポジトリ
#   fetch-origin.git  fetch の上流（bare）
#   fetch-client   clone 後に上流が動いたクローン（T-17。fetch すると ref が増減する）
#   fetch-tag-origin.git / fetch-tag-client
#                  上流がタグを付け替えたクローン（T-17。fetch がタグの上書きを拒む）
#   ff-origin.git / ff-client
#                  上流だけが進んだクローン（T-18。merge --ff-only が通る）
#                  ※ FF できない側は diverged（手元も進んでいる）を使う

set -eu

if [ $# -lt 1 ]; then
  echo "usage: $0 <出力ディレクトリ>" >&2
  exit 2
fi

root=$1
rm -rf "$root"
mkdir -p "$root"
root=$(cd "$root" && pwd)

# 生成物を再現可能にする。ユーザーの .gitconfig にも左右されないようにする。
export GIT_AUTHOR_NAME="GitPeek Test"
export GIT_AUTHOR_EMAIL="test@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-01-01T09:00:00+09:00"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
export GIT_TERMINAL_PROMPT=0

# アプリ本体と同じ固定オプションで実行する（docs/DESIGN.md §3.1）。
git_() {
  git -c core.quotepath=false \
      -c core.autocrlf=false \
      -c core.pager=cat \
      -c color.ui=false \
      -c init.defaultBranch=main \
      -c commit.gpgsign=false \
      -c user.name="$GIT_AUTHOR_NAME" \
      -c user.email="$GIT_AUTHOR_EMAIL" \
      "$@"
}

# 新しいリポジトリを作り、以降の git_ の対象にする。
new_repo() {
  repo=$root/$1
  mkdir -p "$repo"
  git_ -C "$repo" init --quiet
}

# ファイルを 1 つ書いてコミットする。
commit() {
  file=$1
  message=$2
  mkdir -p "$(dirname "$repo/$file")"
  echo "$message" >>"$repo/$file"
  git_ -C "$repo" add -A
  git_ -C "$repo" commit --quiet --allow-empty-message -m "$message"
}

# --- 直線履歴 ---------------------------------------------------------------
new_repo linear
commit a.txt "最初のコミット"
commit a.txt "2 番目"
commit b.txt "3 番目"

# --- 分岐と合流 -------------------------------------------------------------
new_repo branch-merge
commit base.txt "base"
git_ -C "$repo" checkout --quiet -b feature
commit feature.txt "feature の作業"
git_ -C "$repo" checkout --quiet main
commit main.txt "main の作業"
git_ -C "$repo" merge --quiet --no-ff --no-edit feature

# --- 連続マージ -------------------------------------------------------------
new_repo merges
commit base.txt "base"
for n in 1 2 3; do
  git_ -C "$repo" checkout --quiet -b "topic-$n" main
  commit "topic-$n.txt" "topic-$n の作業"
  git_ -C "$repo" checkout --quiet main
  git_ -C "$repo" merge --quiet --no-ff --no-edit "topic-$n"
done

# --- オクトパスマージ（親 3 つ）---------------------------------------------
new_repo octopus
commit base.txt "base"
for n in 1 2; do
  git_ -C "$repo" checkout --quiet -b "leg-$n" main
  commit "leg-$n.txt" "leg-$n"
  git_ -C "$repo" checkout --quiet main
done
# main 側にもコミットを置かないと fast-forward してしまい、親が 2 つになる。
commit main.txt "main の作業"
git_ -C "$repo" merge --quiet --no-edit leg-1 leg-2

# --- ルートコミット 2 つ ----------------------------------------------------
new_repo two-roots
commit first-root.txt "1 つ目のルート"
git_ -C "$repo" checkout --quiet --orphan second-root
git_ -C "$repo" rm --quiet -rf .
commit second-root.txt "2 つ目のルート"
git_ -C "$repo" checkout --quiet main
git_ -C "$repo" merge --quiet --no-edit --allow-unrelated-histories second-root

# --- 合流しない orphan ブランチ ---------------------------------------------
# two-roots と違い、こちらは最後まで幹と繋がらない。ref に orphan の印が付く。
new_repo orphan
commit a.txt "幹の 1 つ目"
commit b.txt "幹の 2 つ目"
git_ -C "$repo" checkout --quiet --orphan assets
git_ -C "$repo" rm --quiet -rf .
commit screenshot.txt "orphan の 1 つ目"
commit screenshot.txt "orphan の 2 つ目"
git_ -C "$repo" checkout --quiet main

# --- 日本語ファイル名 -------------------------------------------------------
# core.quotepath=false を付けないと 8 進エスケープで返るケース（CLAUDE.md §2）。
new_repo japanese
commit "日本語ファイル名.txt" "日本語のファイル"
commit "ディレクトリ/入れ子のファイル.txt" "入れ子も置く"

# --- 変更の種類ひととおり ---------------------------------------------------
# T-11 の変更ファイル一覧用。2 つ目のコミットに全種類を詰める。
# **リネームは raw も numstat もパスを 2 つ食う**ので、その前後がずれないことを見る。
new_repo changes
printf 'a\nb\nc\n' >"$repo/old.txt"
printf '1\n' >"$repo/消える.txt"
mkdir -p "$repo/sub"
printf 'x\n' >"$repo/sub/keep.txt"
# NUL を含むファイルはバイナリとして扱われ、numstat が `-` を返す。
printf 'bin\000\001\002' >"$repo/blob.bin"
# 追加と削除のバイナリ。**片側のサイズが「無い」こと**を見る（0 ではない — T-14）。
printf 'gone\000\001' >"$repo/消える.bin"
# 差分本体の文字コード判別と改行検出用（T-13）。
# sjis.txt は「// 日本語」を Shift_JIS で、crlf.txt は UTF-8 で改行だけ CRLF。
# core.autocrlf=false を付けてあるので、CRLF はそのままコミットされる。
printf '// \223\372\226\173\214\352\n1\n' >"$repo/sjis.txt"
printf 'a\r\nb\r\n' >"$repo/crlf.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet -m "最初のコミット"

git_ -C "$repo" mv old.txt "リネーム後.txt"
printf 'a\nb\nc\nd\n' >"$repo/リネーム後.txt"
rm "$repo/消える.txt"
printf 'y\nz\n' >>"$repo/sub/keep.txt"
printf 'new\n' >"$repo/追加.txt"
# サイズの変わるバイナリ（6 → 8 バイト）。
printf 'bin\000\011\011\011\011' >"$repo/blob.bin"
rm "$repo/消える.bin"
printf 'new\000\001\002\003' >"$repo/追加.bin"
printf '// \223\372\226\173\214\352\n1\n2\n' >"$repo/sjis.txt"
printf 'a\r\nB\r\n' >"$repo/crlf.txt"
git_ -C "$repo" add -A
printf '変更の種類ひととおり\n\n本文の段落。\n' |
  git_ -C "$repo" commit --quiet -F -

# --- 空 subject -------------------------------------------------------------
new_repo empty-subject
commit a.txt "最初のコミット"
echo "本文だけ" >>"$repo/a.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet --allow-empty-message -m ""

# --- 空リポジトリ（コミット 0 件）-------------------------------------------
new_repo empty

# --- detached HEAD ----------------------------------------------------------
new_repo detached
commit a.txt "1 つ目"
commit a.txt "2 つ目"
git_ -C "$repo" checkout --quiet --detach HEAD~1

# --- 複数行メッセージ -------------------------------------------------------
# %s は最初の段落だけを 1 行に畳む。本文が混ざらないことを確かめるため。
new_repo messages
commit a.txt "1 つ目"
echo "2 つ目" >>"$repo/a.txt"
git_ -C "$repo" add -A
printf '1 行目の要約
2 行目も同じ段落

本文の段落。
' | git_ -C "$repo" commit --quiet -F -

# --- タグ -------------------------------------------------------------------
# 注釈付きタグは tag オブジェクトを指すので peel が要る（docs/DESIGN.md 付録 A）。
new_repo tags
commit a.txt "1 つ目"
git_ -C "$repo" tag v1.0
commit a.txt "2 つ目"
git_ -C "$repo" tag -a v2.0 -m "注釈付きタグ"
# どのブランチからも到達できないタグ。タグを起点 ref にしないので「グラフ外」になる（§4.2）。
git_ -C "$repo" checkout --quiet -b throwaway
commit orphan.txt "消えるブランチのコミット"
git_ -C "$repo" tag v0.9-orphan
git_ -C "$repo" checkout --quiet main
git_ -C "$repo" branch --quiet -D throwaway

# --- bare -------------------------------------------------------------------
git_ clone --quiet --bare "$root/linear" "$root/bare.git"

# --- クローン ---------------------------------------------------------------
# リモート追跡ブランチ・upstream・origin/HEAD を持つ唯一のリポジトリ。
git_ clone --quiet "$root/bare.git" "$root/cloned"

# --- 上流と分岐したクローン -------------------------------------------------
# ahead/behind の検証用。上流を 3 つ、手元を 2 つ進めて分岐させる。
# bare.git を使い回すと `cloned` の検証が変わってしまうので、別の上流を立てる。
git_ clone --quiet --bare "$root/linear" "$root/upstream.git"
git_ clone --quiet "$root/upstream.git" "$root/diverged"

# 上流だけを進める。押し込み役のクローンは用が済んだら消す。
git_ clone --quiet "$root/upstream.git" "$root/pusher"
repo=$root/pusher
commit up1.txt "上流 1"
commit up2.txt "上流 2"
commit up3.txt "上流 3"
git_ -C "$repo" push --quiet origin main
rm -rf "$root/pusher"

# 手元だけを進めてから、上流の動きを取り込む（マージはしない）。
repo=$root/diverged
commit local1.txt "手元 1"
commit local2.txt "手元 2"
git_ -C "$repo" fetch --quiet origin

# --- 作業ツリーが汚れたリポジトリ（T-16）------------------------------------
# ステージ済み（変更とリネーム）／未ステージ／未追跡が同時にある状態にする。
new_repo dirty
printf 'a\n' >"$repo/staged.txt"
printf 'b\n' >"$repo/unstaged.txt"
printf 'c\n' >"$repo/古い名前.txt"
mkdir -p "$repo/sub"
printf 'd\n' >"$repo/sub/both.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet -m "最初のコミット"

# ステージ済み。
printf 'a\nA\n' >"$repo/staged.txt"
git_ -C "$repo" add staged.txt
git_ -C "$repo" mv "古い名前.txt" "新しい名前.txt"
# **1 つのファイルがステージ済みと未ステージの両方に出る**こともある。
printf 'd\nD\n' >"$repo/sub/both.txt"
git_ -C "$repo" add sub/both.txt
printf 'd\nD\nDD\n' >"$repo/sub/both.txt"
# 未ステージ。
printf 'b\nB\n' >"$repo/unstaged.txt"
# 未追跡（日本語名）。
printf '未追跡の中身\n' >"$repo/未追跡.txt"

# --- マージ衝突で止まったリポジトリ（T-16）----------------------------------
# `--porcelain=v2` の `u` 記録を出すため。**アプリはマージしない**（CLAUDE.md §1）。
new_repo conflict
printf 'base\n' >"$repo/f.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet -m "base"
git_ -C "$repo" checkout --quiet -b other
printf 'other\n' >"$repo/f.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet -m "other 側"
git_ -C "$repo" checkout --quiet main
printf 'main\n' >"$repo/f.txt"
git_ -C "$repo" add -A
git_ -C "$repo" commit --quiet -m "main 側"
# 衝突して止まる。止まった状態がほしいので失敗を無視する。
git_ -C "$repo" merge --quiet --no-edit other || true

# --- fetch の検証用（T-17）--------------------------------------------------
# clone した**あとで**上流を動かす。fetch すると
#   ・main が 1 つ進む
#   ・feature が増える
#   ・gone が --prune で消える
# の 3 つが同時に起きる。
new_repo fetch-src
commit a.txt "最初"
git_ -C "$repo" branch gone

git_ clone --quiet --bare "$root/fetch-src" "$root/fetch-origin.git"
git_ clone --quiet "$root/fetch-origin.git" "$root/fetch-client"

repo=$root/fetch-src
commit b.txt "上流で追加"
git_ -C "$repo" branch feature
git_ -C "$repo" push --quiet "$root/fetch-origin.git" main feature
git_ -C "$repo" push --quiet "$root/fetch-origin.git" --delete gone

# **`FETCH_HEAD` を消しておく。** clone が置いていくことがあり、そのままだと
# 「一度も fetch していない」状態を作れない（放置警告の検証に使う）。
rm -f "$root/fetch-client/.git/FETCH_HEAD"

# --- タグの付け替え（T-17）---------------------------------------------------
# 上流が同じ名前のタグを別のコミットへ付け替えた状態を作る。fetch すると
#   ! [rejected]  v1 -> v1  (would clobber existing tag)
# になり、`--force` 無しでは更新できない。**アプリはタグを書き換えない**
# （CLAUDE.md §1）ので、そのことを利用者へ伝えられるかの検証に使う。
new_repo fetch-tag-src
commit a.txt "最初"
git_ -C "$repo" tag v1

git_ clone --quiet --bare "$root/fetch-tag-src" "$root/fetch-tag-origin.git"
git_ clone --quiet "$root/fetch-tag-origin.git" "$root/fetch-tag-client"

repo=$root/fetch-tag-src
commit b.txt "付け替えの先"
git_ -C "$repo" tag -f v1
git_ -C "$repo" push --quiet --force "$root/fetch-tag-origin.git" v1

# --- fast-forward できるクローン（T-18）--------------------------------------
# **上流だけを進め、手元は動かさない。** `merge --ff-only` が通る唯一の形。
# FF できない側は既存の `diverged`（手元も 2 つ進んでいる）をそのまま使う。
#
# リモート追跡ブランチからローカルブランチを作る検証にも使うので、
# **ローカルには main しか置かない**（`origin/feature` に対応するローカルが無い状態）。
new_repo ff-src
commit a.txt "最初"

git_ clone --quiet --bare "$root/ff-src" "$root/ff-origin.git"
git_ clone --quiet "$root/ff-origin.git" "$root/ff-client"

repo=$root/ff-src
commit b.txt "上流で追加 1"
commit c.txt "上流で追加 2"
git_ -C "$repo" branch feature
git_ -C "$repo" push --quiet "$root/ff-origin.git" main feature

# 手元は動かさずに ref だけ取り込む。これで main は上流より 2 つ遅れる。
git_ -C "$root/ff-client" fetch --quiet origin
rm -rf "$root/ff-src"

echo "生成しました: $root"
ls "$root"
