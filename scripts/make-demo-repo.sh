#!/usr/bin/env bash
#
# 「ブランチが取り込まれているか」（T-38）・「ファイルを変えたコミットを辿る」（T-40）・
# 「ブランチ同士を比べる」（T-41）を目視で確かめるためのリポジトリを作る。
#
#   scripts/make-demo-repo.sh [出力ディレクトリ]      既定は ~/gitpeek-demo
#
# **結合テストの fixture（make-test-repos.sh）とは別物。** あちらはテストが毎回作り直すので
# 目視の途中で消える。こちらは GitPeek に登録して触るためのもので、消さない限り残る。
#
# 作るもの（出力ディレクトリの下）:
#   containment-demo.git   上流（bare）。リモート追跡ブランチを出すために挟む
#   containment-demo       GitPeek に登録するリポジトリ（origin/* が付いたクローン）
#   history-demo           ファイルの改名をまたぐ履歴（T-40）。これも GitPeek に登録する
#   compare-demo           分かれたあと両側が進んだ枝とタグ 2 つ（T-41）。これも GitPeek に登録する
#   確認手順.md            どのブランチに何が出れば正しいかの一覧
#
# Windows では **Git Bash で実行すること**。`npm run demo:repo` はどこから実行しても
# `make-demo-repo.ps1` が Git Bash を探して呼ぶ（PATH の `bash` は WSL のことがあり、WSL で動くと
# リポジトリが WSL の中にできて Windows の git から開けない）。
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

# 表示は Windows のパスで出す（Git Bash の /c/… や /tmp/… は、エクスプローラーに貼れない）。
show() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi
}

echo "作っています: $(show "$out")"

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

# --- history-demo: ファイルを変えたコミットを辿る（T-40）-----------------------
# **`git log --follow` が落とす形**をわざと入れてある（docs/DESIGN.md §6.7）:
#   - 幹で改名したあと、並行していた枝が古い名前のまま直してから取り込まれる
#   - 両側で同じ変更をした枝を取り込む（git の既定の絞り方だと枝の側が落ちる）
# 取り込んだ枝は消す（ふつうそうする）。残すと起点になって、落ちる形にならない。
hist=$out/history-demo
rm -rf "$hist"
git_ init --quiet -b main "$hist"

# ファイルを書いてコミットする（history-demo 用）。
hcommit() {
  tick
  git_ -C "$hist" add -A
  git_ -C "$hist" commit --quiet -m "$1"
}
# 行を書き換える（行番号, 新しい中身, ファイル）。
hline() {
  sed -i "$1s/.*/$2/" "$hist/$3"
}

mkdir -p "$hist/app" "$hist/src"
seq -f '設定 %g 行目' 1 12 >"$hist/app/config.txt"
printf '説明\n' >"$hist/README.txt"
hcommit "最初のコミット"
hline 2 '設定 2 行目（項目を足した）' app/config.txt
hcommit "設定: 項目を足す"

git_ -C "$hist" checkout --quiet -b 並行/古い名前のまま
git_ -C "$hist" checkout --quiet main
git_ -C "$hist" mv app/config.txt src/config.txt
hcommit "設定: app/ から src/ へ移す"
hline 5 '設定 5 行目（既定値を変えた）' src/config.txt
hcommit "設定: 既定値を変える"

git_ -C "$hist" checkout --quiet 並行/古い名前のまま
hline 3 '設定 3 行目（タイムアウトを足した）' app/config.txt
hcommit "設定（古い名前のまま）: タイムアウトを足す"
hline 7 '設定 7 行目（コメントを直した）' app/config.txt
hcommit "設定（古い名前のまま）: コメントを直す"
git_ -C "$hist" checkout --quiet main
tick
git_ -C "$hist" merge --quiet --no-ff 並行/古い名前のまま -m "並行していた作業を取り込む" >/dev/null
git_ -C "$hist" branch --quiet -d 並行/古い名前のまま

git_ -C "$hist" mv src/config.txt src/settings.txt
hcommit "設定: 名前を settings に変える"

git_ -C "$hist" checkout --quiet -b 同じ変更
hline 9 '設定 9 行目（両側で同じに直した）' src/settings.txt
hcommit "設定（枝）: 9 行目を直す（幹と同じ変更）"
git_ -C "$hist" checkout --quiet main
hline 9 '設定 9 行目（両側で同じに直した）' src/settings.txt
hcommit "設定（幹）: 9 行目を直す（枝と同じ変更）"
tick
git_ -C "$hist" merge --quiet --no-ff 同じ変更 -m "同じ変更をした枝を取り込む"
git_ -C "$hist" branch --quiet -d 同じ変更

printf '説明（書き足した）\n' >>"$hist/README.txt"
hcommit "README を書き足す"
printf 'x\n' >"$hist/x.txt"
hcommit "x.txt を足す"
printf '角括弧\n' >"$hist/[x].txt"
hcommit "[x].txt を足す（glob なら x.txt にも当たる名前）"
printf '日本語\n' >"$hist/日本語 ファイル.txt"
hcommit "日本語 ファイル.txt を足す"

# まだ取り込んでいない枝（幹の外にも印が付くこと）。
git_ -C "$hist" checkout --quiet -b 作業中/設定を直す
hline 11 '設定 11 行目（作業中）' src/settings.txt
hcommit "設定（作業中）: 11 行目を直す"
git_ -C "$hist" checkout --quiet main

# 作業ツリー: 追跡しているファイルを直しかけ、未追跡のファイルを 1 つ置く。
hline 12 '設定 12 行目（手元で直しかけ）' src/settings.txt
printf 'まだコミットしていない\n' >"$hist/未追跡.txt"

