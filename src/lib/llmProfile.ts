/**
 * LLM プロファイルの入力検証と出し分け（T-20）。**純関数だけ**。
 *
 * ここに置く理由は 1 つで、**`.tsx` に書いた判定にはテストが 1 つも当たらない**から
 * （CLAUDE.md §8）。clone の「この保存先を次回から既定にする」は直書きしたせいで、
 * 条件が常に成立せず**一度も表示されないまま**受け入れ条件を全部通した。
 *
 * **文言はここに書かない。** 返すのは「どういう状態か」だけで、
 * 日本語は `i18n/ja.ts` が持つ（CLAUDE.md §6）。
 */
import type { ApiKeyUpdate, LlmProfile } from "./ipc";

/** 数値も文字列で持つ。**「abc」を 0 に化けさせない**ため。 */
export type ProfileDraft = {
  name: string;
  baseUrl: string;
  model: string;
  contextWindow: string;
  temperature: string;
  maxTokens: string;
};

export type ProfileField = keyof ProfileDraft;

/**
 * 入力が通らない理由。**画面はこれで 1 行を出す。**
 * 値の範囲は `store/settings.rs` の `LlmProfile` に合わせてある。
 */
export type FieldProblem =
  | "nameEmpty"
  | "baseUrlEmpty"
  | "baseUrlNotHttp"
  | "modelEmpty"
  | "contextWindowNotNumber"
  | "contextWindowRange"
  | "temperatureNotNumber"
  | "temperatureRange"
  | "maxTokensNotNumber"
  | "maxTokensRange";

export type ProfileValidation = {
  /** 欄ごとの理由。問題が無ければ null。 */
  problems: Record<ProfileField, FieldProblem | null>;
  /** 1 つでも問題があれば false。**ボタンは消さず、無効にする**（CLAUDE.md §6）。 */
  ok: boolean;
};

/** `store/settings.rs` の `LlmProfile::default()` と合わせること。 */
export const DEFAULT_DRAFT: ProfileDraft = {
  name: "",
  baseUrl: "",
  model: "",
  contextWindow: "32768",
  temperature: "0.2",
  maxTokens: "4096",
};

/** temperature の範囲。OpenAI 互換 API の共通部分に合わせる。 */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

export function draftFromProfile(profile: LlmProfile): ProfileDraft {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: String(profile.contextWindow),
    temperature: String(profile.temperature),
    maxTokens: String(profile.maxTokens),
  };
}

export function validateProfile(draft: ProfileDraft): ProfileValidation {
  const problems: Record<ProfileField, FieldProblem | null> = {
    name: draft.name.trim() === "" ? "nameEmpty" : null,
    baseUrl: baseUrlProblem(draft.baseUrl),
    model: draft.model.trim() === "" ? "modelEmpty" : null,
    contextWindow: integerProblem(
      draft.contextWindow,
      "contextWindowNotNumber",
      "contextWindowRange",
    ),
    temperature: temperatureProblem(draft.temperature),
    maxTokens: integerProblem(draft.maxTokens, "maxTokensNotNumber", "maxTokensRange"),
  };
  const ok = Object.values(problems).every((problem) => problem === null);
  return { problems, ok };
}

/**
 * 保存して送る形。**検証を通っていないときは null**（呼び出し側で組み直させない）。
 *
 * `id` と `credentialKey` は**フロントが決めない**。新規なら空で送り、
 * Rust 側（`Store::upsert_llm_profile`）が採番する。参照キーを選ばせると、
 * 別のプロファイルの資格情報を指す形が作れてしまう（CLAUDE.md §4）。
 */
export function profileFromDraft(draft: ProfileDraft, existing: LlmProfile | null): LlmProfile | null {
  if (!validateProfile(draft).ok) return null;
  return {
    id: existing?.id ?? "",
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    contextWindow: Number(draft.contextWindow),
    temperature: Number(draft.temperature),
    maxTokens: Number(draft.maxTokens),
    credentialKey: existing?.credentialKey ?? "",
  };
}

/** 編集中の内容が保存済みの姿と違うか。**保存ボタンの出し分けに使う。** */
export function isDirty(draft: ProfileDraft, existing: LlmProfile | null): boolean {
  if (existing === null) return true;
  const saved = draftFromProfile(existing);
  return (Object.keys(saved) as ProfileField[]).some(
    (field) => draft[field].trim() !== saved[field].trim(),
  );
}

/** API キー欄の状態。**入力値と「消す」の意思表示**の 2 つだけ持つ。 */
export type ApiKeyField = { value: string; clear: boolean };

export const EMPTY_API_KEY: ApiKeyField = { value: "", clear: false };

/**
 * 「保存済みのキーを消す」の状態。
 *
 * **どの状態でも消さない**（CLAUDE.md §6）。押せないときは押せない理由を添えて出す。
 * - `noKey`  … このプロファイルにキーが保存されていない
 * - `typed`  … 新しいキーを入力中（消すのではなく差し替わる）
 * - `ready`  … 押せる
 */
