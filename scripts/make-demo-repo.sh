#!/usr/bin/env bash
#
# 「ブランチが取り込まれているか」（T-38）を目視で確かめるためのリポジトリを作る。
#
#   scripts/make-demo-repo.sh [出力ディレクトリ]      既定は ~/gitpeek-demo
#
# **結合テストの fixture（make-test-repos.sh）とは別物。** あちらはテストが毎回作り直すので
# 目視の途中で消える。こちらは GitPeek に登録して触るためのもので、消さない限り残る。
#
# 作るもの（出力ディレクトリの下）:
#   containment-demo.git   上流（bare）。リモート追跡ブランチを出すために挟む
#   containment-demo       GitPeek に登録するリポジトリ（origin/* が付いたクローン）
#   確認手順.md            どのブランチに何が出れば正しいかの一覧
#
# Windows では **Git Bash で実行すること**（`npm run demo:repo`）。
#
# ブランチ名で期待する結果が読めるようにしてある:
#   期待/…   ブランチ一覧とチップに出る印
#   探す/…   右クリック「このブランチを取り込んでいる可能性があるブランチを調べる…」で使う
#   bulk/…   本数を稼ぐためだけの枝（進み具合と「止める」を見るため）

set -eu

out=${1:-$HOME/gitpeek-demo}
mkdir -p "$out"
out=$(cd "$out" && pwd)

work=$out/.work
bare=$out/containment-demo.git
clone=$out/containment-demo
rm -rf "$work" "$bare" "$clone"

export GIT_AUTHOR_NAME="GitPeek Demo"
export GIT_AUTHOR_EMAIL="demo@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_TERMINAL_PROMPT=0

# 本体と同じ固定オプション（docs/DESIGN.md §3.1）。
git_() {
  git -c core.quotepath=false \
      -c core.autocrlf=false \
      -c core.pager=cat \
      -c color.ui=false \
      -c commit.gpgsign=false \
      -c protocol.file.allow=always \
      "$@"
}

# **コミット時刻を 1 つずつ進める。** 「取り込んでいる可能性があるブランチ」は
# 先端が古いものを候補から外すので、日付が全部同じだと確かめられない。
minute=0
tick() {
  minute=$((minute + 7))
  stamp=$(date -u -d "2026-02-01T00:00:00Z +$minute minutes" +%Y-%m-%dT%H:%M:%S+00:00)
  export GIT_AUTHOR_DATE="$stamp"
  export GIT_COMMITTER_DATE="$stamp"
}

# ファイルを 1 つ書いてコミットする。
commit() {
  file=$1
  body=$2
  message=$3
  printf '%s\n' "$body" >"$work/$file"
  tick
  git_ -C "$work" add -A
  git_ -C "$work" commit --quiet -m "$message"
}

echo "作っています: $clone"

git_ init --quiet -b main "$work"
printf 'a\nb\nc\nd\ne\n' >"$work/f.txt"
printf 'ひとつめ\n' >"$work/other.txt"
printf 'g1\ng2\ng3\n' >"$work/g.txt"
tick
git_ -C "$work" add -A
git_ -C "$work" commit --quiet -m "最初のコミット"

# --- 期待/マージ済み: ふつうにマージした（印「マージ済み」）-------------------
git_ -C "$work" checkout --quiet -b 期待/マージ済み
commit merged.txt "ふつうにマージされる変更" "ふつうにマージするコミット"
git_ -C "$work" checkout --quiet main
tick
git_ -C "$work" merge --quiet --no-ff --no-edit 期待/マージ済み
# bulk/ の枝はここから生やす。**取り込みより前の位置**なので、1 本も「入っている」にならない。
early=$(git_ -C "$work" rev-parse main)

# --- 探す/どこに入ったか: 右クリックで探す対象（main へ入るのは後）-----------
# **先に作っておく**（先端が古いほど、後から動いたブランチが候補に入る）。
git_ -C "$work" checkout --quiet -b 探す/どこに入ったか main
commit s.txt "どこかのリリースに入っているはずの変更" "リリースに載せた変更"

