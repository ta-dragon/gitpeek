/**
 * リポジトリ 1 つぶんの設定（T-21）。**リポジトリ一覧の右クリックから開く。**
 *
 * ここに置く理由は 1 つで、**リポジトリに紐づくものをアプリ全体の「設定」に混ぜると、
 * どのリポジトリの話をしているのか読めなくなる**（2026-09-05 に利用者の指摘）。
 * アプリ全体の設定に残るのは、内蔵とグローバル（自分で置いたもの）だけ。
 *
 * いまの中身はレビュー観点だけ。T-25 でここへ他のリポジトリ設定も集める。
 */
import { useEffect, useState } from "react";

import { ja } from "../../i18n/ja";
import { loadSkills, type SkillCatalog } from "../../lib/ipc";
import { skillsFrom } from "../../lib/skillTrust";
import { SkillList } from "./SkillList";

export function RepositorySettingsDialog({
  repositoryId,
  repositoryName,
  onClose,
}: {
  repositoryId: string;
  /** 見出しに出す。**どのリポジトリの話かを画面から読めるようにする。** */
  repositoryName: string;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const entries = catalog === null ? [] : skillsFrom(catalog.entries, ["repository"]);

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
