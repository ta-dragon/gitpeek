import { Component, type ErrorInfo, type ReactNode } from "react";

import { ja } from "../../i18n/ja";
import { crashSummary, logHint } from "../../lib/crashNotice";
import { logFrontendError, logStatus, openLogFolder, type LogStatus } from "../../lib/ipc";

type State = { error: Error | null; stack: string | null; log: LogStatus | null };

/**
 * 描画中の例外を受け止める最後の砦。
 *
 * **これが無いと React は木ごと外し、ウィンドウが真っ白になる。**
 * 原因も出ないので、どこで何が起きたのか手掛かりが残らない。
 * ここで握って画面に出し、再読込の導線を置く（docs/DESIGN.md §13.5）。
 *
 * **ログにも 1 行残す**（T-24）。この画面は閉じると何も残らないので、
 * Rust 側の記録と同じファイルに並べる。**文言の組み立ては純関数**
 * （`lib/crashNotice.ts`）で、ここは呼ぶだけ（CLAUDE.md §8）。
 *
 * フックでは書けないので、このファイルだけクラスコンポーネントを使う。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: null, log: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 開発時は devtools のコンソールにも残す。
    console.error("描画中の例外", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });

    // **ログへ送るのと、場所を聞くのは別々に失敗しうる。**
    // どちらが落ちてもこの画面は出し続ける（ここが最後の砦なので投げない）。
    void logFrontendError(
      `${error.message || String(error)}${info.componentStack ?? ""}`,
    ).catch(() => {});
    void logStatus()
      .then((log) => this.setState({ log }))
      .catch(() => {});
  }

  render(): ReactNode {
    const { error, stack, log } = this.state;
    if (error === null) return this.props.children;

    const hint = logHint(log);
    return (
      <div className="crash">
        <div className="crash__card">
          <h1 className="crash__heading">{ja.crash.title}</h1>
          <p className="crash__body">{ja.crash.body}</p>
          <pre className="crash__detail">{crashSummary(error.message || String(error))}</pre>
          {stack !== null && (
            <details className="crash__more">
              <summary>{ja.crash.stack}</summary>
              <pre className="crash__detail">{stack}</pre>
            </details>
          )}
          <p className="crash__log">{hint.text}</p>
          <div className="crash__actions">
            <button type="button" className="button" onClick={() => window.location.reload()}>
              {ja.crash.reload}
            </button>
            {/* **開けないときも消さない。** 押せない形で残す（CLAUDE.md §6）。 */}
            <button
              type="button"
              className="button"
              disabled={!hint.canOpen}
              onClick={() => void openLogFolder().catch(() => {})}
            >
              {ja.crash.openLogFolder}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
