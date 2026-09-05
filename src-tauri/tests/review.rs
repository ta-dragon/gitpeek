//! レビュー実行エンジンの結合テスト（T-22）。
//!
//! **モックサーバへ実際に飛んだ要求で見る。** 組み立てを固定するだけでは、
//! 経路が 1 度も動かないまま緑になる（T-18 で踏んだ）。
//!
//! ここで見るのは大きく 5 つ。
//!
//! - **レビューが失われない**こと（正しい JSON / フェンス / 地の文 / 壊れた JSON /
//!   Markdown / 途中で切れた応答 / 空の応答 / HTTP エラー）
//! - **中止が効く**こと（ストリームの途中でも、ファイルの切れ目でも）
//! - **キーが 1 文字も漏れない**こと（チャンクに割れても）
//! - **渡していいものだけ渡す**こと（未信頼 skill の本文・当たらない skill・ファイル全文）
//! - **分割と並列と 400 の投げ直し**

mod common;

#[path = "common/mockhttp.rs"]
mod mockhttp;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use givsoner_lib::git::diff::DiffSource;
use givsoner_lib::git::exec::Cancel;
use givsoner_lib::llm::review::{
    self, ReviewEvent, ReviewPlan, ReviewRun, ReviewSink, Severity,
};
use givsoner_lib::llm::skill::{self, SkillEntry};
use givsoner_lib::store::settings::{LlmProfile, RepoSkillTrust, SkillSettings};

use common::{fixtures, log};
use mockhttp::{sse_delta, sse_finish, Canned, MockServer, SSE_DONE};

/// 信頼していない skill に埋める目印。**これがプロンプトへ出たら負け。**
const LEAK_MARKER: &str = "MARKER-UNTRUSTED-BODY-MUST-NEVER-LEAK";

/// 正しい応答の見本。
const GOOD_JSON: &str =
    r#"{"summary":"要約です","findings":[{"file":"追加.txt","line":1,"severity":"major","title":"見出し","message":"詳細"}]}"#;

/// `changes` リポジトリでレビューできるテキストファイル。
const TEXT_FILES: &[&str] = &[
    "リネーム後.txt",
    "消える.txt",
    "sub/keep.txt",
    "追加.txt",
    "sjis.txt",
    "crlf.txt",
];

/// 起きたことを全部ためる受け皿。
#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<ReviewEvent>>,
}

impl ReviewSink for Recorder {
    fn report(&self, event: ReviewEvent) {
        self.events.lock().unwrap().push(event);
    }
}

impl Recorder {
    fn events(&self) -> Vec<ReviewEvent> {
        self.events.lock().unwrap().clone()
    }

