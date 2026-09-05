//! skill の読み込みと信頼モデルの結合テスト（T-21）。
//!
//! **実ファイルで見る。** 単体テストは中の判定を固定するが、
//! 「サブディレクトリを辿らない」「symlink を辿らない」「大きすぎるものを読まない」は
//! ファイルシステムを通さないと確かめられない。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use givsoner_lib::llm::skill::{
    self, RepoTrustStatus, SkillEntry, SkillOrigin, SkillState, MAX_FILE_BYTES, MAX_FILES,
};
use givsoner_lib::store::settings::RepoSkillTrust;

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
        skill::load(&self.global, Some(&self.repository), trust)
    }

    /// いまのファイルを記録して「信頼した」状態を作る。
    fn trusted(&self) -> RepoSkillTrust {
        RepoSkillTrust {
            trusted: true,
            hashes: skill::current_hashes(&self.repository),
        }
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
    assert!(entry.preview.contains(LEAK_MARKER), "確認画面では読ませる");
    assert!(catalog.trust.present);
    assert!(!catalog.trust.trusted);
}

#[test]
fn trusting_the_repository_hands_the_body_over() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "リポジトリの観点"));

    let catalog = fixture.load(&fixture.trusted());
    let entry = find(&catalog.entries, "ok");

    assert_eq!(entry.state, SkillState::Ready);
    assert_eq!(entry.usable_body(), Some("リポジトリの観点"));
    assert!(catalog.trust.trusted);
    assert!(!catalog.trust.needs_recheck);
}

// ---- 再確認 -------------------------------------------------------------

#[test]
fn changing_a_trusted_file_withholds_it_again() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "もとの観点"));
    let trust = fixture.trusted();

    fixture.write_repo("ok.md", &skill_text("ok", LEAK_MARKER));
    let catalog = fixture.load(&trust);

    assert!(catalog.trust.needs_recheck);
    assert_eq!(catalog.trust.changed, vec!["ok.md"]);
    assert_eq!(find(&catalog.entries, "ok").state, SkillState::Recheck);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
}

/// **信頼させてから 2 つ目を置く**のが一番素直な攻撃。内容の変化だけを見ると素通りする。
#[test]
fn adding_a_file_after_trusting_withholds_everything() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "無害な観点"));
    let trust = fixture.trusted();

    fixture.write_repo("evil.md", &skill_text("evil", LEAK_MARKER));
    let catalog = fixture.load(&trust);

    assert!(catalog.trust.needs_recheck);
    assert_eq!(catalog.trust.added, vec!["evil.md"]);
    assert!(catalog.trust.changed.is_empty());

    // **元から信頼していたほうも止める。** どの変化が効くかは読まないと分からない。
    assert_eq!(find(&catalog.entries, "ok").state, SkillState::Recheck);
    assert_eq!(find(&catalog.entries, "ok").usable_body(), None);
    assert!(!everything_the_prompt_could_see(&catalog.entries).contains(LEAK_MARKER));
}

/// 消えるのは危険が減る方向。**確認し直しを求めない。**
#[test]
fn removing_a_file_after_trusting_keeps_working() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "残るほう"));
    fixture.write_repo("gone.md", &skill_text("gone", "消えるほう"));
    let trust = fixture.trusted();

    fs::remove_file(fixture.repo_dir().join("gone.md")).unwrap();
    let catalog = fixture.load(&trust);

    assert!(!catalog.trust.needs_recheck);
    assert_eq!(find(&catalog.entries, "ok").usable_body(), Some("残るほう"));
}

/// **読めないファイルを足しても再確認になる。** 読めないものを足せば素通り、では困る。
#[test]
fn adding_an_unreadable_file_after_trusting_still_asks_again() {
    let fixture = Fixture::new();
    fixture.write_repo("ok.md", &skill_text("ok", "無害な観点"));
    let trust = fixture.trusted();

    fixture.write_repo("broken.md", "---\nname: x\n本文が壊れている\n");
    let catalog = fixture.load(&trust);

    assert!(catalog.trust.needs_recheck, "{:#?}", catalog.trust);
    assert_eq!(catalog.trust.added, vec!["broken.md"]);
}

// ---- 読む範囲 -----------------------------------------------------------

/// **サブディレクトリを辿らない。**
#[test]
fn does_not_descend_into_subdirectories() {
    let fixture = Fixture::new();
    let nested = fixture.repo_dir().join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("deep.md"), skill_text("deep", LEAK_MARKER)).unwrap();

    let catalog = fixture.load(&fixture.trusted());

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
/// 確かめていないのか区別が付かなくなる。`GIVSONER_SKIP_SYMLINK_TEST=1` で外せる。
#[test]
fn does_not_follow_symlinks() {
    if std::env::var("GIVSONER_SKIP_SYMLINK_TEST").is_ok() {
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
             どうしても外すときは GIVSONER_SKIP_SYMLINK_TEST=1 を設定してください。"
        );
    }

    let catalog = fixture.load(&fixture.trusted());

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

    let catalog = fixture.load(&fixture.trusted());
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

    let catalog = fixture.load(&fixture.trusted());
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

    let catalog = fixture.load(&fixture.trusted());
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

    let catalog = skill::load(&fixture.global, None, &fixture.trusted());

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

    let trusted = fixture.load(&fixture.trusted());
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
        find(&catalog.entries, "team").usable_body(),
        Some("チームの観点")
    );
}

/// 記録するハッシュは**ファイル名 → 内容**。同じ内容でも名前が違えば別物として数える。
#[test]
fn hashes_are_recorded_per_file() {
    let fixture = Fixture::new();
    fixture.write_repo("a.md", &skill_text("a", "同じ本文"));
    fixture.write_repo("b.md", &skill_text("b", "同じ本文"));

    let hashes: BTreeMap<String, String> = skill::current_hashes(&fixture.repository);
    assert_eq!(hashes.len(), 2);
    assert!(hashes.contains_key("a.md"));
    assert!(hashes.contains_key("b.md"));
}