# --- compare-demo: ブランチ同士を比べる（T-41）---------------------------------
# **分かれたあと両側が進んだ形**にしてある。「マージベース起点」を外すと、幹の側で進んだ
# ぶん（main.txt）が逆向きに差分へ混ざるのが目で分かる。
cmp=$out/compare-demo
rm -rf "$cmp"
git_ init --quiet -b main "$cmp"

ccommit() {
  printf '%s\n' "$2" >>"$cmp/$1"
  tick
  git_ -C "$cmp" add -A
  git_ -C "$cmp" commit --quiet -m "$3"
}

ccommit main.txt "幹 1" "幹: 最初のコミット"
ccommit shared.txt "共有 1" "幹: 共有するファイルを足す"
git_ -C "$cmp" tag v1.0
git_ -C "$cmp" checkout --quiet -b feature/画面を足す
ccommit feature.txt "画面 1" "枝: 画面を足す"
ccommit feature.txt "画面 2" "枝: 画面に項目を足す"
git_ -C "$cmp" checkout --quiet main
ccommit main.txt "幹 2" "幹: 枝と関係ない修正 1"
ccommit main.txt "幹 3" "幹: 枝と関係ない修正 2"
ccommit shared.txt "共有 2" "幹: 共有するファイルを直す"
git_ -C "$cmp" tag v1.1
# 幹と同じコミットを指すブランチ（「比べる」が押せないことの材料）。
git_ -C "$cmp" branch 幹と同じ位置 main

cat >"$out/確認手順.md" <<'GUIDE'
# GitPeek の目視用リポジトリ（T-38 / T-40 / T-41）

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

## 4. ファイルを変えたコミットを辿る（T-40。`history-demo`）

`history-demo` を GitPeek に登録して開く。`src/settings.txt` は **`app/config.txt` → `src/config.txt` →
`src/settings.txt`** と 2 回名前が変わっている。

1. `設定: 名前を settings に変える` を選び、変更ファイルの一覧で `src/settings.txt` を右クリック →
   「このファイルを変えたコミットに印を付ける」
   - 探す欄に `path:"src/settings.txt"` が入り、印が付く
   - 欄の下に「名前が変わる前の src/config.txt、app/config.txt も含めています。」と出る
   - 印が付くのは **`設定` で始まるコミットと、2 つの取り込み**（`並行していた作業を取り込む` /
     `同じ変更をした枝を取り込む`）、それに `最初のコミット`。`README` や `x.txt` には付かない
   - **`設定（古い名前のまま）: …` の 2 つ**と **`設定（枝）: 9 行目を直す（幹と同じ変更）`** に
     印が付いていること（`git log --follow` や git の既定の絞り方だと落ちるもの）
   - まだ取り込んでいない `設定（作業中）: 11 行目を直す` にも付く
2. 「次へ / 前へ」で辿ると、**そのコミットでの名前のファイルが選ばれて差分が出る**
   （`設定: 項目を足す` では `app/config.txt`、`設定: 既定値を変える` では `src/config.txt`）
3. 作業ツリーの行を選び、直しかけの `src/settings.txt` を右クリックしても同じことができる。
   **`未追跡.txt` を右クリックすると項目は押せず**、理由がホバーで読める
4. 探す欄に `path:"[x].txt"` と打つと `[x].txt を足す` だけに付く（`x.txt を足す` には付かない）。
   `path:"日本語 ファイル.txt"` も探せる
5. `path:"src/settings.txt" 9 行目` と打つと、2 つの `9 行目を直す` だけに絞れる
6. 「やめる」で欄を空にすると印が消え、コミットを移っても選ぶファイルが勝手に変わらなくなる

## 5. ブランチ同士を比べる（T-41。`compare-demo`）

`compare-demo` を GitPeek に登録して開く。`feature/画面を足す` は `v1.0` の位置で幹から分かれ、
そのあと**枝で 2 つ、幹で 3 つ**進んでいる。

1. ブランチ一覧で `feature/画面を足す` を右クリック →「比べる…」
   - 比較元に `main`、比較先に `feature/画面を足す` が選ばれた状態でダイアログが開く
   - 「マージベース起点」にチェックが入っている
2. 「比べる」を押す
   - 差分に出るのは **`feature.txt` だけ**（枝で変えたもの）
   - 比較バーに `main` と `feature/画面を足す` の名前、
     「比較先にだけあるコミット 2 件 / 比較元にだけあるコミット 3 件」が出る
3. 比較バーの「マージベース起点」を外す
   - **`main.txt` と `shared.txt` も差分に出る**（幹の側で進んだぶんが、逆向きに混ざる）
4. グラフのチップ（`v1.1` のタグなど）を右クリックしても「比べる…」がある。
   比較元に `v1.0`、比較先に `v1.1` を選んで比べると、幹の 3 つぶんの差分になる
5. 比較元と比較先に同じものを選ぶと「比べる」は押せず、理由が出る。
   `main` と `幹と同じ位置` を選んだときも押せない（同じコミットを指している）
6. 比べたまま「AI レビュー」を開くと、比較の範囲がレビューの対象として出る

## 作り直し

`npm run demo:repo` をもう一度実行すると作り直す（このフォルダごと上書きされる）。
GitPeek に登録したままでも構わないが、**開いたまま作り直すと読み込み中のものと食い違う**ので、
一度ほかのリポジトリへ切り替えてから実行するとよい。
GUIDE

echo "できました:"
echo "  リポジトリ  $(show "$clone")"
echo "              $(show "$hist")"
echo "              $(show "$cmp")"
echo "  確認手順    $(show "$out/確認手順.md")"