    /// 流れてきた差分を全部繋いだもの。
    fn streamed(&self) -> String {
        self.events()
            .iter()
            .filter_map(|event| match event {
                ReviewEvent::Delta { text, .. } | ReviewEvent::SummaryDelta { text } => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }
}

/// 1 回分の道具立て。
struct Harness {
    _dir: tempfile::TempDir,
    /// skill の置き場所（グローバル扱い）。
    global: PathBuf,
    /// リポジトリ内 skill を置くための別のフォルダ。**差分を取るリポジトリとは別。**
    skill_repo: PathBuf,
    repo: PathBuf,
    profile: LlmProfile,
    api_key: String,
    settings: SkillSettings,
    trust: RepoSkillTrust,
    source: DiffSource,
    concurrency: u8,
}

impl Harness {
    fn new(base_url: &str) -> Self {
        Self::with_repo(base_url, fixtures().join("changes"))
    }

    fn with_repo(base_url: &str, repo: PathBuf) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("skills");
        let skill_repo = dir.path().join("skillrepo");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::create_dir_all(skill::repo_skill_dir(&skill_repo)).unwrap();

        let source = head_and_parent(&repo);
        Self {
            _dir: dir,
            global,
            skill_repo,
            repo,
            profile: LlmProfile {
                id: "p1".to_string(),
                name: "テスト接続先".to_string(),
                base_url: base_url.to_string(),
                model: "test-model".to_string(),
                ..LlmProfile::default()
            },
            api_key: String::new(),
            settings: SkillSettings::default(),
            trust: RepoSkillTrust::default(),
            source,
            concurrency: 1,
        }
    }

    fn write_global_skill(&self, file: &str, text: &str) {
        std::fs::write(self.global.join(file), text).unwrap();
    }

    fn write_repo_skill(&self, file: &str, text: &str) {
        std::fs::write(skill::repo_skill_dir(&self.skill_repo).join(file), text).unwrap();
    }

    /// 内蔵 skill を使わない。**観点を 1 つに絞りたいとき**に呼ぶ。
    fn without_built_in(&mut self) {
        self.settings
            .use_skill
            .insert("general-review".to_string(), false);
    }

    fn skills(&self) -> Vec<SkillEntry> {
        skill::load(
            &self.global,
            Some(&self.skill_repo),
            &self.trust,
            &self.settings,
        )
        .entries
    }

    fn plan(&self) -> ReviewPlan {
        let skills = self.skills();
        review::plan(&review::ReviewContext {
            log: &log(),
            program: "git",
            repo: &self.repo,
            source: &self.source,
            profile: &self.profile,
            api_key: &self.api_key,
            skills: &skills,
            context_lines: 10,
            concurrency: self.concurrency,
        })
        .expect("計画を作れること")
    }

    fn run_with(&self, include: &[&str], cancel: &Cancel, sink: &dyn ReviewSink) -> ReviewRun {
        let skills = self.skills();
        let include: Vec<String> = include.iter().map(|it| (*it).to_string()).collect();
        review::run(
            &review::ReviewContext {
                log: &log(),
                program: "git",
                repo: &self.repo,
                source: &self.source,
                profile: &self.profile,
                api_key: &self.api_key,
                skills: &skills,
                context_lines: 10,
                concurrency: self.concurrency,
            },
            &include,
            cancel,
            sink,
        )
        .expect("実行できること")
    }

    fn run(&self, include: &[&str]) -> (ReviewRun, Recorder) {
        let recorder = Recorder::default();
        let run = self.run_with(include, &Cancel::new(), &recorder);
        (run, recorder)
    }
}

/// HEAD とその第 1 親。**SHA は生成のたびに変わる**ので直書きできない。
fn head_and_parent(repo: &Path) -> DiffSource {
    let head = git_output(repo, &["rev-parse", "HEAD"]);
    let parent = git_output(repo, &["rev-parse", "HEAD^"]);
    DiffSource::Range {
        parent: Some(parent),
        sha: head,
        symmetric: false,
    }
}

fn git_output(repo: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git を起動できること");
    assert!(
        output.status.success(),
        "git {args:?} が失敗: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// SSE で本文を 1 つ返すサーバ。
fn serving(content: &str) -> MockServer {
    MockServer::always(Canned::sse_content(content))
}

/// 結果のうち**画面とログへ出る文字列**を全部つなげたもの。
fn visible(run: &ReviewRun, recorder: &Recorder) -> String {
    format!("{run:?} {:?} {}", recorder.events(), recorder.streamed())
}

// ---- レビューが失われないこと（DESIGN.md §10.6）------------------------------

#[test]
fn reviews_each_file_and_then_writes_one_summary() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());

    let (run, recorder) = harness.run(TEXT_FILES);

    assert_eq!(run.files.len(), TEXT_FILES.len(), "全ファイルが結果に並ぶ");
    assert_eq!(run.failed, 0);
    assert!(run.summary.is_some(), "全体サマリを作る");
    assert_eq!(
        server.requests().len(),
        TEXT_FILES.len() + 1,
        "ファイルごとに 1 回 ＋ 最後にサマリ 1 回"
    );

    let first = &run.files[0];
    let text = first.text.as_ref().expect("構造化できること");
    assert_eq!(text.summary, "要約です");
    assert_eq!(text.findings.len(), 1);
    assert_eq!(text.findings[0].severity, Severity::Major);
    assert!(text.markdown.is_none(), "読めたのに生出力を抱えない");

    // **ストリーミングしていること。** 流れた差分を繋ぐと本文になる。
    let request = server.last();
    assert!(request.body.contains("\"stream\":true"), "{}", request.body);
    assert!(
        recorder.streamed().contains("要約です"),
        "本文が少しずつ流れること: {}",
        recorder.streamed()
    );

    // **`response_format` を既定で送る**（決定 4）。
    assert!(
        request.body.contains("\"response_format\""),
        "{}",
        request.body
    );
}

#[test]
fn keeps_the_review_when_the_json_is_wrapped_in_a_code_fence() {
    let server = serving(&format!("```json\n{GOOD_JSON}\n```"));
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果があること");
    assert_eq!(text.summary, "要約です");
    assert!(text.markdown.is_none(), "フェンスを剥がして読めること");
}

#[test]
fn keeps_the_review_when_the_json_has_prose_around_it() {
    let server = serving(&format!("はい、レビューします。\n{GOOD_JSON}\n以上です。"));
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果があること");
    assert_eq!(text.findings.len(), 1, "前後の地の文を落として読めること");
}

#[test]
fn falls_back_to_markdown_when_the_json_is_broken() {
    let broken = r#"{"summary":"途中まで","findings":[{"file":"#;
    let server = serving(broken);
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果を捨てないこと");
    assert_eq!(
        text.markdown.as_deref(),
        Some(broken),
        "受け取った本文をそのまま残す"
    );
    assert!(
        text.fallback_reason.is_some(),
        "なぜ Markdown なのかを添える"
    );
}

#[test]
fn falls_back_to_markdown_when_the_model_writes_plain_markdown() {
    let markdown = "## レビュー結果\n\n- 問題は見つかりませんでした。";
    let server = serving(markdown);
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果を捨てないこと");
    assert_eq!(text.markdown.as_deref(), Some(markdown));
    assert!(text.findings.is_empty());
}

#[test]
fn keeps_what_arrived_when_the_stream_is_cut_short() {
    // `[DONE]` も `finish_reason` も来ないまま終わる。
    let server = MockServer::always(Canned::sse(sse_delta("{\"summary\":\"途中で")));
    let harness = Harness::new(&server.base_url());

    let (run, recorder) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果を捨てないこと");
    assert!(
        text.markdown.as_deref().is_some_and(|it| it.contains("途中で")),
        "受け取ったところまで残る: {text:?}"
    );
    assert!(
        text.fallback_reason
            .as_deref()
            .is_some_and(|it| it.contains("途中で切れました")),
        "切れたと言うこと: {text:?}"
    );
    assert!(recorder.streamed().contains("途中で"));
}

#[test]
fn keeps_going_when_the_response_is_empty() {
    let server = MockServer::always(Canned::sse(String::new()));
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    // **空でも結果の枠は残る。** 何も返らなかったことが読めること。
    let text = run.files[0].text.as_ref().expect("結果の枠は残ること");
    assert_eq!(text.markdown.as_deref(), Some(""));
    assert!(text.fallback_reason.is_some());
    assert!(run.files[0].error.is_none(), "空の応答は通信の失敗ではない");
}

#[test]
fn one_failing_file_does_not_stop_the_others() {
    let server = MockServer::start(|request| {
        if request.body.contains("追加.txt") {
            Canned::json(500, r#"{"error":{"message":"落ちました"}}"#)
        } else {
            Canned::sse_content(GOOD_JSON)
        }
    });
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(TEXT_FILES);

    assert_eq!(run.failed, 1, "失敗は 1 件だけ");
    let failed = run
        .files
        .iter()
        .find(|it| it.path == "追加.txt")
        .expect("失敗したファイルも一覧に残る");
    assert!(failed.error.is_some());
    assert!(
        failed
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("落ちました"),
        "接続先の言い分を引き上げること: {:?}",
        failed.error
    );
    assert_eq!(
        run.files.iter().filter(|it| it.text.is_some()).count(),
        TEXT_FILES.len() - 1,
        "残りは成功する"
    );
    assert!(run.summary.is_some(), "1 件失敗しても全体サマリは作る");
}

#[test]
fn tells_the_summary_how_many_files_failed() {
    let server = MockServer::start(|request| {
        if request.body.contains("追加.txt") {
            Canned::json(500, "{}")
        } else {
            Canned::sse_content(GOOD_JSON)
        }
    });
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(TEXT_FILES);
    assert_eq!(run.failed, 1);

    // 最後の要求がサマリ。**差分ではなく各ファイルの要約を渡す。**
    let summary = server.last();
    assert!(
        summary.body.contains("1 件のファイルはレビューに失敗しました"),
        "失敗件数を伝えること: {}",
        summary.body
    );
    assert!(
        !summary.body.contains("@@ -"),
        "サマリに差分を渡さないこと: {}",
        summary.body
    );
    assert!(
        summary.body.contains("要約です"),
        "各ファイルの要約を渡すこと: {}",
        summary.body
    );
}

// ---- 中止（DESIGN.md §10.7）--------------------------------------------------

#[test]
fn cancelling_mid_stream_folds_up_quickly() {
    // **1 バイトずつ**返す。中止を割り込ませる隙を作る。
    let long: String = (0..400).map(|_| sse_delta("あ")).collect();
    let server = MockServer::always(
        Canned::sse(format!("{long}{SSE_DONE}")).in_chunks(1, Duration::from_millis(2)),
    );
    let harness = Harness::new(&server.base_url());

    let cancel = Cancel::new();
    let stopper = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        stopper.cancel();
    });

