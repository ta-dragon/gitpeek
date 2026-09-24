<#
.SYNOPSIS
    目視用のリポジトリを作る（scripts/make-demo-repo.sh を Git Bash で動かす）。

.DESCRIPTION
    **PATH の bash を使わない。** Windows では PowerShell やコマンドプロンプトから `bash` と
    打つと、`C:\Windows\System32\bash.exe`（WSL の入口）が先に見つかる。WSL で動くと
    リポジトリが WSL の中（/home/<名前>/gitpeek-demo）にできてしまい、Windows の git からは
    開けない（2026-09-24 に踏んだ）。

    探す順番は結合テストの fixture と同じ（src-tauri/tests/common/mod.rs の bash()）:
      1. 環境変数 GIT_BASH（明示指定）
      2. PATH 上の git.exe から辿る（<インストール先>\cmd\git.exe -> <インストール先>\bin\bash.exe）
      3. 既定のインストール先（Program Files\Git\bin\bash.exe）
    **どれも無ければ止める。** PATH の bash には委ねない（WSL を掴むため）。

.EXAMPLE
    npm run demo:repo

.EXAMPLE
    # 出力先を変える。**npm run は引数を渡せない**ので直に呼ぶ。
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-demo-repo.ps1 D:/demo
#>
[CmdletBinding()]
param(
    # 省略すると Git Bash の ~/gitpeek-demo（C:\Users\<名前>\gitpeek-demo）。
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

function Find-GitBash {
    if ($env:GIT_BASH) {
        return $env:GIT_BASH
    }

    $candidates = @()
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($git) {
        $install = Split-Path -Parent (Split-Path -Parent $git.Source)
        $candidates += Join-Path (Join-Path $install 'bin') 'bash.exe'
    }
    foreach ($name in 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)') {
        $base = [Environment]::GetEnvironmentVariable($name)
        if ($base) {
            $candidates += Join-Path (Join-Path (Join-Path $base 'Git') 'bin') 'bash.exe'
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

$bash = Find-GitBash
if (-not $bash) {
    Write-Host '中止: Git Bash（Git for Windows に付属する bash.exe）が見つかりません。' -ForegroundColor Red
    Write-Host '  → 環境変数 GIT_BASH に bash.exe のパスを入れてから、もう一度実行してください。' -ForegroundColor Yellow
    Write-Host '    PATH の bash は WSL のことがあるので使いません。' -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
    Write-Host "中止: GIT_BASH が指す $bash がありません。" -ForegroundColor Red
    exit 1
}

# Git Bash（msys）へ Windows 形式のパスを渡すと、区切りの記号がエスケープとして食われる。
# スラッシュ区切りにして渡す（tests/common/mod.rs の slashed と同じ）。
$root = Split-Path -Parent $PSScriptRoot
$script = (Join-Path (Join-Path $root 'scripts') 'make-demo-repo.sh').Replace([char]92, '/')

Write-Host "Git Bash: $bash" -ForegroundColor DarkGray
if ($OutDir) {
    & $bash $script $OutDir.Replace([char]92, '/')
} else {
    & $bash $script
}
exit $LASTEXITCODE
