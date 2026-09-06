//! skill の読み込みと信頼モデルの結合テスト（T-21）。
//!
//! **実ファイルで見る。** 単体テストは中の判定を固定するが、
//! 「サブディレクトリを辿らない」「symlink を辿らない」「大きすぎるものを読まない」は
//! ファイルシステムを通さないと確かめられない。

use std::fs;
use std::path::{Path, PathBuf};

use gitpeek_lib::llm::skill::{
    self, RepoTrustStatus, SkillEntry, SkillOrigin, SkillState, MAX_FILE_BYTES, MAX_FILES,
};
use gitpeek_lib::store::settings::{RepoSkillTrust, SkillSettings};

/// 信頼していない skill に埋める目印。**これがプロンプト側へ出たら負け。**
const LEAK_MARKER: &str = "MARKER-UNTRUSTED-BODY-MUST-NEVER-LEAK";

struct Fixture {
    _dir: tempfile::TempDir,
    global: PathBuf,
    repository: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("appdata").join("skills");
        let repository = dir.path().join("repo");
        fs::create_dir_all(&global).unwrap();
        fs::create_dir_all(skill::repo_skill_dir(&repository)).unwrap();
        Self {
            _dir: dir,
            global,
            repository,
        }
    }

    fn write_global(&self, file: &str, text: &str) {
        fs::write(self.global.join(file), text).unwrap();
    }

    fn write_repo(&self, file: &str, text: &str) {
        fs::write(skill::repo_skill_dir(&self.repository).join(file), text).unwrap();
    }

    fn repo_dir(&self) -> PathBuf {
        skill::repo_skill_dir(&self.repository)
    }

    fn load(&self, trust: &RepoSkillTrust) -> skill::SkillCatalog {
        skill::load(
            &self.global,
            Some(&self.repository),
            trust,
            &SkillSettings::default(),
        )
    }

    /// 一覧のファイルを全部「使う」と決めた状態を作る。
    fn using(&self, files: &[&str]) -> RepoSkillTrust {
        let mut trust = RepoSkillTrust::default();
        for file in files {
            let hash = skill::file_hash(&self.repository, file)
                .unwrap_or_else(|| panic!("{file} が読めない"));
            trust.hashes.insert((*file).to_string(), hash);
        }
        trust
    }
}

fn skill_text(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: テスト用\n---\n\n{body}\n")
}

fn find<'a>(entries: &'a [SkillEntry], name: &str) -> &'a SkillEntry {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("{name} が一覧に無い: {entries:#?}"))
}

/// **プロンプトへ渡りうる文字列を全部つなげたもの。** ここに目印が出てはいけない。
fn everything_the_prompt_could_see(entries: &[SkillEntry]) -> String {
    SkillEntry::active(entries)
        .iter()
        .filter_map(|entry| entry.usable_body())
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- 信頼していないもの -------------------------------------------------

/// **このタスクの一線。** 未信頼リポジトリの本文はプロンプト側へ 1 文字も出ない。
#[test]
fn an_untrusted_repository_skill_never_reaches_the_prompt() {
    let fixture = Fixture::new();
    fixture.write_repo("evil.md", &skill_text("evil", LEAK_MARKER));

    let catalog = fixture.load(&RepoSkillTrust::default());
    let entry = find(&catalog.entries, "evil");

    assert_eq!(entry.state, SkillState::Untrusted);
    assert_eq!(entry.origin, SkillOrigin::Repository);
    assert_eq!(entry.usable_body(), None, "本文を配ってはいけない");
    assert!(
        !everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER),
        "未信頼の本文がプロンプト側へ出た",
    );

    // **一覧からは消さない。** 存在と、信頼すれば読めることが分かること（CLAUDE.md §6）。
    assert!(entry.preview.contains(LEAK_MARKER), "決める前に読ませる");
    assert!(catalog.trust.present);
    assert_eq!(catalog.trust.in_use, 0);
    assert_eq!(catalog.trust.undecided, vec!["evil.md"]);
}

