/**
 * AI レビューの接続先（T-20）。**入口はヘッダの「設定」ボタン 1 つ**で、
 * T-25 でこの中身をそのまま設定画面へ移す（画面をもう 1 枚作らない）。
 *
 * ここが守っていること:
 *
 * - **判定を書かない。** 出し分け・検証・整形は `lib/llmProfile.ts` の純関数が決める。
 *   `.tsx` に書いた条件にはテストが 1 つも当たらない（CLAUDE.md §8）
 * - **押せない選択肢を消さない。** 押せない理由といまの値を文言に出す（CLAUDE.md §6）
 * - **保存済みの API キーを読み出して表示しない。** 出すのは「預かっている」ことだけ
 * - **通信は保存済みのプロファイルだけ。** キーは Rust 側が資格情報マネージャーから
 *   読むので、平文のキーが通る経路は「保存」1 つで済む
 */
import { useEffect, useMemo, useState } from "react";

import { ja } from "../../i18n/ja";
import {
  deleteLlmProfile,
  isLlmError,
  listLlmModels,
  llmCredentialKeys,
  saveLlmProfile,
  testLlmConnection,
  type LlmError,
  type LlmProfile,
  type LlmTestOutcome,
} from "../../lib/ipc";
import { formatRawBody, headlineLines, SHORT_BODY_LINES } from "../../lib/llmMessage";
import {
  apiKeyUpdate,
  clearOption,
  DEFAULT_DRAFT,
  draftFromProfile,
  hasSavedKey,
  probeOption,
  profileFromDraft,
  validateProfile,
  type ApiKeyField,
  type ClearOption,
  type FieldProblem,
  type ProbeOption,
  type ProfileDraft,
  type ProfileField,
} from "../../lib/llmProfile";

/** 編集中の対象。`null` は一覧を見ているだけ、`profile === null` は新規。 */
type Editing = { profile: LlmProfile | null };