    let started = std::time::Instant::now();
    let recorder = Recorder::default();
    let run = harness.run_with(TEXT_FILES, &cancel, &recorder);
    let elapsed = started.elapsed();

    assert!(run.cancelled, "中止として返ること");
    assert!(
        elapsed < Duration::from_secs(20),
        "全部を読み切らずに畳むこと（{elapsed:?}）"
    );
    assert!(run.summary.is_none(), "中止したら全体サマリは作らない");
    assert!(
        server.requests().len() < TEXT_FILES.len(),
        "残りのファイルへ進まないこと"
    );
}

#[test]
fn cancelling_between_files_does_not_start_the_next_one() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());

    // 1 件目が終わった時点で中止する。
    struct StopAfterFirst {
        cancel: Cancel,
    }
    impl ReviewSink for StopAfterFirst {
        fn report(&self, event: ReviewEvent) {
            if let ReviewEvent::FileDone { .. } = event {
                self.cancel.cancel();
            }
        }
    }

    let cancel = Cancel::new();
    let sink = StopAfterFirst {
        cancel: cancel.clone(),
    };
    let run = harness.run_with(TEXT_FILES, &cancel, &sink);

    assert!(run.cancelled);
    assert_eq!(server.requests().len(), 1, "2 件目を始めないこと");
    assert_eq!(run.files.len(), 1, "終わった 1 件だけが残る");
}