/// **ファイル単位で決める。** 使うと決めた 1 つだけ本文が付く。
#[test]
fn deciding_to_use_one_file_hands_over_only_that_body() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "使うほうの観点"));
    fixture.write_repo("other.md", &skill_text("other", LEAK_MARKER));

    let catalog = fixture.load(&fixture.using(&["ok.md"]));

    let used = find(&catalog.entries, "ok");
    assert_eq!(used.state, SkillState::Ready);
    assert!(used.in_use);
    assert_eq!(used.usable_body().as_deref(), Some("使うほうの観点"));

    // **隣のファイルは巻き込まれない。**
    let other = find(&catalog.entries, "other");
    assert_eq!(other.state, SkillState::Untrusted);
    assert!(!other.in_use);
    assert_eq!(other.usable_body(), None);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));

    assert_eq!(catalog.trust.in_use, 1);
    assert_eq!(catalog.trust.undecided, vec!["other.md"]);
}

// ---- 再確認 -------------------------------------------------------------

/// 内容が変わったら**そのファイルだけ**が決め直しへ戻る。
#[test]
fn changing_a_file_withholds_only_that_file() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "もとの観点"));
    fixture.write_repo("stable.md", &skill_text("stable", "変えないほう"));
    let trust = fixture.using(&["ok.md", "stable.md"]);

    fixture.write_repo("ok.md", &skill_text("ok", LEAK_MARKER));
    let catalog = fixture.load(&trust);

    assert_eq!(catalog.trust.changed, vec!["ok.md"]);
    assert_eq!(find(&catalog.entries, "ok").state, SkillState::Recheck);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));

    // **隣は止めない。** 止める範囲を最小にできるのがファイル単位にした利点。
    let stable = find(&catalog.entries, "stable");
    assert_eq!(stable.state, SkillState::Ready);
    assert_eq!(stable.usable_body().as_deref(), Some("変えないほう"));
}

/// **無害な 1 つを使わせてから 2 つ目を置く**のが一番素直な攻撃。
/// ファイル単位なら、増えたものは記録が無いので**特別扱いを足さずに**未決のまま。
#[test]
fn a_file_added_afterwards_is_simply_undecided() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "無害な観点"));
    let trust = fixture.using(&["ok.md"]);

    fixture.write_repo("evil.md", &skill_text("evil", LEAK_MARKER));
    let catalog = fixture.load(&trust);

    assert_eq!(find(&catalog.entries, "evil").state, SkillState::Untrusted);
    assert_eq!(catalog.trust.undecided, vec!["evil.md"]);
    assert!(catalog.trust.changed.is_empty());
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));

    // **元から使っていたほうは巻き込まれない。**
    assert_eq!(
        find(&catalog.entries, "ok").usable_body().as_deref(),
        Some("無害な観点")
    );
}

/// 消えたファイルは記録が残るだけ。**残ったほうは動き続ける。**
#[test]
fn removing_a_file_does_not_disturb_the_others() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "残るほう"));
    fixture.write_repo("gone.md", &skill_text("gone", "消えるほう"));
    let trust = fixture.using(&["ok.md", "gone.md"]);

    fs::remove_file(fixture.repo_dir().join("gone.md")).unwrap();
    let catalog = fixture.load(&trust);

    assert!(catalog.trust.changed.is_empty());
    assert!(catalog.trust.undecided.is_empty());
    assert_eq!(
        find(&catalog.entries, "ok").usable_body().as_deref(),
        Some("残るほう")
    );
}

/// **読めないファイルも「決めていない」に数える。** 見せずに済ませない。
#[test]
fn an_unreadable_file_is_counted_as_undecided() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "無害な観点"));
    let trust = fixture.using(&["ok.md"]);

    fixture.write_repo("broken.md", "---
name: x
本文が壊れている
");
    let catalog = fixture.load(&trust);

    assert_eq!(catalog.trust.undecided, vec!["broken.md"]);
    assert!(matches!(
        find(&catalog.entries, "broken.md").state,
        SkillState::Unreadable { .. }
    ));
}

// ---- 読む範囲 -----------------------------------------------------------

