import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import type { RepositoryEntry, RepositoryProbe } from "./ipc";
import { canRestore, noSelectionText, repositoryState } from "./repositoryState";

// 文言そのものは assert しない（CLAUDE.md §8）。見るのは読み分けと、「登録されていません」を
// いつ出すか（ja のキーで比べる）。

const probe: RepositoryProbe = {
  isRepository: true,
  gitDir: "C:/repo/.git",
  workTree: "C:/repo",
  isBare: false,
  isShallow: false,
  head: { kind: "branch", name: "main", sha: "a".repeat(40) },
  remotes: ["origin"],
  lastFetchAtMs: null,
  indexLockPresent: false,
  error: null,
};

function entry(patch: Partial<RepositoryEntry>): RepositoryEntry {
  return {
    id: "r1",
    name: "repo",
    path: "C:/repo",
    order: 0,
    visibleRefs: { mode: "all", excluded: [] },
    defaultLlmProfileId: null,
    repoSkills: { trusted: false, hashes: {} },
    probe,
    checked: true,
    fetchStale: false,
    ...patch,
  };
}

describe("repositoryState", () => {
  it("確かめる前は、probe が無くても「見つからない」にしない", () => {
    expect(repositoryState(entry({ checked: false, probe: null }))).toBe("checking");
  });

  it("確かめたあとに probe が無ければ、フォルダが無い", () => {
    expect(repositoryState(entry({ probe: null }))).toBe("missing");
  });

  it("リポジトリでないものと、使えるものを分ける", () => {
    expect(repositoryState(entry({ probe: { ...probe, isRepository: false } }))).toBe(
      "notRepository",
    );
    expect(repositoryState(entry({}))).toBe("ready");
  });
});

describe("canRestore", () => {
  it("確かめている途中でも、前回のものを選び直す（グラフを待たせない）", () => {
    expect(canRestore(entry({ checked: false, probe: null }))).toBe(true);
  });

  it("フォルダが消えていれば選ばない", () => {
    expect(canRestore(entry({ probe: null }))).toBe(false);
  });

  it("リポジトリでなくなっていても、いままでどおり選ぶ（理由は右の画面に出る）", () => {
    expect(canRestore(entry({ probe: { ...probe, isRepository: false } }))).toBe(true);
  });
});

describe("noSelectionText", () => {
  it("読み終えるまで「登録されていません」と出さない", () => {
    expect(noSelectionText(false, 0)).not.toBe(ja.repositories.empty);
    expect(noSelectionText(false, 12)).not.toBe(ja.repositories.empty);
  });

  it("読み終えて 0 件のときだけ「登録されていません」", () => {
    expect(noSelectionText(true, 0)).toBe(ja.repositories.empty);
    expect(noSelectionText(true, 3)).not.toBe(ja.repositories.empty);
  });
});