// ---- 秘匿情報（CLAUDE.md §4）------------------------------------------------

/// **利用者が入れうる最短・最長・空を列挙する**（T-20 の申し送り）。
#[test]
fn never_leaks_the_key_even_when_the_server_echoes_it() {
    for key in ["", "a", "sk-example-0123456789", &"x".repeat(512)] {
        let echo = MockServer::start(|request| {
            let said = request
                .header("authorization")
                .unwrap_or("(no authorization header)")
                .to_string();
            Canned::sse_content(&format!("{{\"summary\":\"{said}\",\"findings\":[]}}"))
        });
        let mut harness = Harness::new(&echo.base_url());
        harness.api_key = key.to_string();

        let recorder = Recorder::default();
        let run = harness.run_with(&["追加.txt"], &Cancel::new(), &recorder);
        let shown = visible(&run, &recorder);

        if !key.is_empty() {
            // **echo された場所を名指しで見る。** 1 文字のキー（`a`）を
            // `contains(key)` で見ると、他の語に含まれる `a` で必ず真になり、
            // テストが何も確かめないまま落ちる（T-20 の「端の値」の裏返し）。
            assert!(
                !shown.contains(&format!("Bearer {key}")),
                "キー（{} 文字）がそのまま結果に出ている",
                key.chars().count()
            );
            // 伏せ方は 1 つではない。`sk-` で始まるキーは `redact` の規則が
            // `sk-***` にし、そうでないものは `mask_key` が `***` にする。
            // **どちらで伏せられたかは問わない。**
            assert!(
                shown.contains("***"),
                "伏せ字になっていること（キー {} 文字）: {shown}",
                key.chars().count()
            );
            // 偶然の一致が起きない長さのキーは、どこにも現れないことまで見る。
            if key.chars().count() >= 8 {
                assert!(!shown.contains(key), "キーが結果のどこかに出ている");
            }
        }
        // **応答が壊れていないこと。** 1 文字のキーで JSON のキー名まで
        // 潰れた事故（T-20）を、この経路でも見る。
        assert!(
            run.files[0].text.is_some(),
            "キー {} 文字で応答が読めなくなった",
            key.chars().count()
        );
    }
}

