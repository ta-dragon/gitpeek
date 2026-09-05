import { describe, expect, it } from "vitest";

import { defaultFolderName, joinPath, rememberOption, samePath } from "./clonePath";

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

describe("samePath", () => {
  // **Rust 側の `same_path` と同じ判定にする。** ここがずれると、既定の保存先が
  // `C:\Gitwork` と `C:\Gitwork\` の間で往復して毎回書き換わる。
  it("末尾の区切りを無視する", () => {
    expect(samePath("C:\\Gitwork", "C:\\Gitwork\\")).toBe(true);
    expect(samePath("C:\\Gitwork\\", "C:\\Gitwork")).toBe(true);
  });

  it("大文字小文字を区別しない（Windows）", () => {
    expect(samePath("C:\\Gitwork", "c:\\gitwork")).toBe(true);
  });

  it("前後の空白を無視する", () => {
    expect(samePath("  C:\\Gitwork  ", "C:\\Gitwork")).toBe(true);
  });

  it("別の場所は別と言う", () => {
    expect(samePath("C:\\Gitwork", "C:\\Gitwork\\sub")).toBe(false);
    expect(samePath("C:\\Gitwork", "D:\\Gitwork")).toBe(false);
  });
});

describe("rememberOption", () => {
  // **どの状態でも消さない。** 消すと既定がどこにあるのか画面から読めなくなり、
  // 勝手に変わっているようにしか見えない（T-19 の目視で報告された）。
  it("保存先が空欄でも状態を返す（消さない）", () => {
    expect(rememberOption("", "C:\\Gitwork")).toEqual({
      enabled: false,
      kind: "empty",
      current: "C:\\Gitwork",
    });
  });

  it("既定がまだ無ければ決められる", () => {
    expect(rememberOption("C:\\Gitwork", null)).toEqual({
      enabled: true,
      kind: "unset",
      current: null,
    });
    // 空文字列も「無い」と同じに扱う（手編集で入りうる）。
    expect(rememberOption("C:\\Gitwork", "  ").kind).toBe("unset");
  });

  // **これが「毎回変わる」の芯。** 同じ場所を別物と読むと、書き換えても状態が
  // 変わらないので、押せるままになって既定が往復する。
  it("すでに既定なら押させない（区切りと大小文字の違いを含む）", () => {
    expect(rememberOption("C:\\Gitwork", "C:\\Gitwork")).toEqual({
      enabled: false,
      kind: "same",
      current: "C:\\Gitwork",
    });
    expect(rememberOption("C:\\Gitwork\\", "C:\\Gitwork").enabled).toBe(false);
    expect(rememberOption("c:\\gitwork", "C:\\Gitwork").enabled).toBe(false);
  });

  it("別の場所なら置き換えられると言う", () => {
    expect(rememberOption("D:\\work", "C:\\Gitwork")).toEqual({
      enabled: true,
      kind: "replace",
      current: "C:\\Gitwork",
    });
  });

  // **いまの既定を必ず持って返す。** 文言に出すため — 出さないと、どこが既定なのか
  // 画面のどこにも現れない。
  it("いまの既定を必ず添える", () => {
    for (const parent of ["", "C:\\Gitwork", "D:\\work"]) {
      expect(rememberOption(parent, "C:\\Gitwork").current).toBe("C:\\Gitwork");
    }
  });
});
