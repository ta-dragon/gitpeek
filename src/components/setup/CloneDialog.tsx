/**
 * clone の入力・進行・結果（T-19。docs/DESIGN.md §8.4）。
 *
 * **`ConfirmDialog` を使わない。** あちらは「止める理由が 1 つでもあれば実行ボタンごと
 * 消す」器なので、入力の検証（URL が空、保存先が未選択）を載せると、
 * **直せば押せるようになるボタンが消えてしまう**。ここでは入れっぱなしにして無効化する。
 *
 * 結果を出すのは**失敗と中止のときだけ**。成功したときは呼び出し側が閉じて、
 * clone したリポジトリをそのまま開く。
 */
import { useEffect, useMemo, useState } from "react";

import { ja } from "../../i18n/ja";
import { defaultFolderName, joinPath } from "../../lib/clonePath";
import type { CloneOutcome, CloneProgress, CloneRequest } from "../../lib/ipc";
import { LoadProgress } from "../common/LoadProgress";

export function CloneDialog({
  /** 既定の保存先（`settings.json` の `workspaceRoot`）。未設定なら null。 */
  defaultParent,
  busy,
  cancelling,
  progress,
  outcome,
  onPickParent,
  onStart,
  onCancel,
  onBack,
  onClose,
}: {
  defaultParent: string | null;
  busy: boolean;
  cancelling: boolean;
  progress: CloneProgress | null;
  outcome: CloneOutcome | null;
  /** フォルダ選択ダイアログを開く。選ばれなければ null。 */
  onPickParent: () => Promise<string | null>;
  onStart: (request: CloneRequest, rememberParent: boolean) => void;
  onCancel: () => void;
  /** 結果から入力へ戻る。**入力欄はそのまま残る。** */
  onBack: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(defaultParent ?? "");
  const [folder, setFolder] = useState("");
  // **利用者が名前を触ったら、URL の変更で上書きしない。**
  const [folderEdited, setFolderEdited] = useState(false);
  // **サブモジュールは既定で取り込まない**（CLAUDE.md §1）。毎回チェックさせる。
  const [submodules, setSubmodules] = useState(false);
  const [remember, setRemember] = useState(false);

  // URL から既定のフォルダ名を埋める。**決められないときは空**（利用者に入力させる）。
  const suggested = useMemo(() => defaultFolderName(url), [url]);
  useEffect(() => {
    if (!folderEdited) setFolder(suggested);
  }, [suggested, folderEdited]);

  // **走っている間は `Esc` で閉じない。** 中止は明示的に押させる。
  useEscape(busy ? null : onClose);

  const trimmedUrl = url.trim();
  const trimmedParent = parent.trim();
  const trimmedFolder = folder.trim();
  const preview = joinPath(trimmedParent, trimmedFolder);
  const ready = trimmedUrl !== "" && preview !== "";
  // 既定と同じ場所なら「覚える」ことに意味が無いので、そもそも出さない。
  const canRemember = trimmedParent !== "" && trimmedParent !== defaultParent;

  const handlePick = async () => {
    const picked = await onPickParent();
    if (picked !== null) setParent(picked);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.clone.title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{busy ? ja.clone.running : ja.clone.title}</h2>

        <div className="modal__body">
          {busy ? (
            <>
              <p className="modal__lead">{ja.clone.runningInto(preview)}</p>
              <LoadProgress
                // git の見出しをそのまま出す。**翻訳されていることがある。**
                label={progress?.label ?? ja.clone.connecting}
                done={progress?.done ?? 0}
                total={progress?.total ?? null}
                // git が数えた実数なので「約」を付けない。
                estimated={false}
                elapsedMs={progress?.elapsedMs ?? 0}
              />
              {/* **サブモジュールごとに進捗が数え直される。** 何度も 0 に戻るのを
                  「止まった／やり直している」と読まれないように先に言う。 */}
              {submodules && <p className="modal__note">{ja.clone.submodulesProgressNote}</p>}
              <p className="modal__note">{ja.clone.cancelNote}</p>
            </>
          ) : outcome !== null ? (
            <CloneResult outcome={outcome} />
          ) : (
            <CloneForm
              url={url}
              parent={parent}
              folder={folder}
              preview={preview}
              submodules={submodules}
              remember={remember}
              canRemember={canRemember}
              hasDefaultParent={defaultParent !== null}
              onUrlChange={setUrl}
              onParentChange={setParent}
              onFolderChange={(value) => {
                setFolderEdited(true);
                setFolder(value);
              }}
              onSubmodulesChange={setSubmodules}
              onRememberChange={setRemember}
              onPick={() => void handlePick()}
            />
          )}
        </div>

        <div className="modal__actions">
          {busy ? (
            <button
              type="button"
              className="button"
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? ja.clone.cancelling : ja.clone.cancel}
            </button>
          ) : outcome !== null ? (
            <>
              <button type="button" className="button" onClick={onClose}>
                {ja.clone.close}
              </button>
              {/* **いちばんありそうな続きは「名前を変えてもう一度」。**
                  閉じてしまうと URL から入れ直しになる。 */}
              <button type="button" className="button button--primary" onClick={onBack}>
                {ja.clone.back}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button" onClick={onClose}>
                {ja.clone.dismiss}
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={!ready}
                onClick={() =>
                  onStart(
                    {
                      url: trimmedUrl,
                      parentDirectory: trimmedParent,
                      folderName: trimmedFolder,
                      recurseSubmodules: submodules,
                    },
                    canRemember && remember,
                  )
                }
              >
                {ja.clone.run}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CloneForm({
  url,
  parent,
  folder,
  preview,
  submodules,
  remember,
  canRemember,
  hasDefaultParent,
  onUrlChange,
  onParentChange,
  onFolderChange,
  onSubmodulesChange,
  onRememberChange,
  onPick,
}: {
  url: string;
  parent: string;
  folder: string;
  preview: string;
  submodules: boolean;
  remember: boolean;
  /** 既定と違う場所を指しているか。同じなら「覚える」に意味が無い。 */
  canRemember: boolean;
  hasDefaultParent: boolean;
  onUrlChange: (value: string) => void;
  onParentChange: (value: string) => void;
  onFolderChange: (value: string) => void;
  onSubmodulesChange: (value: boolean) => void;
  onRememberChange: (value: boolean) => void;
  onPick: () => void;
}) {
  return (
    <>
      <p className="modal__lead">{ja.clone.lead}</p>

      <label className="field">
        <span className="field__label">{ja.clone.urlLabel}</span>
        <input
          className="input"
          type="text"
          value={url}
          placeholder={ja.clone.urlPlaceholder}
          spellCheck={false}
          autoFocus
          onChange={(event) => onUrlChange(event.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">{ja.clone.parentLabel}</span>
        <span className="field__row">
          <input
            className="input"
            type="text"
            value={parent}
            placeholder={ja.clone.parentPlaceholder}
            spellCheck={false}
            onChange={(event) => onParentChange(event.target.value)}
          />
          <button type="button" className="button button--small" onClick={onPick}>
            {ja.clone.browse}
          </button>
        </span>
      </label>

      <label className="field">
        <span className="field__label">{ja.clone.folderLabel}</span>
        <input
          className="input"
          type="text"
          value={folder}
          placeholder={ja.clone.folderPlaceholder}
          spellCheck={false}
          onChange={(event) => onFolderChange(event.target.value)}
        />
      </label>

      {/* **どこに何ができるのかを 1 行で見せる。** 2 つの欄をどう繋ぐかは
          利用者が気にすることではない。 */}
      <p className="modal__note">
        {preview === "" ? ja.clone.previewEmpty : ja.clone.preview(preview)}
      </p>

      {/* **サブモジュールは既定 OFF**（CLAUDE.md §1）。黙って取り込まない。
          取り込むものの話が先で、アプリの設定の話は後。 */}
      <Check
        checked={submodules}
        label={ja.clone.submodules}
        note={ja.clone.submodulesNote}
        onChange={onSubmodulesChange}
      />

      {/* 保存先を毎回入力させないための逃げ道。設定画面は T-25 なので、
          いまはここが `workspaceRoot` を決められる唯一の場所。 */}
      {canRemember && (
        <Check
          checked={remember}
          label={ja.clone.rememberParent}
          note={hasDefaultParent ? ja.clone.rememberParentReplaces : undefined}
          onChange={onRememberChange}
        />
      )}

      {/* 認証ウィンドウが出る可能性を先に伝える。突然前面に出ると事故に見える。 */}
      <p className="modal__note">{ja.clone.authNote}</p>
      {/* 提供しないものを先に言う（CLAUDE.md §1）。 */}
      <p className="modal__note">{ja.clone.fullHistoryNote}</p>
    </>
  );
}

/**
 * 選択肢 1 つ。**ラベルの下に「何が起きるか」を添える。**
 *
 * チェックボックスの名前だけでは、押すと何が変わるのかが読めない
 * （T-18 の「FF マージ」と同じ失敗をしないため）。
 */
function Check({
  checked,
  label,
  note,
  onChange,
}: {
  checked: boolean;
  label: string;
  note?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="check">
      <label className="check__row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {note !== undefined && <p className="check__note">{note}</p>}
    </div>
  );
}

/** 失敗と中止の結果。**成功はここへ来ない**（呼び出し側が閉じて開く）。 */
function CloneResult({ outcome }: { outcome: CloneOutcome }) {
  return (
    <>
      <p className="modal__lead">{outcome.message}</p>
      {/* 消せなかった残骸は場所を出す。**黙って残さない。** */}
      {outcome.leftover !== null && (
        <p className="modal__blocker">{ja.clone.leftover(outcome.leftover)}</p>
      )}
      {outcome.lines.length > 0 && (
        <details className="fetchResults__detail">
          <summary>{ja.clone.details}</summary>
          <pre className="fetchResults__raw">{outcome.lines.join("\n")}</pre>
        </details>
      )}
    </>
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