#[test]
fn masks_a_key_split_across_two_chunks() {
    let key = "supersecretkey-0123456789";
    // 1 バイトずつ返す。**キーは必ずチャンクをまたぐ。**
    let body = format!(
        "{}{SSE_DONE}",
        sse_delta(&format!("使ったキーは {key} です"))
    );
    let server = MockServer::always(Canned::sse(body).in_chunks(1, Duration::ZERO));

    let mut harness = Harness::new(&server.base_url());
    harness.api_key = key.to_string();

    let recorder = Recorder::default();
    let run = harness.run_with(&["追加.txt"], &Cancel::new(), &recorder);

    let shown = visible(&run, &recorder);
    assert!(!shown.contains(key), "チャンクに割れたキーが漏れている");
    assert!(
        recorder.streamed().contains("使ったキーは"),
        "本文そのものは流れること: {}",
        recorder.streamed()
    );
}

#[test]
fn sends_no_authorization_header_when_the_key_is_empty() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());
    harness.run(&["追加.txt"]);

    assert!(
        server.last().header("authorization").is_none(),
        "キーが無いときは Authorization を付けない（Ollama は認証不要）"
    );
}

// ---- 渡すものと渡さないもの（CLAUDE.md §7）-----------------------------------

#[test]
fn an_untrusted_skill_body_never_reaches_the_prompt() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());
    harness.write_repo_skill(
        "evil.md",
        &format!("---\nname: evil\ndescription: わるいもの\n---\n\n{LEAK_MARKER}\n"),
    );

    let (run, recorder) = harness.run(&["追加.txt"]);

    let sent: String = server
        .requests()
        .iter()
        .map(|it| it.body.clone())
        .collect();
    assert!(
        !sent.contains(LEAK_MARKER),
        "決めていない skill の本文がプロンプトへ出ている"
    );
    // 画面へ流れる側にも出ない（結果は接続先が作るので当然だが、まとめて見る）。
    assert!(!visible(&run, &recorder).contains(LEAK_MARKER));
    assert!(
        !run.skills.iter().any(|it| it.name == "evil"),
        "使う観点として数えないこと"
    );
}

#[test]
fn a_skill_that_does_not_match_the_path_is_not_sent() {
    let server = serving(GOOD_JSON);
    let mut harness = Harness::new(&server.base_url());
    harness.without_built_in();
    harness.write_global_skill(
        "rust-only.md",
        "---\nname: rust-only\ndescription: Rust だけ\nglobs: [\"**/*.rs\"]\n---\n\nRUST-ONLY-BODY\n",
    );
    harness.write_global_skill(
        "text-only.md",
        "---\nname: text-only\ndescription: テキストだけ\nglobs: [\"**/*.txt\"]\n---\n\nTEXT-ONLY-BODY\n",
    );

    harness.run(&["追加.txt"]);

    let sent = server.requests()[0].body.clone();
    assert!(sent.contains("TEXT-ONLY-BODY"), "当たる観点は渡す: {sent}");
    assert!(
        !sent.contains("RUST-ONLY-BODY"),
        "当たらない観点は渡さない: {sent}"
    );
}

