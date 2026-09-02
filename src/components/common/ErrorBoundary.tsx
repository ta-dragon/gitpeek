import { Component, type ErrorInfo, type ReactNode } from "react";

import { ja } from "../../i18n/ja";

type State = { error: Error | null; stack: string | null };

/**
 * 描画中の例外を受け止める最後の砦。
 *
 * **これが無いと React は木ごと外し、ウィンドウが真っ白になる。**
 * 原因も出ないので、どこで何が起きたのか手掛かりが残らない。
 * ここで握って画面に出し、再読込の導線を置く（docs/DESIGN.md §13.5）。
 *
 * フックでは書けないので、このファイルだけクラスコンポーネントを使う。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 開発時は devtools のコンソールにも残す。
    console.error("描画中の例外", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash">
        <div className="crash__card">
          <h1 className="crash__heading">{ja.crash.title}</h1>
          <p className="crash__body">{ja.crash.body}</p>
          <pre className="crash__detail">{error.message || String(error)}</pre>
          {stack !== null && (
            <details className="crash__more">
              <summary>{ja.crash.stack}</summary>
              <pre className="crash__detail">{stack}</pre>
            </details>
          )}
          <button type="button" className="button" onClick={() => window.location.reload()}>
            {ja.crash.reload}
          </button>
        </div>
      </div>
    );
  }
}
