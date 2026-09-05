//! LLM への接続。**OpenAI 互換 API 1 系統のみ**（CLAUDE.md §7）。
//!
//! Ollama も `http://localhost:11434/v1` で扱う。ネイティブ API (`/api/chat`) は実装しない。
//!
//! - `client` — 接続テストとモデル一覧。T-22 のレビュー実行もここを通す
//! - `skill` — レビュー観点の読み込みと**信頼モデル**。
//!   **プロンプトへ渡せる skill 本文が出てくるのは `SkillEntry::usable_body` だけ**
//! - `review` — レビューの計画と実行。**HTTP は `client` を通し、
//!   skill 本文は `usable_body()` からしか取らない**
//! - `review` — レビューの計画と実行。**HTTP は `client` を通し、
//!   skill 本文は `usable_body()` からしか取らない**
//!
//! **API キーの平文に触るのは [`crate::secret`] とこのモジュールだけ**であり、
//! ここから外へ出る文字列（エラー・生の応答）は必ずマスクしてから返す（CLAUDE.md §4）。

pub mod client;
pub mod review;
pub mod skill;
