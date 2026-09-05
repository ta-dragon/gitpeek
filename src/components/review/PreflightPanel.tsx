/**
 * 実行前パネル（T-23。DESIGN.md §10.4）。**必ず出す。**
 *
 * **判定はここに書かない。** 押せるかどうかも、何と書くかも
 * `src/lib/reviewPlan.ts` の純関数が決める（CLAUDE.md §8）。
 *
 * **押せない選択肢を画面から消さない**（CLAUDE.md §6）。実行ボタンは
 * 押せないときも残し、理由をすぐ下に出す。
 */
import { ja } from "../../i18n/ja";
import type { LlmProfile, ReviewPlan } from "../../lib/ipc";
import {
  fileNote,
  planCounts,
  runGate,
  selectable,
  selectedTokens,
} from "../../lib/reviewPlan";

export function PreflightPanel({
  plan,
  planError,
  loading,
  profiles,
  profileId,
  selected,
  running,
  onProfileChange,
  onSelectedChange,
  onRun,
}: {
  plan: ReviewPlan | null;
  planError: string | null;
  loading: boolean;
  profiles: LlmProfile[];
  profileId: string | null;
  selected: string[];
  running: boolean;
  onProfileChange: (id: string | null) => void;
  onSelectedChange: (paths: string[]) => void;
  onRun: () => void;
}) {
  const gate = runGate(plan, profiles, selected, { running });
  const counts = planCounts(plan);
  const tokens = selectedTokens(plan, selected);
  const sendable = plan === null ? [] : plan.files.filter(selectable);

  const toggle = (path: string) => {
    onSelectedChange(
      selected.includes(path) ? selected.filter((it) => it !== path) : [...selected, path],
    );
  };

  return (
    <div className="review__panel">
      <p className="review__lead">{ja.review.plan.lead}</p>

      <label className="review__field">
        <span className="review__label">{ja.review.profile}</span>
        <select
          className="review__select"
          value={profileId ?? ""}
          onChange={(event) => onProfileChange(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">{ja.review.profilePlaceholder}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}（{profile.model}）
            </option>
          ))}
        </select>
      </label>
      {/* **接続先が無くても欄は消さない。** 何が足りないのかを出す。 */}
      {profiles.length === 0 && <p className="review__note">{ja.review.noProfiles}</p>}

      <div className="review__skills">
        <span className="review__label">{ja.review.skillsUsed}</span>
        {plan === null || plan.skills.length === 0 ? (
          <span className="review__note">{ja.review.noSkills}</span>
        ) : (
          <span>{plan.skills.map((skill) => skill.name).join(", ")}</span>
        )}
      </div>

      {planError !== null && <p className="review__error">{planError}</p>}
      {loading && <p className="review__note">{ja.review.gate.noPlan}</p>}

      {plan !== null && (
        <>
          <div className="review__counts">
            <span>{ja.review.plan.counts(counts.sending, counts.skipped)}</span>
            <span>{ja.review.plan.tokens(tokens)}</span>
          </div>

          <div className="review__bulk">
            <button
              type="button"
              className="button button--small"
              onClick={() => onSelectedChange(sendable.map((file) => file.path))}
            >
              {ja.review.plan.selectAll}
            </button>
            <button
              type="button"
              className="button button--small"
              onClick={() => onSelectedChange([])}
            >
              {ja.review.plan.selectNone}
            </button>
          </div>

          <ul className="review__files">
            {plan.files.length === 0 && <li className="review__note">{ja.review.plan.empty}</li>}
            {plan.files.map((file) => {
              const note = fileNote(file);
              const can = selectable(file);
              return (
                <li
                  key={file.path}
                  className={can ? "review__file" : "review__file review__file--skipped"}
                >
                  <label className="review__file-label">
                    <input
                      type="checkbox"
                      checked={can && selected.includes(file.path)}
                      // **送らないファイルは操作させないが、一覧からは消さない。**
                      disabled={!can}
                      onChange={() => toggle(file.path)}
                    />
                    <span className="review__file-path">{file.path}</span>
                  </label>
                  {note !== null && <span className="review__file-note">{note}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="review__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!gate.enabled || profileId === null}
          onClick={onRun}
        >
          {ja.review.run}
        </button>
      </div>
      {/* **押せない理由をボタンのすぐ下に出す。** 押せる条件でだけ出さない。 */}
      {gate.reason !== null && <p className="review__blocker">{gate.reason}</p>}
      {gate.enabled && profileId === null && (
        <p className="review__blocker">{ja.review.gate.noProfileChosen}</p>
      )}
    </div>
  );
}