# --- 期待/入っている-squash: squash で取り込まれた（印「入っている」）--------
git_ -C "$work" checkout --quiet -b 期待/入っている-squash main
sed -i 's/^b$/B1/' "$work/f.txt"
tick
git_ -C "$work" commit --quiet -am "squash される 1 つ目"
sed -i 's/^d$/D2/' "$work/f.txt"
tick
git_ -C "$work" commit --quiet -am "squash される 2 つ目"
commit n.txt "新しいファイル" "squash される 3 つ目"

git_ -C "$work" checkout --quiet main
tick
git_ -C "$work" merge --quiet --squash 期待/入っている-squash >/dev/null 2>&1
tick
git_ -C "$work" commit --quiet -m "まとめて取り込む（squash）"

# --- 期待/途中まで: squash のあとに 1 つ足した（印「3/4 まで」）--------------
git_ -C "$work" checkout --quiet -b 期待/途中まで 期待/入っている-squash
commit late.txt "squash のあとに足した変更" "squash のあとに足したコミット"

# --- 期待/入った後に変更: squash のあと、main が同じ行を書き換えた -----------
git_ -C "$work" checkout --quiet -b 期待/入った後に変更 main
sed -i 's/^g2$/G2 を直す/' "$work/g.txt"
tick
git_ -C "$work" commit --quiet -am "g.txt の 2 行目を直す"
git_ -C "$work" checkout --quiet main
tick
git_ -C "$work" merge --quiet --squash 期待/入った後に変更 >/dev/null 2>&1
tick
git_ -C "$work" commit --quiet -m "まとめて取り込む（あとで書き換える）"
sed -i 's/^G2 を直す$/G2 をもう一度直す/' "$work/g.txt"
tick
git_ -C "$work" commit --quiet -am "取り込んだ行をさらに書き換える"

# --- 期待/入っている-cherry-pick: 1 つずつ取り込まれた（squash は指さない）---
git_ -C "$work" checkout --quiet -b 期待/入っている-cherry-pick main
commit p1.txt "1 つ目" "cherry-pick される 1 つ目"
commit p2.txt "2 つ目" "cherry-pick される 2 つ目"
git_ -C "$work" checkout --quiet main
tick
git_ -C "$work" cherry-pick -x --quiet 期待/入っている-cherry-pick~1 期待/入っている-cherry-pick >/dev/null

# --- 期待/印なし-未マージ -----------------------------------------------------
git_ -C "$work" checkout --quiet -b 期待/印なし-未マージ main
commit u.txt "どこにも入っていない変更" "取り込まれないコミット"

# --- 期待/印なし-無関係な履歴（orphan）---------------------------------------
git_ -C "$work" checkout --quiet --orphan 期待/印なし-無関係な履歴
git_ -C "$work" rm -rf --quiet .
commit alone.txt "ひとりだけの履歴" "履歴を共有しないコミット"

# --- 探す/どこに入ったか を 2 つのリリースと main が取り込む -----------------
# release/1.0 が squash で取り込み、release/1.1 はその子、main は release/1.0 をマージする。
# → 「取り込んでいる可能性があるブランチを調べる」で 3 本出る。
git_ -C "$work" checkout --quiet -b release/1.0 main
tick
git_ -C "$work" merge --quiet --squash 探す/どこに入ったか >/dev/null 2>&1
tick
git_ -C "$work" commit --quiet -m "1.0 にまとめて取り込む（squash）"
git_ -C "$work" checkout --quiet -b release/1.1 release/1.0
commit release-note.txt "1.1 の追加分" "1.1 の作業"
git_ -C "$work" checkout --quiet main
tick
git_ -C "$work" merge --quiet --no-ff --no-edit release/1.0

# タグは調べる対象にしない（候補にも相手にもならないことの材料）。
git_ -C "$work" tag v1.0 main

# --- bulk/: 本数を稼ぐ枝。進み具合と「止める」を見るため ---------------------
bulk=${GITPEEK_DEMO_BULK:-60}
n=1
while [ "$n" -le "$bulk" ]; do
  name=$(printf 'bulk/%03d' "$n")
  git_ -C "$work" checkout --quiet -b "$name" "$early"
  commit "bulk-$n.txt" "$n 番目の枝" "$name の作業"
  n=$((n + 1))
