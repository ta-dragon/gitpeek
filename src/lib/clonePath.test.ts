import { describe, expect, it } from "vitest";

import { defaultFolderName, joinPath } from "./clonePath";

describe("defaultFolderName", () => {
  it("`.git` を落とす", () => {
    expect(defaultFolderName("https://github.com/owner/repo.git")).toBe("repo");
  });

  it("`.git` が無くても読める", () => {
    expect(defaultFolderName("https://github.com/owner/repo")).toBe("repo");
  });

  it("末尾のスラッシュを無視する", () => {
    expect(defaultFolderName("https://host/owner/repo/")).toBe("repo");
    expect(defaultFolderName("https://host/owner/repo.git/")).toBe("repo");
  });

  // **SCP 形式は URL としてパースできない。** `:` が区切りになる。
  it("SCP 形式（git@host:owner/repo.git）を読める", () => {
    expect(defaultFolderName("git@github.com:owner/repo.git")).toBe("repo");
    expect(defaultFolderName("git@github.com:repo.git")).toBe("repo");
  });

  it("ssh:// 形式も読める", () => {
    expect(defaultFolderName("ssh://git@github.com/owner/repo.git")).toBe("repo");
  });

  // ブランチ名と違い、フォルダ名は最後の 1 段だけでよい。
  it("階層が深くても最後の 1 段を取る", () => {
    expect(defaultFolderName("https://gitlab.com/group/sub/repo.git")).toBe("repo");
  });

  // 資格情報付きの URL を貼られることがある。**名前を取り違えない。**
  it("資格情報が埋まっていても名前を取り違えない", () => {
    expect(defaultFolderName("https://user:token@github.com/owner/repo.git")).toBe("repo");
  });

  it("ポート番号があっても読める", () => {
    expect(defaultFolderName("https://example.com:8443/owner/repo.git")).toBe("repo");
  });

  it("ローカルパスからも読める", () => {
    expect(defaultFolderName("C:\\src\\repo")).toBe("repo");
    expect(defaultFolderName("file:///C:/src/repo.git")).toBe("repo");
  });

  // **決められないときは空を返す。** 適当な名前を作らない。
  it("リポジトリを指していない入力では空を返す", () => {
    expect(defaultFolderName("")).toBe("");
    expect(defaultFolderName("   ")).toBe("");
    expect(defaultFolderName("https://github.com")).toBe("");
    expect(defaultFolderName("https://github.com/")).toBe("");
    expect(defaultFolderName("repo")).toBe("");
  });

  it("フォルダ名にならない残りかすでは空を返す", () => {
    expect(defaultFolderName("https://host/.git")).toBe("");
    expect(defaultFolderName("https://host/owner/.")).toBe("");
    expect(defaultFolderName("https://host/owner/..")).toBe("");
  });

  // Windows は末尾の `.` と空白を落とすので、意図と違うフォルダができる。
  it("Windows が黙って変える名前は受け付けない", () => {
    expect(defaultFolderName("https://host/owner/repo.")).toBe("");
  });
});

describe("joinPath", () => {
  it("親フォルダの区切りに合わせる", () => {
    expect(joinPath("C:\\ws", "repo")).toBe("C:\\ws\\repo");
    expect(joinPath("/home/me/ws", "repo")).toBe("/home/me/ws/repo");
  });

  it("末尾の区切りを重ねない", () => {
    expect(joinPath("C:\\ws\\", "repo")).toBe("C:\\ws\\repo");
    expect(joinPath("/home/me/ws/", "repo")).toBe("/home/me/ws/repo");
  });

  it("どちらかが空なら空", () => {
    expect(joinPath("", "repo")).toBe("");
    expect(joinPath("C:\\ws", "")).toBe("");
    expect(joinPath("  ", "repo")).toBe("");
  });
});
