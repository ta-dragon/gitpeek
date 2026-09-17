<#
.SYNOPSIS
    配布用 zip を作り、GitLab の Releases に載せる。

.DESCRIPTION
    Windows でビルドしたものをそのまま上げる。GitLab.com の共有ランナーには
    Windows のものが無く、Tauri の Windows 向けビルドを Linux で作るのは現実的で
    ないため、**CI では作らず手元で作って上げる**（docs/DESIGN.md §2.3.2）。

    やること:
      1. 前提の確認（トークン / 作業ツリー / push 済みか / タグの重複）
      2. npm run package:zip でビルド
      3. zip をバージョン付きの名前にして SHA-256 を出す
      4. 汎用パッケージレジストリへアップロード
      5. Releases を作る（タグは GitLab 側で作られる）

    **トークンはこのスクリプトに書かない。** 環境変数 GITLAB_TOKEN から読む。
    必要なスコープは api（read_api では書けない）。

.EXAMPLE
    $env:GITLAB_TOKEN = "<personal access token>"
    npm run release

.EXAMPLE
    # 何が起きるかだけ見る（通信しない）。
    # **npm run release は引数を渡せない**ので、オプションを付けるときは直に呼ぶ。
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -DryRun
#>
[CmdletBinding()]
param(
    # 省略すると src-tauri/tauri.conf.json の version を使う。
    [string]$Version,

    # <名前空間>/<プロジェクト>。API では URL エンコードして渡す。
    [string]$Project = 'tatsunoko7324/gitpeek',

    # 既に dist-zip に作ってあるものを使う。
    [switch]$SkipBuild,

    # 通信も破壊的操作もしない。組み立てた URL と本文だけ出す。
    [switch]$DryRun,

    # 確認を飛ばす。
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 は既定が TLS 1.0 のことがあり、gitlab.com に弾かれる。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot

function Step($number, $text) { Write-Host "[$number] $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

function Stop-With($text, $hint) {
    Write-Host "中止: $text" -ForegroundColor Red
    if ($hint) { Write-Host "  → $hint" -ForegroundColor Yellow }
    exit 1
}

function Invoke-Git {
    # 出力を文字列で受ける。失敗は呼び出し側で見る（$LASTEXITCODE）。
    & git -C $root @args 2>&1 | Out-String
}

# ---------------------------------------------------------------- 1. 前提

Step 1 '前提を確かめる'

$token = $env:GITLAB_TOKEN
if ([string]::IsNullOrWhiteSpace($token) -and -not $DryRun) {
    Stop-With 'GITLAB_TOKEN が空です。' @'
GitLab → 右上のアバター → Edit profile → Access tokens で、スコープ api の
トークンを作り、そのターミナルで次を実行してから戻ってください。
  $env:GITLAB_TOKEN = "<トークン>"
（このスクリプトはトークンをファイルにも画面にも残しません）
'@
}

if (-not $Version) {
    $conf = Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = $conf.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Stop-With "バージョンの形が違います: $Version" '1.0.0 のように 3 つの数字で指定してください。'
}
$tag = "v$Version"
Note "バージョン $Version（タグ $tag）"

# 作業ツリーが汚れたままビルドすると、zip の中身が push 済みのコードと食い違う。
# 未追跡ファイルはビルドに入らないので見ない。
$dirty = Invoke-Git status --porcelain --untracked-files=no
if ($dirty.Trim()) {
    Stop-With '追跡しているファイルに変更が残っています。' "コミットするか元に戻してから実行してください。`n$dirty"
}

$head = (Invoke-Git rev-parse HEAD).Trim()
$upstream = (Invoke-Git rev-parse --verify --quiet 'origin/master').Trim()
if (-not $upstream) {
    Stop-With 'origin/master が見つかりません。' 'git fetch origin を実行してください。'
}
if ($head -ne $upstream) {
    Stop-With 'HEAD と origin/master が違います。' 'push していないコミットからリリースを作らないでください（git push origin master）。'
}
Note "コミット $($head.Substring(0,8))"

$existing = Invoke-Git ls-remote --tags origin "refs/tags/$tag"
if ($existing.Trim()) {
    Stop-With "タグ $tag は既に origin にあります。" 'バージョンを上げるか、GitLab 側でそのリリースとタグを消してください。'
}

# ---------------------------------------------------------------- 2. ビルド

$fileName = "GitPeek-$Version-windows-x64.zip"
$zipPath = Join-Path $root "dist-zip/$fileName"

if ($SkipBuild) {
    Step 2 'ビルドを飛ばす（-SkipBuild）'
    if (-not (Test-Path $zipPath)) { Stop-With "$fileName がありません。" '-SkipBuild を外して実行してください。' }
} else {
    Step 2 'npm run package:zip でビルドする（数分かかります）'
    Push-Location $root
    try {
        & npm run package:zip
        if ($LASTEXITCODE -ne 0) { Stop-With 'ビルドに失敗しました。' '上の出力を見てください。' }
    } finally { Pop-Location }

    $built = Join-Path $root 'dist-zip/GitPeek-portable.zip'
    if (-not (Test-Path $built)) { Stop-With 'GitPeek-portable.zip ができていません。' 'package:zip の出力を見てください。' }
    Copy-Item $built $zipPath -Force
}

$size = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
$sha = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
Note "$fileName（$size MB）"
Note "SHA-256 $sha"

# ---------------------------------------------------------------- 3. 送る先

$encoded = [uri]::EscapeDataString($Project)
$api = "https://gitlab.com/api/v4/projects/$encoded"
$uploadUrl = "$api/packages/generic/gitpeek/$Version/$fileName"
$downloadUrl = $uploadUrl   # 公開プロジェクトなので、同じ URL で誰でも落とせる

$description = @"
Windows 10 / 11 向けのポータブル版です。zip を展開して ``GitPeek.exe`` を実行してください。
インストーラーはありません。

| | |
|---|---|
| ファイル | ``$fileName``（$size MB）|
| SHA-256 | ``$sha`` |
| 必要なもの | git **2.38 以上**が PATH にあること、WebView2 Runtime（Windows 11 は標準）|

コード署名はしていないので、初回起動時に SmartScreen の警告が出ます。
「詳細情報」→「実行」で進めてください。
"@

$body = @{
    name        = "GitPeek $Version"
    tag_name    = $tag
    ref         = $head
    description = $description
    assets      = @{
        links = @(
            @{
                name              = $fileName
                url               = $downloadUrl
                link_type         = 'package'
                direct_asset_path = "/$fileName"
            }
        )
    }
} | ConvertTo-Json -Depth 6

Step 3 'これから行うこと'
Note "アップロード PUT  $uploadUrl"
Note "リリース作成 POST $api/releases"
Note "タグ $tag は GitLab 側で $($head.Substring(0,8)) に作られます"
Note ''
Note '落とす人にログインを求めないためには、プロジェクトの設定で'
Note '「Allow anyone to pull from Package Registry」が ON である必要があります（既定は OFF）。'
Note 'Settings → General → Visibility, project features, permissions'
Note '公開したあとに、このスクリプトが匿名で落とせるか確かめます。'

if ($DryRun) {
    Write-Host ''
    Write-Host '-DryRun なのでここで終わります。送る本文は次のとおりです。' -ForegroundColor Yellow
    Write-Host $body
    exit 0
}

if (-not $Yes) {
    $answer = Read-Host '上のとおり公開します。よろしければ y'
    if ($answer -ne 'y') { Stop-With '取りやめました。' $null }
}

# ---------------------------------------------------------------- 4. 公開

$headers = @{ 'PRIVATE-TOKEN' = $token }

function Show-ApiError($err, $what) {
    # 応答本文に理由が入っている。トークンは出さない。
    $detail = ''
    try {
        $stream = $err.Exception.Response.GetResponseStream()
        $detail = (New-Object IO.StreamReader($stream)).ReadToEnd()
    } catch { }
    Stop-With "$what に失敗しました: $($err.Exception.Message)" $detail
}

Step 4 'zip をアップロードする'
try {
    Invoke-RestMethod -Method Put -Uri $uploadUrl -Headers $headers `
        -InFile $zipPath -ContentType 'application/octet-stream' | Out-Null
} catch { Show-ApiError $_ 'アップロード' }
Note '上げました'

Step 5 'リリースを作る'
try {
    # 日本語が化けないように UTF-8 のバイト列で送る（5.1 の既定は化ける）。
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $headers `
        -Body $bytes -ContentType 'application/json; charset=utf-8' | Out-Null
} catch { Show-ApiError $_ 'リリースの作成' }

Step 6 'ログインしていない人が落とせるか確かめる'
# **ここを確かめないと、リンクはあるのに落とせないリリースができる。**
# 匿名のまま HEAD を投げる（トークンは付けない）。
$anonymous = $false
try {
    Invoke-WebRequest -Uri $downloadUrl -Method Head -UseBasicParsing -TimeoutSec 30 | Out-Null
    $anonymous = $true
    Note '落とせます'
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
    Note "落とせません（HTTP $code）"
}

Write-Host ''
Write-Host "GitPeek $Version を公開しました。" -ForegroundColor Green
Write-Host "  https://gitlab.com/$Project/-/releases/$tag"

if (-not $anonymous) {
    Write-Host ''
    Write-Host 'ただし、いまはログインしていない人が zip を落とせません。' -ForegroundColor Yellow
    Write-Host '次の設定を ON にしてください（既定は OFF です）:' -ForegroundColor Yellow
    Write-Host "  https://gitlab.com/$Project/edit"
    Write-Host '  Visibility, project features, permissions → Package registry →'
    Write-Host '  「Allow anyone to pull from Package Registry」'
    Write-Host 'リリースを作り直す必要はありません。設定を変えれば同じリンクで落とせるようになります。'
}

Write-Host ''
Write-Host '確かめること:' -ForegroundColor Yellow
Write-Host '  - シークレットウィンドウで上の URL を開き、ログインせずに zip を落とせるか'
Write-Host '  - 落とした zip の SHA-256 が一致するか'
Write-Host "      Get-FileHash -Algorithm SHA256 <落としたファイル>"
Write-Host '  - 手元にもタグを持ってくる: git fetch --tags'
