/**
 * 書き込み前の確認と、その結果（T-18。docs/DESIGN.md §8.1, §8.2）。
 *
 * `ProgressDialog.tsx` の `FetchConfirm` を一般化したもの。違いは 2 つある。
 *
 * - **選択肢が複数になりうる**（リモート追跡ブランチは「ローカルブランチを作る」と
 *   「detached で開く」の 2 択）
 * - **止める理由と注意を分けて出す。** 止める理由が 1 つでもあれば実行ボタンを出さない。
 *   押せないボタンを置くより、何を片付ければよいかだけを見せる
 */
import { useEffect } from "react";

import { ja } from "../../i18n/ja";

export type ConfirmAction = {
  label: string;
  /** 既定の見た目にする。**1 つだけ。** */
  primary?: boolean;
  onSelect: () => void;
};

export function ConfirmDialog({
  title,
  lead,
  /**
   * その操作が何をするのかの説明。**止められていても出す。**
   *
   * 「できません」だけ出しても、何ができないのかが分からない。
   */
  help,
  /** 止める理由。**1 つでもあれば `actions` は出さない。** */
  blockers = [],
  /** 注意。実行はできる。 */
  notes = [],
  actions,
  onCancel,
}: {
  title: string;
  lead: string;
  help?: string;
  blockers?: string[];
  notes?: string[];
  actions: ConfirmAction[];
  onCancel: () => void;
}) {
  useEscape(onCancel);
  const blocked = blockers.length > 0;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__box">
        <h2 className="modal__title">{title}</h2>
        <p className="modal__lead">{lead}</p>
        {help !== undefined && <p className="modal__note">{help}</p>}

        {blockers.map((text) => (
          <p key={text} className="modal__blocker">
            {text}
          </p>
        ))}

        {/* 止められているときに注意を並べても読む意味が無いので出さない。 */}
        {!blocked &&
          notes.map((text) => (
            <p key={text} className="modal__note">
              {text}
            </p>
          ))}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            {blocked ? ja.writeOps.close : ja.writeOps.cancel}
          </button>
          {!blocked &&
            actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`button${action.primary === true ? " button--primary" : ""}`}
                onClick={action.onSelect}
              >
                {action.label}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 実行結果。
 *
 * 失敗は**人間向けの 1 行 ＋ 展開で生 stderr**（docs/DESIGN.md §3.6）。fetch と同じ形。
 */
export function ResultDialog({
  ok,
  message,
  details,
  busy,
  onClose,
}: {
  ok: boolean;
  message: string;
  details: string[];
  /** 実行中。**閉じさせない**（途中で閉じると結果を見逃す）。 */
  busy: boolean;
  onClose: () => void;
}) {
  useEscape(busy ? null : onClose);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={message}>
      <div className="modal__box">
        <h2 className="modal__title">
          {busy ? ja.writeOps.running : ok ? ja.writeOps.resultOk : ja.writeOps.resultFailed}
        </h2>
        {!busy && <p className="modal__lead">{message}</p>}

        {!busy && details.length > 0 && (
          <details className="fetchResults__detail">
            <summary>{ja.writeOps.details}</summary>
            <pre className="fetchResults__raw">{details.join("\n")}</pre>
          </details>
        )}

        <div className="modal__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={onClose}
          >
            {ja.writeOps.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `Esc` で閉じる。`onEscape` が null の間は何もしない。 */
function useEscape(onEscape: (() => void) | null): void {
  useEffect(() => {
    if (onEscape === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);
}
