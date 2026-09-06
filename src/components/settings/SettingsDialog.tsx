/**
 * アプリ全体の設定（T-25。docs/DESIGN.md §6.5, §12.2）。
 *
 * **入口はここ 1 つに畳んである**（2026-09-06 に利用者が決めた）。テーマの選択も
 * 接続先の一覧もヘッダから移した — 入口が 3 つあると、どこで何が変えられるのか
 * 読めなくなる。
 *
 * **リポジトリ 1 つぶんの設定はここに出さない**（CLAUDE.md §6）。どのリポジトリの
 * 話をしているのか読めなくなるので、リポジトリ一覧の右クリックから開く。
 *
 * **判定と検証は純関数**（`lib/settingsForm.ts` / `lib/shortcuts.ts`）。
 * `.tsx` に書いた条件にはテストが 1 つも当たらない（CLAUDE.md §8）。
 */
import { useEffect, useState } from "react";

import { ja } from "../../i18n/ja";
import { useEscape } from "../../hooks/useEscape";
import {
  detectGit,
  isGitUsable,
  openLogFolder,
  type GitStatus,
  type LogStatus,
  type Settings,
} from "../../lib/ipc";
import { logHint } from "../../lib/crashNotice";
import { readNumber, showNumber, type NumberFieldName } from "../../lib/settingsForm";
import { SHORTCUTS } from "../../lib/shortcuts";
import { GlobalSkillsPanel, LlmProfilesPanel } from "./LlmProfiles";

type Tab = "general" | "view" | "diff" | "fetch" | "review" | "skills" | "keys" | "logs";

const TABS: Tab[] = ["general", "view", "diff", "fetch", "review", "skills", "keys", "logs"];