/// **サブディレクトリを辿らない。**
#[test]
fn does_not_descend_into_subdirectories() {
    let fixture = Fixture::new();
    let nested = fixture.repo_dir().join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("deep.md"), skill_text("deep", LEAK_MARKER)).unwrap();

    let catalog = fixture.load(&fixture.using(&[]));

    assert!(
        !catalog.entries.iter().any(|entry| entry.name == "deep"),
        "{:#?}",
        catalog.entries
    );
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
    assert!(!catalog.trust.present, "中身が無いのと同じ");
}

/// **symlink を辿らない。** `.md` の名前で秘密鍵を指されると中身がプロンプトへ入る。
///
/// Windows の symlink 作成には開発者モードか管理者権限が要る。作れない環境では
/// **作れなかったことを出して落とす** — 黙って素通りさせると、守れているのか
/// 確かめていないのか区別が付かなくなる。`GITPEEK_SKIP_SYMLINK_TEST=1` で外せる。
#[test]
fn does_not_follow_symlinks() {
    if std::env::var("GITPEEK_SKIP_SYMLINK_TEST").is_ok() {
        return;
    }

    let fixture = Fixture::new();
    let secret = fixture.repository.join("secret.txt");
    fs::write(&secret, skill_text("secret", LEAK_MARKER)).unwrap();
    let link = fixture.repo_dir().join("looks-like-a-skill.md");

    if let Err(error) = make_symlink(&secret, &link) {
        panic!(
            "symlink を作れないので「辿らないこと」を確かめられません（{error}）。\
             Windows の設定で開発者モードを有効にするか、管理者権限で実行してください。\
             どうしても外すときは GITPEEK_SKIP_SYMLINK_TEST=1 を設定してください。"
        );
    }

    let catalog = fixture.load(&fixture.using(&[]));

    assert!(
        !catalog
            .entries
            .iter()
            .any(|entry| entry.file == "looks-like-a-skill.md"),
        "{:#?}",
        catalog.entries
    );
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
}

#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(not(windows))]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[test]
fn does_not_read_a_file_that_is_too_large() {
    let fixture = Fixture::new();
    let padding = "あ".repeat(MAX_FILE_BYTES as usize); // UTF-8 で 3 倍になるので確実に超える
    fixture.write_repo("huge.md", &skill_text("huge", &format!("{LEAK_MARKER}{padding}")));

    let catalog = fixture.load(&fixture.using(&[]));
    let entry = find(&catalog.entries, "huge.md");

    assert!(matches!(entry.state, SkillState::Unreadable { .. }), "{entry:#?}");
    assert_eq!(entry.usable_body(), None);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
    // **消さずに理由を出す。**
    let SkillState::Unreadable { reason } = &entry.state else {
        unreachable!()
    };
    assert!(reason.contains("大きすぎ"), "{reason}");
}

#[test]
fn stops_after_the_file_limit() {
    let fixture = Fixture::new();
    for index in 0..=MAX_FILES {
        fixture.write_repo(
            &format!("s{index:03}.md"),
            &skill_text(&format!("s{index:03}"), "観点"),
        );
    }

    let files: Vec<String> = (0..=MAX_FILES).map(|i| format!("s{i:03}.md")).collect();
    let names: Vec<&str> = files.iter().map(String::as_str).collect();
    let catalog = fixture.load(&fixture.using(&names));
    let readable = catalog
        .entries
        .iter()
        .filter(|entry| entry.origin == SkillOrigin::Repository)
        .filter(|entry| entry.usable_body().is_some())
        .count();

    assert_eq!(readable, MAX_FILES);
    // 溢れたぶんは理由付きで残る。
    assert!(catalog
        .entries
        .iter()
        .any(|entry| matches!(&entry.state, SkillState::Unreadable { reason } if reason.contains("個まで"))));
}

/// `.md` 以外は見ない。
#[test]
fn ignores_files_that_are_not_markdown() {
    let fixture = Fixture::new();
    fs::write(
        fixture.repo_dir().join("notes.txt"),
        skill_text("notes", LEAK_MARKER),
    )
    .unwrap();

    let catalog = fixture.load(&fixture.using(&[]));
    assert!(!catalog.trust.present);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
}