#[test]
fn sends_the_diff_and_not_the_whole_file() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());

    harness.run(&["sub/keep.txt"]);

    let sent = server.requests()[0].body.clone();
    assert!(sent.contains("@@ -"), "unified diff を渡すこと: {sent}");
    assert!(sent.contains("sub/keep.txt"), "パスを渡すこと");
    // `sub/keep.txt` は `x` に `y` `z` を足した変更。**文脈行として `x` は出る**が、
    // 差分の形（先頭の空白）を伴わない全文は渡さない。
    assert!(
        sent.matches("@@ -").count() >= 1,
        "hunk の形で渡すこと: {sent}"
    );
}

#[test]
fn sends_the_commit_message_only_for_a_single_commit() {
    let server = serving(GOOD_JSON);
    let mut harness = Harness::new(&server.base_url());

    harness.run(&["追加.txt"]);
    assert!(
        server.requests()[0]
            .body
            .contains("変更の種類ひととおり"),
        "コミットとその親ならメッセージを渡す: {}",
        server.requests()[0].body
    );

    // 同じ 2 点を `A...B` として比べると、**何のメッセージか決まらない**ので渡さない。
    let DiffSource::Range { parent, sha, .. } = harness.source.clone() else {
        panic!("Range のはず");
    };
    harness.source = DiffSource::Range {
        parent,
        sha,
        symmetric: true,
    };
    let before = server.requests().len();
    harness.run(&["追加.txt"]);
    assert!(
        !server.requests()[before]
            .body
            .contains("変更の種類ひととおり"),
        "2 点比較ではコミットメッセージを渡さない: {}",
        server.requests()[before].body
    );
}

#[test]
fn does_not_send_a_commit_message_for_two_unrelated_points() {
    let server = serving(GOOD_JSON);
    let mut harness = Harness::new(&server.base_url());

    // 親子でない 2 点（HEAD と HEAD 自身の親を入れ替える）。
    let repo = harness.repo.clone();
    let root = git_output(&repo, &["rev-list", "--max-parents=0", "HEAD"]);
    let head = git_output(&repo, &["rev-parse", "HEAD"]);
    harness.source = DiffSource::Range {
        // **HEAD を「親」として渡す。** 実際には親ではないので、メッセージは渡らない。
        parent: Some(head),
        sha: root,
        symmetric: false,
    };

    harness.run(&["消える.txt"]);
    let sent = server.requests()[0].body.clone();
    assert!(
        !sent.contains("変更の種類ひととおり") && !sent.contains("最初のコミット"),
        "親子でない 2 点にコミットメッセージを付けないこと: {sent}"
    );
}

// ---- 投入単位と分割（DESIGN.md §10.5）----------------------------------------

#[test]
fn plan_keeps_binary_files_in_the_list_with_a_reason() {
    let server = serving(GOOD_JSON);
    let harness = Harness::new(&server.base_url());

    let plan = harness.plan();
    let binary = plan
        .files
        .iter()
        .find(|it| it.path == "blob.bin")
        .expect("バイナリも一覧から消さないこと");
    assert!(
        binary
            .skipped
            .as_deref()
            .is_some_and(|it| it.contains("バイナリ")),
        "投げない理由を出すこと: {binary:?}"
    );
    assert!(plan.blocked.is_none(), "実行はできる");
    assert!(plan.tokens_estimate > 0, "概算トークン数を出すこと");
}

#[test]
fn plan_is_blocked_with_a_readable_reason_when_no_skill_is_in_use() {
    let server = serving(GOOD_JSON);
    let mut harness = Harness::new(&server.base_url());
    harness.without_built_in();

    let plan = harness.plan();
    assert!(
        plan.blocked
            .as_deref()
            .is_some_and(|it| it.contains("レビュー観点")),
        "押せない理由を出すこと: {:?}",
        plan.blocked
    );
    assert!(!plan.files.is_empty(), "ファイル一覧は消さないこと");
}