export function SettingsDialog({
  settings,
  globalSkillDir,
  log,
  onChange,
  onChanged,
  onGitChecked,
  onClose,
}: {
  settings: Settings;
  /** グローバル skill の置き場所（`%APPDATA%\...\skills`）。文言に出す。 */
  globalSkillDir: string;
  /** ログの置き場所と、書けているか（T-24）。 */
  log: LogStatus | null;
  /** 設定を 1 つ変える。**保存はここを受けた側が行う。** */
  onChange: (change: (current: Settings) => Settings) => void;
  /** 接続先や観点を変えたあとに読み直させる。 */
  onChanged: () => Promise<void>;
  /**
   * git のパスを確かめ直した結果。
   *
   * **画面全体の判定にも効かせる**ため上へ渡す。ここだけで持つと、
   * 使えないパスを入れても本体は「使える」ままになる。
   */
  onGitChecked: (status: GitStatus) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("general");
  useEscape(onClose);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.settings.title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{ja.settings.title}</h2>

        {/* **押せないタブは作らない**が、どこに何があるかは常に見えるようにする。 */}
        <div className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              className={`tabs__tab${tab === name ? " tabs__tab--active" : ""}`}
              onClick={() => setTab(name)}
            >
              {ja.settings.tabs[name]}
            </button>
          ))}
        </div>

        <div className="modal__body">
          {tab === "general" && (
            <GeneralTab settings={settings} onChange={onChange} onGitChecked={onGitChecked} />
          )}
          {tab === "view" && <ViewTab settings={settings} onChange={onChange} />}
          {tab === "diff" && <DiffTab settings={settings} onChange={onChange} />}
          {tab === "fetch" && <FetchTab settings={settings} onChange={onChange} />}
          {tab === "review" && (
            <>
              <ReviewNumbers settings={settings} onChange={onChange} />
              <LlmProfilesPanel profiles={settings.llmProfiles} onChanged={onChanged} />
            </>
          )}
          {tab === "skills" && <GlobalSkillsPanel globalSkillDir={globalSkillDir} />}
          {tab === "keys" && <KeysTab />}
          {tab === "logs" && <LogsTab log={log} />}
        </div>

        <div className="modal__actions">
          <p className="settings__scope">{ja.settings.repositoryElsewhere}</p>
          <button type="button" className="button button--primary" onClick={onClose}>
            {ja.settings.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 数値の欄。**打っている間は保存しない**（不正な値のまま保存されないように）。
 *
 * 判定は純関数（`lib/settingsForm.ts`）。**理由が出ても欄は消さない**
 * （CLAUDE.md §6）。
 */
function NumberRow({
  name,
  label,
  value,
  note,
  onCommit,
}: {
  name: NumberFieldName;
  label: string;
  value: number;
  note?: string;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(showNumber(value));
  // 外から変わったら追従する（別の場所で同じ設定を変えたとき）。
  useEffect(() => setText(showNumber(value)), [value]);

  const result = readNumber(name, text);
  const commit = () => {
    if (result.reason === null) onCommit(result.value);
  };

  return (
    <label className="settings__row">
      <span className="settings__label">{label}</span>
      <input
        className="input"
        value={text}
        inputMode="numeric"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {result.reason !== null ? (
        <span className="settings__error">{result.reason}</span>
      ) : (
        note !== undefined && <span className="settings__note">{note}</span>
      )}
    </label>
  );
}

function ChoiceRow<T extends string>({
  label,
  value,
  choices,
  note,
  onChange,
}: {
  label: string;
  value: T;
  choices: { value: T; label: string }[];
  note?: string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="settings__row">
      <span className="settings__label">{label}</span>
      <select
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      {note !== undefined && <span className="settings__note">{note}</span>}
    </label>
  );
}

/**
 * 真偽値の欄。**`note` はラベルの下に 1 行**（CLAUDE.md §6 —
 * チェックボックスは「入れると何が起きるか」を添える）。
 * 入れたときと外したときで文言が変わる欄があるので、**出し分けは呼ぶ側**が決める。
 */
function CheckRow({
  label,
  checked,
  note,
  onChange,
}: {
  label: string;
  checked: boolean;
  note?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings__row settings__row--check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings__label">{label}</span>
      {note !== undefined && <span className="settings__note">{note}</span>}
    </label>
  );
}

type TabProps = {
  settings: Settings;
  onChange: (change: (current: Settings) => Settings) => void;
};

/** git のパスと clone の保存先。**パスを変えたらその場で確認し直す。** */
function GeneralTab({
  settings,
  onChange,
  onGitChecked,
}: TabProps & { onGitChecked: (status: GitStatus) => void }) {
  const [path, setPath] = useState(settings.git.path ?? "");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async (value: string) => {
    const trimmed = value.trim();
    onChange((current) => ({ ...current, git: { ...current.git, path: trimmed === "" ? null : trimmed } }));
    setChecking(true);
    try {
      const checked = await detectGit(trimmed === "" ? undefined : trimmed);
      setStatus(checked);
      onGitChecked(checked);
    } catch {
      // **保存だけして「効いていない」状態を作らない。** 読めなければ何も出さない。
      setStatus(null);
    } finally {
      setChecking(false);
    }
  };

  const root = settings.workspaceRoot ?? "";
  return (
    <>
      <label className="settings__row">
        <span className="settings__label">{ja.settings.gitPath}</span>
        <input
          className="input"
          value={path}
          placeholder={ja.setup.pathPlaceholder}
          onChange={(event) => setPath(event.target.value)}
          onBlur={() => void check(path)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void check(path);
          }}
        />
        <span className="settings__note">{ja.settings.gitPathNote}</span>
        {checking ? (
          <span className="settings__note">{ja.settings.gitPathChecking}</span>
        ) : (
          status !== null &&
          (isGitUsable(status) ? (
            <span className="settings__note">
              {ja.settings.gitPathOk(status.version ?? "", status.path)}
            </span>
          ) : (
            <span className="settings__error">
              {ja.settings.gitPathNg(status.error ?? "")}
            </span>
          ))
        )}
      </label>

      <label className="settings__row">
        <span className="settings__label">{ja.settings.workspaceRoot}</span>
        <input
          className="input"
          value={root}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              workspaceRoot: event.target.value.trim() === "" ? null : event.target.value,
            }))
          }
        />
        <span className="settings__note">
          {root === "" ? ja.settings.workspaceRootEmpty : ja.settings.workspaceRootNote}
        </span>
      </label>

      {/* **コマンドログの出し入れはここだけ**（T-25。2026-09-06 に利用者が決めた）。
          ヘッダのボタンは畳んだので、**外したときに戻し方を書く** — 戻る道が
          読めないと、消えたようにしか見えない（CLAUDE.md §6）。 */}
      <CheckRow
        label={ja.settings.showCommandLog}
        checked={settings.ui.showCommandLog}
        note={
          settings.ui.showCommandLog
            ? ja.settings.showCommandLogOn
            : ja.settings.showCommandLogOff
        }
        onChange={(showCommandLog) =>
          onChange((current) => ({ ...current, ui: { ...current.ui, showCommandLog } }))
        }
      />
    </>
  );
}