// ---- 出どころと同名 -----------------------------------------------------

#[test]
fn the_built_in_skill_survives_an_empty_setup() {
    let fixture = Fixture::new();
    let catalog = fixture.load(&RepoSkillTrust::default());

    let active = SkillEntry::active(&catalog.entries);
    assert_eq!(active.len(), 1, "内蔵だけが残る");
    assert_eq!(active[0].origin, SkillOrigin::BuiltIn);
    assert!(!catalog.trust.present);
}

/// リポジトリを開いていないときはリポジトリ内を見に行かない。
#[test]
fn without_a_repository_only_global_and_built_in_are_read() {
    let fixture = Fixture::new();
    fixture.write_global("team.md", &skill_text("team", "チームの観点"));
    fixture.write_repo("evil.md", &skill_text("evil", LEAK_MARKER));

    let catalog = skill::load(&fixture.global, None, &fixture.using(&[]), &SkillSettings::default());

    assert_eq!(SkillEntry::active(&catalog.entries).len(), 2);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
    assert_eq!(catalog.trust, RepoTrustStatus::default());
}

/// 同名。**信頼済みならリポジトリ内が勝ち、未信頼ならグローバルが残る。**
#[test]
fn the_same_name_resolves_by_trust() {
    let fixture = Fixture::new();
    fixture.write_global("review.md", &skill_text("review", "グローバルの観点"));
    fixture.write_repo("review.md", &skill_text("review", "リポジトリの観点"));

    let untrusted = fixture.load(&RepoSkillTrust::default());
    let bodies = everything_the_prompt_could_see(&untrusted.entries);
    assert!(bodies.contains("グローバルの観点"), "未信頼ならグローバルが残る");
    assert!(!bodies.contains("リポジトリの観点"));
    assert_eq!(
        find(&untrusted.entries, "review").shadowed_by,
        None,
        "未信頼のものに押しのけさせない"
    );

    let trusted = fixture.load(&fixture.using(&["review.md"]));
    let bodies = everything_the_prompt_could_see(&trusted.entries);
    assert!(bodies.contains("リポジトリの観点"), "信頼済みならリポジトリ内が勝つ");
    assert!(!bodies.contains("グローバルの観点"));
    // **どちらが使われたか読めること。**
    let shadowed = trusted
        .entries
        .iter()
        .find(|entry| entry.origin == SkillOrigin::Global && entry.name == "review")
        .unwrap();
    assert_eq!(shadowed.shadowed_by, Some(SkillOrigin::Repository));
}

/// グローバルは信頼操作の対象外。**置いた本人のものなので既定で使える。**
#[test]
fn global_skills_need_no_trust() {
    let fixture = Fixture::new();
    fixture.write_global("team.md", &skill_text("team", "チームの観点"));

    let catalog = fixture.load(&RepoSkillTrust::default());
    assert_eq!(
        find(&catalog.entries, "team").usable_body().as_deref(),
        Some("チームの観点")
    );
}

/// ハッシュは**ファイルごと**。同じ内容でも別のファイルなら別々に決める。
#[test]
fn hashes_are_taken_per_file() {
    let fixture = Fixture::new();
    fixture.write_repo("a.md", &skill_text("a", "同じ本文"));
    fixture.write_repo("b.md", &skill_text("b", "同じ本文"));

    let a = skill::file_hash(&fixture.repository, "a.md").expect("読めること");
    let b = skill::file_hash(&fixture.repository, "b.md").expect("読めること");
    assert_ne!(a, "", "ハッシュが空では照合にならない");
    // `name` が違うのでファイル内容も違う。
    assert_ne!(a, b);

    // **無いファイルは None。** ここで `Some("")` を返すと、
    // 消えたファイルを「一致した」と読んでしまう。
    assert_eq!(skill::file_hash(&fixture.repository, "missing.md"), None);
    // **ディレクトリの外は見に行かない。**
    assert_eq!(skill::file_hash(&fixture.repository, "../../secret.md"), None);
}
