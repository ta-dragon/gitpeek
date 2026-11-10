/**
 * いま起動しているアプリの版をどう出すか（T-43。純関数）。
 *
 * 出す場所は 2 つ — **ウィンドウのタイトル**と**設定画面の下端**。どちらもここで
 * 組み立てて、形を揃える。
 *
 * **開発用の起動（`tauri dev`）はそう添える。** 未コミットの変更が入っていても
 * リリースと同じ版を名乗るので、数字だけだと取り違える。
 */
import { ja } from "../i18n/ja";
import type { AppInfo } from "./ipc";

function label(info: AppInfo): string {
  const base = ja.app.withVersion(ja.app.name, info.version);
  return info.dev ? ja.app.devBuild(base) : base;
}

/**
 * ウィンドウのタイトル。
 *
 * **読めなかったら名前だけにする。** タイトルに「読めませんでした」と出し続けるより、
 * いままでどおりのほうがましで、理由は設定画面で読める。
 */
export function windowTitle(info: AppInfo | null): string {
  return info === null ? ja.app.name : label(info);
}

/** 設定画面の下端の 1 行。**読めなかったときは、そう言う**（黙って消さない）。 */
export function versionLine(info: AppInfo | null): string {
  return info === null ? ja.app.versionUnknown : label(info);
}
