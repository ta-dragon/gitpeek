<#
.SYNOPSIS
    GitLab で公開したものを、そのまま GitHub へ写す（バックアップ）。

.DESCRIPTION
    GitLab を本流、GitHub をバックアップとする。**ここではビルドしない。**
    release.ps1 が作って GitLab へ上げた zip を、**同じバイト列のまま** GitHub の
    Releases へ添付する。GitLab のリリース記述にある SHA-256 と突き合わせ、
    **同一だと確かめてから**上げる（確かめずに写すと、バックアップが別物になっても気付けない）。

    やること:
      1. 前提の確認（トークン / 作業ツリー / タグ / zip）
      2. master と全タグを github remote へ push
      3. GitLab の SHA-256 と手元の zip を突き合わせる
      4. Releases を作り、zip を添付する
      5. ログインしていない人が落とせるか確かめる

    **トークンはこのスクリプトに書かない。** 環境変数 GITHUB_TOKEN から読む
    （必要なスコープは repo）。**remote URL にも .git/config にも書かない** --
    push のたびにヘッダで渡す。git over HTTPS は Bearer を受けないので Basic を使う。

.EXAMPLE
    $env:GITHUB_TOKEN = "<personal access token>"
    npm run backup:github

.EXAMPLE
    # 何が起きるかだけ見る（通信するのは読み取りだけ）。
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-github.ps1 -DryRun
#>
[CmdletBinding()]
param(
    # 省略すると、手元にある v*.*.* のタグ全部。
    [string[]]$Version,

    [string]$Project = 'ta-dragon/gitpeek',

    # SHA-256 の突き合わせ元。本流のほう。
    [string]$GitLabProject = 'tatsunoko7324/gitpeek',

    # push を飛ばして Releases だけ作る。
    [switch]$SkipPush,

    # 書き込みをしない。読み取りと突き合わせまでで止まる。
    [switch]$DryRun,

    # 確認を飛ばす。
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 の既定は TLS 1.0 のことがあり、github.com に弾かれる。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot

function Step($number, $text) { Write-Host "[$number] $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

function Stop-With($text, $hint) {
    Write-Host "中止: $text" -ForegroundColor Red
    if ($hint) { Write-Host "  -> $hint" -ForegroundColor Yellow }
    exit 1
}

function Invoke-Git {
    # **$ErrorActionPreference を下げてから呼ぶ。** PS 5.1 は native コマンドに `2>&1` を
    # 付けると stderr の 1 行ごとを ErrorRecord にするので、Stop のままだと
    # 「git が何か言った」だけで落ちる（git は進捗も警告も stderr に書く）。
    # 成否は呼び出し側が $LASTEXITCODE で見る。
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git -C $root @args 2>&1 | Out-String }
    finally { $ErrorActionPreference = $saved }
}

# `git remote` の出力から 1 行ずつ取り出す。**Out-String は CRLF を返す**ので、
# `(?m)^name$` は `\r` に当たって一致しない（dry run で踏んだ）。
function Get-GitLines($text) {
    ($text -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

# ---------------------------------------------------------------- 1. 前提

Step 1 '前提を確かめる'

$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    Stop-With 'GITHUB_TOKEN が空です。' @'
GitHub -> 右上のアバター -> Settings -> Developer settings -> Personal access tokens で
スコープ repo のトークンを作り、そのターミナルで次を実行してから戻ってください。
  $env:GITHUB_TOKEN = "<トークン>"
（このスクリプトはトークンをファイルにも画面にも残しません）
'@
}

$dirty = Invoke-Git status --porcelain --untracked-files=no
if ($dirty.Trim()) {
    Stop-With '追跡しているファイルに変更が残っています。' "コミットするか元に戻してから実行してください。`n$dirty"
}

# github remote が無ければ足す。**URL にトークンを含めない。**
$remoteUrl = "https://github.com/$Project.git"
if ((Get-GitLines (Invoke-Git remote)) -contains 'github') {
    $current = (Invoke-Git remote get-url github).Trim()
    if ($current -ne $remoteUrl) {
        Stop-With "github remote の URL が想定と違います: $current" "$remoteUrl を指すように直すか、-Project で合わせてください。"
    }
    Note 'github remote はもうあります'
} else {
    Note 'github remote が無いので足します'
    Invoke-Git remote add github $remoteUrl | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-With 'github remote を足せませんでした。' $null }
}

if (-not $Version) {
    $Version = Get-GitLines (Invoke-Git tag --list 'v*') |
        Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
        ForEach-Object { $_.Substring(1) }
}
if (-not $Version) { Stop-With '写すバージョンがありません。' 'git tag --list で確かめてください。' }

$plan = @()
foreach ($v in $Version) {
    if ($v -notmatch '^\d+\.\d+\.\d+$') { Stop-With "バージョンの形が違います: $v" '1.0.0 のように指定してください。' }
    $tag = "v$v"
    $sha = (Invoke-Git rev-parse --verify --quiet "refs/tags/$tag").Trim()
    if (-not $sha) { Stop-With "タグ $tag が手元にありません。" 'git fetch --tags origin を実行してください。' }

    $fileName = "GitPeek-$v-windows-x64.zip"
    $zipPath = Join-Path $root "dist-zip/$fileName"
    if (-not (Test-Path $zipPath)) {
        Stop-With "$fileName がありません。" '本流の zip が要ります。release.ps1 で作ったものを dist-zip に置いてください。'
    }

    $plan += [pscustomobject]@{
        Version  = $v
        Tag      = $tag
        Sha      = $sha
        FileName = $fileName
        ZipPath  = $zipPath
        Hash     = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
        SizeMB   = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    }
}
Note "写すバージョン: $(($plan | ForEach-Object { $_.Tag }) -join ', ')"

# ---------------------------------------------------------------- 2. push

$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
$authHeader = "Authorization: Basic $basic"

if ($SkipPush) {
    Step 2 'push を飛ばす（-SkipPush）'
} elseif ($DryRun) {
    Step 2 'push（-DryRun なので行いません）'
} else {
    Step 2 'master と全タグを GitHub へ push する'
    foreach ($what in 'master', '--tags') {
        # **資格情報マネージャーを切る。** 古い資格情報が残っていると 401 になる。
        $out = Invoke-Git -c 'credential.helper=' -c "http.extraHeader=$authHeader" push github $what
        if ($LASTEXITCODE -ne 0) { Stop-With "push に失敗しました（$what）。" $out }
    }
    Note '上げました'
}

# ---------------------------------------------------------------- 3. 突き合わせ

Step 3 '本流（GitLab）の SHA-256 と突き合わせる'
$encoded = [uri]::EscapeDataString($GitLabProject)
foreach ($item in $plan) {
    $upstream = $null
    try {
        $rel = Invoke-RestMethod -Uri "https://gitlab.com/api/v4/projects/$encoded/releases/$($item.Tag)"
        $m = [regex]::Match($rel.description, '([0-9a-f]{64})')
        if ($m.Success) { $upstream = $m.Groups[1].Value }
    } catch { }

    if (-not $upstream) {
        Note "$($item.Tag): GitLab 側に SHA が見つからないので突き合わせを飛ばします"
    } elseif ($upstream -ne $item.Hash) {
        Stop-With "$($item.Tag) の zip が本流と違います。" @"
GitLab: $upstream
手元  : $($item.Hash)
バックアップが別物になります。本流と同じ zip を dist-zip に置いてください。
"@
    } else {
        Note "$($item.Tag): 一致（$($item.Hash.Substring(0,16))...）"
    }
}

# ---------------------------------------------------------------- 4. これから

$api = "https://api.github.com/repos/$Project"
$headers = @{
    Authorization          = "Bearer $token"
    'User-Agent'           = 'gitpeek-backup'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Step 4 'これから行うこと'
foreach ($item in $plan) {
    Note "リリース作成 POST $api/releases  ($($item.Tag), $($item.FileName), $($item.SizeMB) MB)"
}
Note 'タグは push 済みのものを使う（GitHub 側で作り直さない）'

if ($DryRun) {
    Write-Host ''
    Write-Host '-DryRun なのでここで終わります。' -ForegroundColor Yellow
    exit 0
}

if (-not $Yes) {
    $answer = Read-Host '上のとおり GitHub へ写します。よろしければ y'
    if ($answer -ne 'y') { Stop-With '取りやめました。' $null }
}

# ---------------------------------------------------------------- 5. 公開

function Show-ApiError($err, $what) {
    $detail = ''
    try {
        $stream = $err.Exception.Response.GetResponseStream()
        $detail = (New-Object IO.StreamReader($stream)).ReadToEnd()
    } catch { }
    Stop-With "$what に失敗しました: $($err.Exception.Message)" $detail
}

$made = @()
foreach ($item in $plan) {
    Step 5 "$($item.Tag) のリリースを作る"

    # 既にあれば飛ばす。**作り直さない** -- 添付が二重になる。
    $exists = $null
    try { $exists = Invoke-RestMethod -Uri "$api/releases/tags/$($item.Tag)" -Headers $headers } catch { }
    if ($exists) {
        Note 'もうあるので飛ばします'
        continue
    }

    $description = @"
**バックアップです。** 本流は GitLab にあります:
https://gitlab.com/$GitLabProject/-/releases/$($item.Tag)

Windows 10 / 11 向けのポータブル版です。zip を展開して ``GitPeek.exe`` を実行してください。
インストーラーはありません。

| | |
|---|---|
| ファイル | ``$($item.FileName)``（$($item.SizeMB) MB）|
| SHA-256 | ``$($item.Hash)`` |
| 必要なもの | git が PATH にあること、WebView2 Runtime（Windows 11 は標準）|

**本流と同じ zip です**（SHA-256 を突き合わせてから上げています）。

コード署名はしていないので、初回起動時に SmartScreen の警告が出ます。
「詳細情報」-> 「実行」で進めてください。
"@

    $body = @{
        tag_name   = $item.Tag
        name       = "GitPeek $($item.Version)"
        body       = $description
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json -Depth 5

    try {
        # 日本語が化けないように UTF-8 のバイト列で送る（5.1 の既定は化ける）。
        $bytes = [Text.Encoding]::UTF8.GetBytes($body)
        $release = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $headers `
            -Body $bytes -ContentType 'application/json; charset=utf-8'
    } catch { Show-ApiError $_ "$($item.Tag) のリリース作成" }

    Note "zip を添付する（$($item.SizeMB) MB）"
    $upload = "https://uploads.github.com/repos/$Project/releases/$($release.id)/assets?name=$($item.FileName)"
    try {
        Invoke-RestMethod -Method Post -Uri $upload -Headers $headers `
            -InFile $item.ZipPath -ContentType 'application/zip' | Out-Null
    } catch { Show-ApiError $_ "$($item.Tag) の添付" }

    $made += $item
    Note '作りました'
}

# ---------------------------------------------------------------- 6. 確かめる

Step 6 'ログインしていない人が落とせるか確かめる'
# **ここを確かめないと、リンクはあるのに落とせないリリースができる。**
# 匿名のまま HEAD を投げる（トークンは付けない）。
foreach ($item in $plan) {
    $url = "https://github.com/$Project/releases/download/$($item.Tag)/$($item.FileName)"
    try {
        Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30 | Out-Null
        Note "$($item.Tag): 落とせます"
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
        Note "$($item.Tag): 落とせません（HTTP $code）"
    }
}

Write-Host ''
Write-Host "GitHub へ写しました（新しく作ったのは $($made.Count) 件）。" -ForegroundColor Green
Write-Host "  https://github.com/$Project/releases"
