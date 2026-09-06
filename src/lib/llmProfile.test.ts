import { describe, expect, it } from "vitest";

import type { LlmProfile } from "./ipc";
import {
  apiKeyUpdate,
  clearOption,
  defaultProfileView,
  DEFAULT_DRAFT,
  draftFromProfile,
  hasSavedKey,
  isDirty,
  probeOption,
  profileFromDraft,
  validateProfile,
  type ProfileDraft,
} from "./llmProfile";

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    ...DEFAULT_DRAFT,
    name: "ローカル",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:14b",
    ...overrides,
  };
}

function saved(overrides: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: "p1",
    name: "ローカル",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:14b",
    contextWindow: 32_768,
    temperature: 0.2,
    maxTokens: 4_096,
    credentialKey: "llm/abc",
    ...overrides,
  };
}

describe("validateProfile", () => {
  it("通る入力には問題を出さない", () => {
    const result = validateProfile(draft());
    expect(result.ok).toBe(true);
    expect(Object.values(result.problems).every((problem) => problem === null)).toBe(true);
  });

  it("名前が空なら止める", () => {
    expect(validateProfile(draft({ name: "   " })).problems.name).toBe("nameEmpty");
    expect(validateProfile(draft({ name: "" })).ok).toBe(false);
  });

  it("モデルが空なら止める", () => {
    expect(validateProfile(draft({ model: "" })).problems.model).toBe("modelEmpty");
  });

  it("base URL は http か https だけ", () => {
    expect(validateProfile(draft({ baseUrl: "" })).problems.baseUrl).toBe("baseUrlEmpty");
    expect(validateProfile(draft({ baseUrl: "localhost:11434/v1" })).problems.baseUrl).toBe(
      "baseUrlNotHttp",
    );
    expect(validateProfile(draft({ baseUrl: "ftp://example.com/v1" })).problems.baseUrl).toBe(
      "baseUrlNotHttp",
    );
    // 大文字で貼られても通す。
    expect(validateProfile(draft({ baseUrl: "HTTPS://api.example.com/v1" })).ok).toBe(true);
    // 末尾スラッシュは Rust 側が落とすので、ここでは問題にしない。
    expect(validateProfile(draft({ baseUrl: "http://localhost:11434/v1/" })).ok).toBe(true);
  });

  it("コンテキスト長は 1 以上の整数", () => {
    expect(validateProfile(draft({ contextWindow: "abc" })).problems.contextWindow).toBe(
      "contextWindowNotNumber",
    );
    expect(validateProfile(draft({ contextWindow: "" })).problems.contextWindow).toBe(
      "contextWindowNotNumber",
    );
    // **`0` を「数値ではない」にしない。** 直し方が変わる。
    expect(validateProfile(draft({ contextWindow: "0" })).problems.contextWindow).toBe(
      "contextWindowRange",
    );
    expect(validateProfile(draft({ contextWindow: "1" })).ok).toBe(true);
    // u32 に収まらない値は Rust 側が受け取れない。
    expect(validateProfile(draft({ contextWindow: "4294967296" })).problems.contextWindow).toBe(
      "contextWindowRange",
    );
  });

  it("temperature は 0〜2", () => {
    expect(validateProfile(draft({ temperature: "0" })).ok).toBe(true);
    expect(validateProfile(draft({ temperature: "2" })).ok).toBe(true);
    expect(validateProfile(draft({ temperature: "2.1" })).problems.temperature).toBe(
      "temperatureRange",
    );
    expect(validateProfile(draft({ temperature: "-1" })).problems.temperature).toBe(
      "temperatureNotNumber",
    );
    expect(validateProfile(draft({ temperature: "ぬるい" })).problems.temperature).toBe(
      "temperatureNotNumber",
    );
  });

  it("max tokens は 1 以上の整数", () => {
    expect(validateProfile(draft({ maxTokens: "0" })).problems.maxTokens).toBe("maxTokensRange");
    expect(validateProfile(draft({ maxTokens: "1.5" })).problems.maxTokens).toBe(
      "maxTokensNotNumber",
    );
    expect(validateProfile(draft({ maxTokens: "4096" })).ok).toBe(true);
  });
});

describe("profileFromDraft", () => {
  it("検証を通らない下書きからは組み立てない", () => {
    expect(profileFromDraft(draft({ name: "" }), null)).toBeNull();
  });

  /** **フロントは `id` も `credentialKey` も決めない**（Rust 側が採番する）。 */
  it("新規は id と参照キーを空で送る", () => {
    const built = profileFromDraft(draft(), null);
    expect(built).not.toBeNull();
    expect(built?.id).toBe("");
    expect(built?.credentialKey).toBe("");
    expect(built?.contextWindow).toBe(32_768);
    expect(built?.temperature).toBe(0.2);
  });

  it("既存の id と参照キーは持ち越す", () => {
    const built = profileFromDraft(draft({ name: "  新しい名前  " }), saved());
    expect(built?.id).toBe("p1");
    expect(built?.credentialKey).toBe("llm/abc");
    // 前後の空白は落とす。
    expect(built?.name).toBe("新しい名前");
  });

  it("保存された姿から下書きへ往復できる", () => {
    const profile = saved();
    const built = profileFromDraft(draftFromProfile(profile), profile);
    expect(built).toEqual(profile);
  });
});