export function LlmProfilesDialog({
  profiles,
  onClose,
  onChanged,
}: {
  profiles: LlmProfile[];
  onClose: () => void;
  /** 保存・削除のあとに設定を読み直させる。 */
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [credentialKeys, setCredentialKeys] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const refreshKeys = async () => {
    try {
      setCredentialKeys(await llmCredentialKeys());
    } catch (error) {
      // キーの有無が読めなくても一覧は成立する。**「キーなし」に倒す。**
      setCredentialKeys([]);
      setFailure(messageOf(error));
    }
  };

  useEffect(() => {
    void refreshKeys();
  }, []);

  useEscape(onClose);

  const afterChange = async () => {
    await onChanged();
    await refreshKeys();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.llm.title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{ja.llm.title}</h2>

        <div className="modal__body">
          <p className="modal__lead">{ja.llm.lead}</p>
          {failure !== null && <p className="modal__blocker">{failure}</p>}

          {editing === null ? (
            <ProfileList
              profiles={profiles}
              credentialKeys={credentialKeys}
              onEdit={(profile) => setEditing({ profile })}
              onRemove={async (profile) => {
                try {
                  await deleteLlmProfile(profile.id);
                  setFailure(null);
                  await afterChange();
                } catch (error) {
                  setFailure(messageOf(error));
                }
              }}
            />
          ) : (
            <ProfileEditor
              existing={editing.profile}
              hasKey={
                editing.profile !== null && hasSavedKey(editing.profile, credentialKeys)
              }
              onSaved={async (saved) => {
                setFailure(null);
                await afterChange();
                // **保存したら編集を続けられる状態にする。** 新規はここで id が付き、
                // 「つながるか試す」が押せるようになる。
                setEditing({ profile: saved });
              }}
              onFailed={setFailure}
              onDone={() => setEditing(null)}
            />
          )}
        </div>

        <div className="modal__actions">
          {editing === null && (
            <button
              type="button"
              className="button"
              onClick={() => setEditing({ profile: null })}
            >
              {ja.llm.add}
            </button>
          )}
          <button type="button" className="button button--primary" onClick={onClose}>
            {ja.llm.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileList({
  profiles,
  credentialKeys,
  onEdit,
  onRemove,
}: {
  profiles: LlmProfile[];
  credentialKeys: string[];
  onEdit: (profile: LlmProfile) => void;
  onRemove: (profile: LlmProfile) => Promise<void>;
}) {
  // 削除は 2 段構え。**資格情報も消える**ので、1 クリックでは消さない。
  const [confirming, setConfirming] = useState<string | null>(null);

  if (profiles.length === 0) {
    return <p className="modal__note">{ja.llm.empty}</p>;
  }

  return (
    <ul className="llmList">
      {profiles.map((profile) => (
        <li className="llmList__row" key={profile.id}>
          <span className="llmList__name">{profile.name}</span>
          <span className="badge">
            {hasSavedKey(profile, credentialKeys)
              ? ja.llm.keyBadgeSaved
              : ja.llm.keyBadgeNone}
          </span>
          <span className="llmList__where">
            {profile.baseUrl} / {profile.model}
          </span>
          <span className="llmList__actions">
            <button
              type="button"
              className="button button--small"
              onClick={() => onEdit(profile)}
            >
              {ja.llm.edit}
            </button>
            <button
              type="button"
              className="button button--small"
              onClick={() => setConfirming(profile.id)}
            >
              {ja.llm.remove}
            </button>
          </span>
          {confirming === profile.id && (
            <span className="llmList__confirm">
              {/* **何が一緒に消えるかを先に言う。** */}
              <span>{ja.llm.removeConfirm(profile.name)}</span>
              <button
                type="button"
                className="button button--small"
                onClick={() => setConfirming(null)}
              >
                {ja.llm.cancel}
              </button>
              <button
                type="button"
                className="button button--small button--primary"
                onClick={() => {
                  setConfirming(null);
                  void onRemove(profile);
                }}
              >
                {ja.llm.remove}
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProfileEditor({
  existing,
  hasKey,
  onSaved,
  onFailed,
  onDone,
}: {
  existing: LlmProfile | null;
  hasKey: boolean;
  onSaved: (saved: LlmProfile) => Promise<void>;
  onFailed: (message: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    existing === null ? DEFAULT_DRAFT : draftFromProfile(existing),
  );
  const [apiKey, setApiKey] = useState<ApiKeyField>({ value: "", clear: false });
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState<"models" | "test" | null>(null);
  const [test, setTest] = useState<LlmTestOutcome | null>(null);
  const [probeError, setProbeError] = useState<LlmError | null>(null);
  const [saved, setSavedNote] = useState<string | null>(null);

  // **編集対象が変わったら下書きを入れ直す。** 保存で `existing` が差し替わるので、
  // 保存後は「保存済みと同じ」状態に戻り、「つながるか試す」が押せるようになる。
  useEffect(() => {
    setDraft(existing === null ? DEFAULT_DRAFT : draftFromProfile(existing));
    setApiKey({ value: "", clear: false });
  }, [existing]);

  const validation = useMemo(() => validateProfile(draft), [draft]);
  const probe = probeOption(draft, existing);
  const clear = clearOption(apiKey, hasKey);

  const set = (field: ProfileField) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const handleSave = async () => {
    const profile = profileFromDraft(draft, existing);
    if (profile === null) return;
    setSaving(true);
    try {
      // **押せない状態のチェックは無視される**（`apiKeyUpdate` が判定する）。
      const stored = await saveLlmProfile(profile, apiKeyUpdate(apiKey, hasKey));
      setSavedNote(ja.llm.savedAt(stored.name));
      setProbeError(null);
      await onSaved(stored);
    } catch (error) {
      onFailed(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async (kind: "models" | "test") => {
    if (!probe.enabled || existing === null) return;
    setProbing(kind);
    setProbeError(null);
    // **前回の結果を残さない。** 成功の 1 行の下に新しい失敗が出ると、
    // どちらがいまの結果なのか読めない（2026-09-05 の目視で実際にそうなった）。
    setTest(null);
    try {
      if (kind === "models") {
        const list = await listLlmModels(existing.id);
        setModels(list.models);
      } else {
        setTest(await testLlmConnection(existing.id));
      }
    } catch (error) {
      if (isLlmError(error)) setProbeError(error);
      else onFailed(messageOf(error));
    } finally {
      setProbing(null);
    }
  };

  return (
    <>
      <Field
        name="name"
        label={ja.llm.nameLabel}
        placeholder={ja.llm.namePlaceholder}
        value={draft.name}
        problem={validation.problems.name}
        autoFocus
        onChange={set("name")}
      />

      <Field
        name="baseUrl"
        label={ja.llm.baseUrlLabel}
        placeholder={ja.llm.baseUrlPlaceholder}
        value={draft.baseUrl}
        problem={validation.problems.baseUrl}
        note={ja.llm.baseUrlNote}
        onChange={set("baseUrl")}
      />

      <Field
        name="model"
        label={ja.llm.modelLabel}
        placeholder={ja.llm.modelPlaceholder}
        value={draft.model}
        problem={validation.problems.model}
        list={models === null || models.length === 0 ? undefined : "llmModels"}
        onChange={set("model")}
      />
      {/* **取得できなくても手入力できる。** `/models` を持たないサーバがある。 */}
      {models !== null && models.length > 0 && (
        <datalist id="llmModels">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}

      <Field
        name="contextWindow"
        label={ja.llm.contextWindowLabel}
        value={draft.contextWindow}
        problem={validation.problems.contextWindow}
        note={ja.llm.contextWindowNote}
        onChange={set("contextWindow")}
      />
      <Field
        name="temperature"
        label={ja.llm.temperatureLabel}
        value={draft.temperature}
        problem={validation.problems.temperature}
        onChange={set("temperature")}
      />
      <Field
        name="maxTokens"
        label={ja.llm.maxTokensLabel}
        value={draft.maxTokens}
        problem={validation.problems.maxTokens}
        onChange={set("maxTokens")}
      />

      {/* **既存のキーは読み出さない。** 出すのは預かっているかどうかだけ。 */}
      <label className="field">
        <span className="field__label">{ja.llm.apiKeyLabel}</span>
        <input
          className="input"
          type="password"
          value={apiKey.value}
          placeholder={
            hasKey ? ja.llm.apiKeyPlaceholderSaved : ja.llm.apiKeyPlaceholderEmpty
          }
          spellCheck={false}
          autoComplete="off"
          onChange={(event) =>
            setApiKey((current) => ({ ...current, value: event.target.value }))
          }
        />
      </label>
      <p className="modal__note">
        {apiKey.value !== ""
          ? ja.llm.apiKeyReplaceNote
          : hasKey
            ? ja.llm.apiKeySaved
            : ja.llm.apiKeyNone}
      </p>

      {/* **押せないときも消さない。** 消すと、キーを預かっているのかどうかが
          画面から読めなくなる（T-19 の目視で報告された形）。 */}
      <Check
        checked={clear.enabled && apiKey.clear}
        disabled={!clear.enabled}
        label={ja.llm.apiKeyClear}
        note={clearNote(clear)}
        onChange={(value) => setApiKey((current) => ({ ...current, clear: value }))}
      />

      <div className="llmEditor__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!validation.ok || saving}
          onClick={() => void handleSave()}
        >
          {saving ? ja.llm.saving : ja.llm.save}
        </button>
        <button
          type="button"
          className="button"
          disabled={!probe.enabled || probing !== null}
          onClick={() => void runProbe("models")}
        >
          {probing === "models" ? ja.llm.fetchingModels : ja.llm.fetchModels}
        </button>
        <button
          type="button"
          className="button"
          disabled={!probe.enabled || probing !== null}
          onClick={() => void runProbe("test")}
        >
          {probing === "test" ? ja.llm.testing : ja.llm.test}
        </button>
        <button type="button" className="button" onClick={onDone}>
          {ja.llm.close}
        </button>
      </div>

      {/* **押せない理由を必ず出す。** ボタンを消さない代わりにここで説明する。 */}
      <p className="modal__note">{probeNote(probe)}</p>
      {saved !== null && <p className="modal__note">{saved}</p>}

      {models !== null && (
        <p className="modal__note">
          {models.length === 0 ? ja.llm.modelsEmpty : ja.llm.modelsFound(models.length)}
        </p>
      )}

      {test !== null && (
        <div>
          <p className="modal__lead">{ja.llm.testOk(test.model, test.elapsedMs)}</p>
          {test.reply !== "" && (
            <p className="modal__note">{ja.llm.testReply(test.reply)}</p>
          )}
          <Raw text={test.raw} />
        </div>
      )}

      {probeError !== null && (
        <div>
          {/* 人間向けの 1 行 ＋ 展開で生の応答（fetch / clone と同じ形）。
              **アプリの説明とサーバの言い分を別の行にする** — 地続きに見えると
              どちらが言っているのか読めない。 */}
          <div className="modal__blocker">
            {headlineLines(probeError.message).map((line, index) => (
              // 行の中身は重複しうる（同じ文が 2 度出る形の応答がある）ので
              // 添字を鍵にする。並べ替えも増減もしない固定の 1〜2 行。
              // eslint-disable-next-line react/no-array-index-key
              <p className="llmHeadline__line" key={index}>
                {line}
              </p>
            ))}
          </div>
          <p className="modal__note">{ja.llm.failureHint[probeError.kind]}</p>
          {/* **失敗のときは開いた状態で出す。** 原因はほぼ生の応答の中にある
              （利用者の指摘。2026-09-05）。 */}
          <Raw text={probeError.detail} defaultOpen />
        </div>
      )}
    </>
  );
}

/**
 * 生の応答。**空なら出さない**（開いても何も無い `details` を置かない）。
 *
 * 整形の判断は純関数（`lib/llmMessage.ts`）。ここでは出し方だけを決める。
 */
function Raw({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const body = formatRawBody(text);
  if (body.text === "") return null;

  // 短いものは折りたたむ意味が無いので最初から開く。
  const open = defaultOpen || body.lines <= SHORT_BODY_LINES;
  return (
    <details className="fetchResults__detail" open={open}>
      <summary>{body.kind === "json" ? ja.llm.detailsJson : ja.llm.details}</summary>
      <pre className="llmRaw">{body.text}</pre>
    </details>
  );
}

function Field({
  name,
  label,
  value,
  placeholder,
  note,
  problem,
  list,
  autoFocus = false,
  onChange,
}: {
  /** `id` の素。**ラベル文字列から作らないこと** — 空白を含む文言があり、
      空白入りの `id` はラベルと結び付かない。 */
  name: ProfileField;
  label: string;
  value: string;
  placeholder?: string;
  note?: string;
  /** 入力が通らない理由。**欄のすぐ下に出す。** */
  problem: FieldProblem | null;
  list?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={`llm-${name}`}>
        {label}
      </label>
      <input
        id={`llm-${name}`}
        className="input"
        type="text"
        value={value}
        placeholder={placeholder}
        list={list}
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== null ? (
        <p className="field__problem">{ja.llm.problem[problem]}</p>
      ) : (
        note !== undefined && <p className="check__note">{note}</p>
      )}
    </div>
  );
}

/**
 * 選択肢 1 つ。**ラベルの下に「何が起きるか」を添える**（`CloneDialog` と同じ形）。
 */
function Check({
  checked,
  disabled = false,
  label,
  note,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  note?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={`check${disabled ? " check--disabled" : ""}`}>
      <label className="check__row">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {note !== undefined && <p className="check__note">{note}</p>}
    </div>
  );
}

function clearNote(option: ClearOption): string {
  switch (option.kind) {
    case "noKey":
      return ja.llm.apiKeyClearNoKey;
    case "typed":
      return ja.llm.apiKeyClearTyped;
    case "ready":
      return ja.llm.apiKeyClearReady;
  }
}

function probeNote(option: ProbeOption): string {
  return ja.llm.probeNote[option.kind];
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (isLlmError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** `Esc` で閉じる（`CloneDialog` と同じ）。 */
function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);
}
