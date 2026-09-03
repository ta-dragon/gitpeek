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
#   empty-subject  subject が空のコミット
#   empty          コミット 0 件（unborn HEAD）
#   detached       detached HEAD
#   messages       複数行メッセージ（subject と本文の切れ目）
#   tags           軽量タグ・注釈付きタグ・グラフ外のタグ
#   bare.git       bare リポジトリ
#   cloned         bare.git のクローン（リモート追跡ブランチと upstream）

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
export GIT_AUTHOR_NAME="Givsoner Test"
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

echo "生成しました: $root"
ls "$root"