describe("isDirty", () => {
  it("新規は常に未保存扱い", () => {
    expect(isDirty(draft(), null)).toBe(true);
  });

  it("保存された姿と同じなら false", () => {
    expect(isDirty(draftFromProfile(saved()), saved())).toBe(false);
  });

  it("前後の空白だけの違いは変更としない", () => {
    expect(isDirty(draft({ name: "  ローカル  " }), saved())).toBe(false);
  });

  it("どの欄を変えても拾う", () => {
    expect(isDirty(draft({ model: "gpt-4o-mini" }), saved())).toBe(true);
    expect(isDirty(draft({ maxTokens: "2048" }), saved())).toBe(true);
  });
});

describe("probeOption", () => {
  /** **押せないときも画面から消さない**ので、理由が必ず付くこと。 */
  it("入力に問題があれば invalid", () => {
    expect(probeOption(draft({ baseUrl: "" }), saved())).toEqual({
      enabled: false,
      kind: "invalid",
    });
  });

  it("まだ保存していなければ unsaved", () => {
    expect(probeOption(draft(), null)).toEqual({ enabled: false, kind: "unsaved" });
    expect(probeOption(draft(), saved({ id: "" }))).toEqual({ enabled: false, kind: "unsaved" });
  });

  it("編集中の内容が保存されていなければ dirty", () => {
    expect(probeOption(draft({ model: "gpt-4o-mini" }), saved())).toEqual({
      enabled: false,
      kind: "dirty",
    });
  });

  it("保存済みで変更が無ければ押せる", () => {
    expect(probeOption(draftFromProfile(saved()), saved())).toEqual({
      enabled: true,
      kind: "ready",
    });
  });
});

describe("apiKeyUpdate", () => {
  /** **空欄のままなら既存のキーを変えない。** 名前だけ直して保存したら消えた、を防ぐ。 */
  it("空欄なら触らない", () => {
    expect(apiKeyUpdate({ value: "", clear: false }, true)).toEqual({ kind: "keep" });
    expect(apiKeyUpdate({ value: "", clear: false }, false)).toEqual({ kind: "keep" });
  });

  it("入力があれば差し替える", () => {
    expect(apiKeyUpdate({ value: "sk-new", clear: false }, true)).toEqual({
      kind: "replace",
      value: "sk-new",
    });
  });

  it("明示的に選んだときだけ消す", () => {
    expect(apiKeyUpdate({ value: "", clear: true }, true)).toEqual({ kind: "clear" });
  });

  /** 押せない状態のチェックは無視する（clone の「既定の保存先」と同じ形）。 */
  it("キーが保存されていなければ消しに行かない", () => {
    expect(apiKeyUpdate({ value: "", clear: true }, false)).toEqual({ kind: "keep" });
  });

  it("入力があるときは消すより差し替えが勝つ", () => {
    expect(apiKeyUpdate({ value: "sk-new", clear: true }, true)).toEqual({
      kind: "replace",
      value: "sk-new",
    });
  });
});

describe("clearOption", () => {
  it("保存されたキーが無ければ押せない", () => {
    expect(clearOption({ value: "", clear: false }, false)).toEqual({
      enabled: false,
      kind: "noKey",
    });
  });

  it("新しいキーを入力中は押せない", () => {
    expect(clearOption({ value: "sk-new", clear: false }, true)).toEqual({
      enabled: false,
      kind: "typed",
    });
  });

  it("保存済みで入力が空なら押せる", () => {
    expect(clearOption({ value: "", clear: false }, true)).toEqual({
      enabled: true,
      kind: "ready",
    });
  });
});

describe("hasSavedKey", () => {
  /** **参照キーがあることと、キーが保存されていることは別。** */
  it("資格情報マネージャーに実物があるときだけ true", () => {
    expect(hasSavedKey(saved(), ["llm/abc"])).toBe(true);
    expect(hasSavedKey(saved(), [])).toBe(false);
    expect(hasSavedKey(saved({ credentialKey: "" }), [""])).toBe(false);
  });
});

describe("defaultProfileView", () => {
  const profiles = [saved(), saved({ id: "p2", name: "別の接続先" })];

  it("覚えている接続先を選んだ状態にする", () => {
    expect(defaultProfileView(profiles, "p2")).toEqual({
      selected: "p2",
      noProfiles: false,
      missing: false,
    });
  });

  // 端の値: まだ決めていない。**「消えた」と混ぜない。**
  it("決めていなければ何も選ばない", () => {
    expect(defaultProfileView(profiles, null)).toEqual({
      selected: "",
      noProfiles: false,
      missing: false,
    });
  });

  /**
   * **覚えている ID が一覧に無い**（消した / 別の環境の設定を持ってきた）。
   * 勝手に外れたのか自分で外したのか読めるように、状態を分ける。
   */
  it("覚えている接続先が見つからないときはそう言う", () => {
    expect(defaultProfileView(profiles, "消えた")).toEqual({
      selected: "",
      noProfiles: false,
      missing: true,
    });
  });

  // 端の値: 接続先が 1 つも無い。**押せない形で残して理由を出す**ため。
  it("接続先が無いときはそう言う", () => {
    expect(defaultProfileView([], null)).toEqual({
      selected: "",
      noProfiles: true,
      missing: false,
    });
    expect(defaultProfileView([], "p1").missing).toBe(true);
  });
});
