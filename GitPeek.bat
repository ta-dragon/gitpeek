@echo off
chcp 65001 > nul
setlocal

rem GitPeek を開発モードで起動する（ダブルクリック用）。
rem 配布用の exe を作るときは npm run package:zip を使う（T-26）。

cd /d "%~dp0"
title GitPeek

where npm >nul 2>nul
if errorlevel 1 (
  echo [エラー] npm が見つかりません。Node.js をインストールしてください。
  echo         https://nodejs.org/
  goto :error
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [エラー] cargo が見つかりません。Rust 1.88 以上をインストールしてください。
  echo         https://rustup.rs/
  goto :error
)

if not exist "node_modules" (
  echo 依存パッケージを取得しています（初回のみ）…
  call npm install
  if errorlevel 1 goto :error
)

echo GitPeek を起動しています。
echo 初回と Rust のコード変更後はビルドに数分かかります。
echo このウィンドウを閉じるとアプリも終了します。
echo.
call npm run tauri dev
if errorlevel 1 goto :error

endlocal
exit /b 0

:error
echo.
echo 起動に失敗しました。上の出力を確認してください。
pause
exit /b 1