#[test]
fn splits_a_big_file_into_parts_and_merges_the_result() {
    let repo = big_repo();
    let server = serving(GOOD_JSON);
    let mut harness = Harness::with_repo(&server.base_url(), repo.path().join("repo"));
    // **文脈長の狭い接続先**を模す。生成済みリポジトリのファイルは、
    // 既定の 32k ではどれも 1 回に収まる。
    harness.profile.context_window = 2_048;
    harness.profile.max_tokens = 512;

    let plan = harness.plan();
    let big = plan
        .files
        .iter()
        .find(|it| it.path == "big.txt")
        .expect("big.txt があること");
    assert!(
        big.parts >= 2,
        "予算を超えるファイルは分けて投げる: {big:?}"
    );

    let (run, _) = harness.run(&["big.txt"]);
    assert_eq!(run.files.len(), 1, "分けても結果は 1 件にまとまる");
    assert_eq!(run.files[0].parts, big.parts);
    assert_eq!(
        server.requests().len(),
        big.parts + 1,
        "分割の回数だけ投げ、最後にサマリ 1 回"
    );

    let text = run.files[0].text.as_ref().expect("結果があること");
    assert_eq!(
        text.findings.len(),
        big.parts,
        "分割した各回の指摘をすべて残す"
    );
    assert!(
        server.requests()[0].body.contains("回に分けています"),
        "全体を見ていないことをモデルへ伝える: {}",
        server.requests()[0].body
    );
}

#[test]
fn runs_three_files_at_once_when_asked() {
    // 応答を遅らせて重なりを作る。
    let server = MockServer::always(
        Canned::sse_content(GOOD_JSON).in_chunks(8, Duration::from_millis(20)),
    );
    let mut harness = Harness::new(&server.base_url());
    harness.concurrency = 3;

    harness.run(TEXT_FILES);

    assert!(
        server.peak_concurrency() >= 2,
        "並列度 3 で同時に走ること（実測 {}）",
        server.peak_concurrency()
    );
}

#[test]
fn runs_one_at_a_time_by_default() {
    let server = MockServer::always(
        Canned::sse_content(GOOD_JSON).in_chunks(8, Duration::from_millis(10)),
    );
    let harness = Harness::new(&server.base_url());
    assert_eq!(harness.concurrency, 1);

    harness.run(TEXT_FILES);

    assert_eq!(
        server.peak_concurrency(),
        1,
        "既定は逐次（DESIGN.md §10.7）"
    );
}

// ---- 400 の扱い（決定 4）------------------------------------------------------

#[test]
fn drops_response_format_once_when_the_server_complains() {
    let server = MockServer::start(|request| {
        if request.body.contains("response_format") {
            Canned::json(
                400,
                r#"{"error":{"message":"response_format is not supported"}}"#,
            )
        } else {
            Canned::sse_content(GOOD_JSON)
        }
    });
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt", "sub/keep.txt"]);

    assert_eq!(run.failed, 0, "外して投げ直せば通ること");
    let bodies: Vec<String> = server.requests().iter().map(|it| it.body.clone()).collect();
    assert!(bodies[0].contains("response_format"), "1 回目は付けて投げる");
    assert!(!bodies[1].contains("response_format"), "2 回目は外して投げる");
    // **以後は最初から付けない。** 全ファイルで同じ 400 を踏み直さない。
    assert!(
        bodies[2..].iter().all(|it| !it.contains("response_format")),
        "2 ファイル目以降も外したまま: {bodies:?}"
    );
    assert_eq!(
        bodies.len(),
        4,
        "1 件目は 2 回、2 件目は 1 回、サマリ 1 回: {bodies:?}"
    );
}

#[test]
fn does_not_retry_a_400_it_cannot_explain() {
    let server = MockServer::always(Canned::json(
        400,
        r#"{"error":{"message":"model not found"}}"#,
    ));
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);

    assert_eq!(run.failed, 1);
    assert_eq!(
        server.requests().len(),
        1,
        "見立てが立たない 400 は投げ直さない。         1 件も読めていないので全体サマリも投げない"
    );
    assert!(run.files[0]
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("model not found"));
}

#[test]
fn reads_a_server_that_ignores_stream_and_returns_plain_json() {
    // `stream: true` を無視して普通の chat completion を返すサーバ。
    let body = serde_json::json!({
        "id": "1",
        "model": "test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": GOOD_JSON},
                     "finish_reason": "stop"}]
    })
    .to_string();
    let server = MockServer::always(Canned::json(200, body));
    let harness = Harness::new(&server.base_url());

    let (run, recorder) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("読めること");
    assert_eq!(text.summary, "要約です");
    assert!(
        recorder.streamed().contains("要約です"),
        "画面へも届くこと: {}",
        recorder.streamed()
    );
}