function ViewTab({ settings, onChange }: TabProps) {
  const ui = settings.ui;
  const set = (change: Partial<Settings["ui"]>) =>
    onChange((current) => ({ ...current, ui: { ...current.ui, ...change } }));

  return (
    <>
      <ChoiceRow
        label={ja.theme.label}
        value={ui.theme}
        choices={[
          { value: "system", label: ja.theme.system },
          { value: "light", label: ja.theme.light },
          { value: "dark", label: ja.theme.dark },
        ]}
        onChange={(theme) => set({ theme })}
      />
      <ChoiceRow
        label={ja.settings.dateFormat}
        value={ui.dateFormat}
        choices={[
          { value: "relative", label: ja.settings.dateRelative },
          { value: "absolute", label: ja.settings.dateAbsolute },
        ]}
        onChange={(dateFormat) => set({ dateFormat })}
      />
      <ChoiceRow
        label={ja.settings.commitOrder}
        value={ui.commitOrder}
        choices={[
          { value: "topo", label: ja.settings.orderTopo },
          { value: "date", label: ja.settings.orderDate },
        ]}
        onChange={(commitOrder) => set({ commitOrder })}
      />
    </>
  );
}

function DiffTab({ settings, onChange }: TabProps) {
  const ui = settings.ui;
  const set = (change: Partial<Settings["ui"]>) =>
    onChange((current) => ({ ...current, ui: { ...current.ui, ...change } }));

  return (
    <>
      <ChoiceRow
        label={ja.settings.diffLayout}
        value={ui.diffLayout}
        choices={[
          { value: "side-by-side", label: ja.settings.layoutSideBySide },
          { value: "unified", label: ja.settings.layoutUnified },
        ]}
        onChange={(diffLayout) => set({ diffLayout })}
      />
      <NumberRow
        name="contextLines"
        label={ja.settings.contextLines}
        value={ui.contextLines}
        onCommit={(contextLines) => set({ contextLines })}
      />
      <CheckRow
        label={ja.settings.ignoreWhitespace}
        checked={ui.ignoreWhitespace}
        onChange={(ignoreWhitespace) => set({ ignoreWhitespace })}
      />
      <CheckRow
        label={ja.settings.showLineEndings}
        checked={ui.showLineEndings}
        onChange={(showLineEndings) => set({ showLineEndings })}
      />
      <NumberRow
        name="collapseLines"
        label={ja.settings.collapseLines}
        value={ui.collapseLines}
        note={ja.settings.collapseNote}
        onCommit={(collapseLines) => set({ collapseLines })}
      />
      <NumberRow
        name="collapseBytes"
        label={ja.settings.collapseBytes}
        value={ui.collapseBytes}
        onCommit={(collapseBytes) => set({ collapseBytes })}
      />
    </>
  );
}

function FetchTab({ settings, onChange }: TabProps) {
  return (
    <NumberRow
      name="staleWarningDays"
      label={ja.settings.staleWarningDays}
      value={settings.fetch.staleWarningDays}
      note={ja.settings.staleWarningNote(settings.fetch.staleWarningDays)}
      onCommit={(staleWarningDays) =>
        onChange((current) => ({ ...current, fetch: { ...current.fetch, staleWarningDays } }))
      }
    />
  );
}

function ReviewNumbers({ settings, onChange }: TabProps) {
  const set = (change: Partial<Settings["review"]>) =>
    onChange((current) => ({ ...current, review: { ...current.review, ...change } }));

  return (
    <>
      <NumberRow
        name="reviewConcurrency"
        label={ja.settings.reviewConcurrency}
        value={settings.review.concurrency}
        note={ja.settings.reviewConcurrencyNote}
        onCommit={(concurrency) => set({ concurrency })}
      />
      <NumberRow
        name="reviewContextLines"
        label={ja.settings.reviewContextLines}
        value={settings.review.contextLines}
        onCommit={(contextLines) => set({ contextLines })}
      />
    </>
  );
}

/** ショートカットの一覧。**対応表から作る**ので、実際のキーとずれない。 */
function KeysTab() {
  return (
    <ul className="settings__keys">
      {SHORTCUTS.map((binding) => (
        <li key={`${binding.action}`} className="settings__key">
          <kbd className="settings__kbd">{binding.label}</kbd>
          <span>{ja.shortcuts[binding.action]}</span>
        </li>
      ))}
    </ul>
  );
}

/** ログの置き場所（T-24）。**書けていないときは理由を出す。** */
function LogsTab({ log }: { log: LogStatus | null }) {
  const hint = logHint(log);
  return (
    <>
      <p className="modal__lead">{ja.settings.logsNote}</p>
      <p className="settings__row">
        <span className="settings__label">{ja.settings.logsWhere}</span>
        <span className="settings__note">{hint.text}</span>
      </p>
      <div className="settings__actions">
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
    </>
  );
}
