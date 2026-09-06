/**
 * リポジトリ 1 つぶんの設定（T-21）。**リポジトリ一覧の右クリックから開く。**
 *
 * ここに置く理由は 1 つで、**リポジトリに紐づくものをアプリ全体の「設定」に混ぜると、
 * どのリポジトリの話をしているのか読めなくなる**（2026-09-05 に利用者の指摘）。
 * アプリ全体の設定に残るのは、内蔵とグローバル（自分で置いたもの）だけ。
 *
 * 中身は**レビュー観点**と**既定の接続先**（T-25 で足した）。
 * 可視 ref はブランチツリーのチェックボックスがそのまま設定なので、ここへは出さない
 * （同じものを 2 か所から変えられるようにしない）。
 */
import { useEffect, useState } from "react";

import { ja } from "../../i18n/ja";
import { useEscape } from "../../hooks/useEscape";
import {
  loadSkills,
  setRepositoryLlmProfile,
  type LlmProfile,
  type SkillCatalog,
} from "../../lib/ipc";
import { defaultProfileView } from "../../lib/llmProfile";
import { skillsFrom } from "../../lib/skillTrust";
import { SkillList } from "./SkillList";

export function RepositorySettingsDialog({
  repositoryId,
  repositoryName,
  profiles,
  defaultProfileId,
  onProfileChanged,
  onClose,
}: {
  repositoryId: string;
  /** 見出しに出す。**どのリポジトリの話かを画面から読めるようにする。** */
  repositoryName: string;
  /** 選べる接続先。**0 件でも欄は消さない**（理由を出す。CLAUDE.md §6）。 */
  profiles: LlmProfile[];
  /** このリポジトリで覚えている既定。まだ決めていなければ `null`。 */
  defaultProfileId: string | null;
  /** 変えたら設定を読み直させる。 */
  onProfileChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setCatalog(await loadSkills(repositoryId));
      } catch (error) {
        setCatalog(null);
        setFailure(typeof error === "string" ? error : String(error));
      }
    })();
  }, [repositoryId]);

  useEscape(onClose);

  const entries = catalog === null ? [] : skillsFrom(catalog.entries, ["repository"]);
  const view = defaultProfileView(profiles, defaultProfileId);

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={ja.repositorySettings.title(repositoryName)}
    >
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{ja.repositorySettings.title(repositoryName)}</h2>

        <div className="modal__body">
          {failure !== null && <p className="modal__blocker">{failure}</p>}

          {/* **既定の接続先（T-23 で覚えるようにしたもの）をここで見せる。**
              覚えているのに画面から読めないと、勝手に変わっているようにしか
              見えない（CLAUDE.md §6）。出し分けは純関数（`lib/llmProfile.ts`）。 */}
          <h3 className="modal__title">{ja.repositorySettings.profile}</h3>
          <p className="modal__lead">{ja.repositorySettings.profileLead}</p>
          <select
            className="select"
            value={view.selected}
            disabled={view.noProfiles}
            onChange={(event) => {
              const value = event.target.value;
              void (async () => {
                try {
                  await setRepositoryLlmProfile(repositoryId, value === "" ? null : value);
                  await onProfileChanged();
                } catch (error) {
                  setFailure(typeof error === "string" ? error : String(error));
                }
              })();
            }}
          >
            <option value="">{ja.repositorySettings.profileNone}</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          {/* **押せないときも消さず、理由といまの値を出す。** */}
          {view.noProfiles && <p className="modal__note">{ja.repositorySettings.profileEmpty}</p>}
          {view.missing && <p className="modal__note">{ja.repositorySettings.profileMissing}</p>}

          <h3 className="modal__title">{ja.skills.tab}</h3>
          <p className="modal__lead">{ja.repositorySettings.skillsLead}</p>
          {/* **なぜ既定で使わないのかを先に書く。** 手間の理由が読めないと、
              「とりあえず押す」ボタンになる。 */}
          <p className="modal__note">{ja.skills.trustWhy}</p>

          {catalog !== null && (
            <SkillList
              entries={entries}
              repositoryId={repositoryId}
              emptyNote={ja.repositorySettings.noSkills}
              onChanged={setCatalog}
              onFailed={setFailure}
            />
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            {ja.skills.close}
          </button>
        </div>
      </div>
    </div>
  );
}