done
git_ -C "$work" checkout --quiet main

# --- 上流に見せるための bare と、そのクローン --------------------------------
git_ init --quiet --bare -b main "$bare"
git_ -C "$work" remote add origin "$bare"
git_ -C "$work" push --quiet --all origin
git_ -C "$work" push --quiet --tags origin
# origin/HEAD を置く（GitPeek は幹をこれで決める。docs/DESIGN.md §4.2）。
git_ -C "$bare" symbolic-ref HEAD refs/heads/main

git_ clone --quiet "$bare" "$clone"
# **印はローカルブランチに付く**ので、確かめたいものは手元にも作る。
for name in 期待/マージ済み 期待/入っている-squash 期待/途中まで 期待/入った後に変更 \
            期待/入っている-cherry-pick 期待/印なし-未マージ 期待/印なし-無関係な履歴 \
            探す/どこに入ったか release/1.0 release/1.1; do
  git_ -C "$clone" branch --quiet --track "$name" "origin/$name"
done

rm -rf "$work"

cat >"$out/確認手順.md" <<'GUIDE'
# GitPeek の「取り込まれているか」を確かめる（T-38）

`containment-demo` を GitPeek に登録して開く。**ブランチ名が期待する結果になっている。**

## 1. ブランチ一覧とチップの印（相手は幹 ＝ origin/main）

| ブランチ | 出るはずの印 | ホバーで読めること |
|---|---|---|
| `期待/マージ済み` | マージ済み | ふつうにマージされている |
| `期待/入っている-squash` | 入っている | 「まとめて取り込む（squash）」と同じ変更。押すとそのコミットへ移動 |
| `期待/途中まで` | 3/4 まで | 4 つのうち古い 3 つまで。残り 1 つは入っていない |
| `期待/入った後に変更` | 入った後に変更 | squash で入ったあと、main で同じ所が書き換えられた |
| `期待/入っている-cherry-pick` | 入っている | まとめて入れたコミットは無い（1 つずつ入った） |
| `期待/印なし-未マージ` | **印なし** | — |
| `期待/印なし-無関係な履歴` | **印なし** | — |
| `main` | 印なし（幹そのもの） | — |
| `v1.0`（タグ） | **印なし**（タグは調べない） | — |

- 印を押すと、まとめて入れたコミットへ移動する。移動先をグラフから外していると、その理由が出る
- リモートブランチ（`origin/…`）には初めは印が無い。右クリックの「origin/main に入っているか調べる」で付く

## 2. 右クリックで「取り込んでいるブランチ」を探す

`探す/どこに入ったか` を右クリック →「このブランチを取り込んでいる可能性があるブランチを調べる…」。

- 調べている間、**何本中何本まで調べたか**と**残りの目安**が出る
- 見つかるのは **`main` / `release/1.0` / `release/1.1`**（ローカルとリモートの両方＝ 6 本）。
  `release/1.0` は squash で取り込んでいるので、そのコミットへ移動できる
- `bulk/…` は 1 本も出ない（枝の本数を増やして、進み具合と「止める」を見るためだけのもの）
- **途中で「止める」を押す**と、そこまでの結果が残り「残りは調べていません」と出る。
  最後まで待つと「〜本を調べ、〜本に入っていました」に変わる
- タグ `v1.0` を右クリックすると、この項目は押せない（理由がホバーで読める）

## 3. git のバージョン（このリポジトリでは確かめられない）

2.38 未満の git を設定で指定したとき、起動画面で止まり、なぜ 2.38 が要るかが読めること。

## 作り直し

`npm run demo:repo` をもう一度実行すると作り直す（このフォルダごと上書きされる）。
GitPeek に登録したままでも構わないが、**開いたまま作り直すと読み込み中のものと食い違う**ので、
一度ほかのリポジトリへ切り替えてから実行するとよい。
GUIDE

echo "できました:"
echo "  リポジトリ  $clone"
echo "  確認手順    $out/確認手順.md"