export type ClearOption = { enabled: boolean; kind: "noKey" | "typed" | "ready" };

export function clearOption(field: ApiKeyField, hasSavedKey: boolean): ClearOption {
  if (field.value !== "") return { enabled: false, kind: "typed" };
  if (!hasSavedKey) return { enabled: false, kind: "noKey" };
  return { enabled: true, kind: "ready" };
}

/**
 * 保存時に API キーをどう扱うか。
 *
 * **空欄のままなら既存のキーを変えない。** 「空欄＝消す」にすると、名前だけ直して
 * 保存したときにキーが消える。消すのは明示的に選んだときだけ。
 * 押せない状態のチェックは無視する（clone の「既定の保存先」と同じ形）。
 */
export function apiKeyUpdate(field: ApiKeyField, hasSavedKey: boolean): ApiKeyUpdate {
  if (field.value !== "") return { kind: "replace", value: field.value };
  if (field.clear && clearOption(field, hasSavedKey).enabled) return { kind: "clear" };
  return { kind: "keep" };
}

/**
 * 「接続テスト」「モデル一覧を取得」を押せるか。
 *
 * **保存済みのプロファイルにしか通信させない。** キーは資格情報マネージャーから
 * 読むので、平文のキーが通る経路を「保存」1 つに閉じられる（CLAUDE.md §4）。
 * その代わり、押せない理由を必ず出す。
 *
 * - `invalid` … 入力に問題がある
 * - `unsaved` … まだ保存していない（新規）
 * - `dirty`   … 編集中の内容が保存されていない
 * - `ready`   … 押せる
 */
export type ProbeOption = { enabled: boolean; kind: "invalid" | "unsaved" | "dirty" | "ready" };

export function probeOption(draft: ProfileDraft, existing: LlmProfile | null): ProbeOption {
  if (!validateProfile(draft).ok) return { enabled: false, kind: "invalid" };
  if (existing === null || existing.id === "") return { enabled: false, kind: "unsaved" };
  if (isDirty(draft, existing)) return { enabled: false, kind: "dirty" };
  return { enabled: true, kind: "ready" };
}

/** 一覧に出す 1 行。**保存済みかどうかは参照キーの有無ではなく実物で決める。** */
export function hasSavedKey(profile: LlmProfile, credentialKeys: readonly string[]): boolean {
  return profile.credentialKey !== "" && credentialKeys.includes(profile.credentialKey);
}

function baseUrlProblem(value: string): FieldProblem | null {
  const trimmed = value.trim();
  if (trimmed === "") return "baseUrlEmpty";
  const lower = trimmed.toLowerCase();
  // **Rust 側 (`llm/client.rs` の `endpoint`) と同じ判定。** ここだけ緩いと、
  // 保存はできるのに接続テストが必ず失敗する形になる。
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return "baseUrlNotHttp";
  return null;
}

function integerProblem(
  value: string,
  notNumber: FieldProblem,
  range: FieldProblem,
): FieldProblem | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return notNumber;
  const parsed = Number(trimmed);
  // 1 以上。`u32` に収まらない値も弾く（Rust 側が受け取れない）。
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4_294_967_295) return range;
  return null;
}

function temperatureProblem(value: string): FieldProblem | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return "temperatureNotNumber";
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return "temperatureNotNumber";
  if (parsed < TEMPERATURE_MIN || parsed > TEMPERATURE_MAX) return "temperatureRange";
  return null;
}

/**
 * リポジトリの既定の接続先を、画面に出す形にする（T-25）。
 *
 * **T-23 で覚えるようにしたが、画面から読めなかった。** 既定がどこにあるのか
 * 読めないと、勝手に変わっているようにしか見えない（clone の「この保存先を
 * 次回から既定にする」で同じ指摘を受けている。CLAUDE.md §6）。
 *
 * 返すのは状態だけで、日本語は `i18n/ja.ts` が持つ。
 */
export type DefaultProfileView = {
  /** `select` に出す値。**見つからない ID は選べないので空にする。** */
  selected: string;
  /** 接続先が 1 つも無い。**押せない形で残して理由を出す**ため。 */
  noProfiles: boolean;
  /** 覚えている ID が一覧に無い（消したか、名前が変わった）。 */
  missing: boolean;
};

export function defaultProfileView(
  profiles: LlmProfile[],
  defaultId: string | null,
): DefaultProfileView {
  const found = defaultId !== null && profiles.some((profile) => profile.id === defaultId);
  return {
    selected: found ? (defaultId as string) : "",
    noProfiles: profiles.length === 0,
    // **「決めていない」と「消えた」を混ぜない。** 混ぜると、勝手に外れたのか
    // 自分で外したのか読めなくなる。
    missing: defaultId !== null && !found,
  };
}