#[test]
fn tells_the_finish_reason_when_the_answer_was_cut_by_max_tokens() {
    let server = MockServer::always(Canned::sse(format!(
        "{}{}{SSE_DONE}",
        sse_delta("途中まで書いた"),
        sse_finish("length")
    )));
    let harness = Harness::new(&server.base_url());

    let (run, _) = harness.run(&["追加.txt"]);
    let text = run.files[0].text.as_ref().expect("結果を捨てないこと");
    assert!(
        text.fallback_reason
            .as_deref()
            .is_some_and(|it| it.contains("max tokens")),
        "何をすればいいかまで書くこと: {text:?}"
    );
}

// ---- 実サーバ（目視用）--------------------------------------------------------

/// **画面が無いぶん、実物へ 1 回流しておく**（T-18 の「緑でも動かない」対策）。
///
/// ```text
/// GIVSONER_LLM_BASE_URL=http://localhost:11434/v1 \
/// GIVSONER_LLM_MODEL=qwen2.5-coder:14b \
/// cargo test --test review -- --ignored --nocapture
/// ```
#[test]
#[ignore = "実サーバが要る。GIVSONER_LLM_BASE_URL を設定して --ignored で走らせる"]
fn talks_to_a_real_server() {
    let base_url = std::env::var("GIVSONER_LLM_BASE_URL")
        .expect("GIVSONER_LLM_BASE_URL を設定してください（例: http://localhost:11434/v1）");
    let model = std::env::var("GIVSONER_LLM_MODEL").unwrap_or_else(|_| "qwen2.5-coder:14b".into());

    let mut harness = Harness::new(&base_url);
    harness.profile.model = model;
    harness.api_key = std::env::var("GIVSONER_LLM_API_KEY").unwrap_or_default();

    let recorder = Recorder::default();
    let run = harness.run_with(&["sub/keep.txt", "追加.txt"], &Cancel::new(), &recorder);

    println!("--- 流れてきた本文 ---\n{}", recorder.streamed());
    println!("--- 結果 ---\n{run:#?}");

    assert_eq!(run.failed, 0, "失敗 0 件であること: {run:#?}");
    assert!(
        !recorder.streamed().is_empty(),
        "ストリームが少しずつ届くこと"
    );
    assert!(run.summary.is_some(), "全体サマリが返ること");
}

// ---- 道具 --------------------------------------------------------------------

/// 予算を超える大きさのファイルを 1 つ持つリポジトリ。
///
/// 生成済みリポジトリのファイルは小さすぎて hunk 分割に届かない。
/// **ここは `src` の外なので `Command::new` を使ってよい**（`tests/common/mod.rs` と同じ）。
fn big_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();

    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .expect("git を起動できること");
        assert!(
            output.status.success(),
            "git {args:?} が失敗: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };

    git(&["init", "--quiet", "-b", "main"]);
    git(&["config", "user.name", "Givsoner Test"]);
    git(&["config", "user.email", "test@example.invalid"]);
    git(&["config", "commit.gpgsign", "false"]);

    // **離れた場所を変える。** 1 つの hunk にまとまると分割されない。
    let before: String = (0..400).map(|i| format!("line {i} original\n")).collect();
    std::fs::write(repo.join("big.txt"), &before).unwrap();
    git(&["add", "-A"]);
    git(&["commit", "--quiet", "-m", "最初のコミット"]);

    let after: String = (0..400)
        .map(|i| {
            if i % 40 == 0 {
                format!("line {i} CHANGED with a rather long replacement line to spend tokens\n")
            } else {
                format!("line {i} original\n")
            }
        })
        .collect();
    std::fs::write(repo.join("big.txt"), &after).unwrap();
    git(&["add", "-A"]);
    git(&["commit", "--quiet", "-m", "大きな変更"]);

    dir
}
