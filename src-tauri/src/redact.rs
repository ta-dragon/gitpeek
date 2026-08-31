//! 秘匿情報のマスキング。
//!
//! **画面表示とログ出力は必ずこのモジュールを通す。**
//! `git remote -v` の出力や git の stderr には、認証情報が URL に埋まっていると平文で出る。
//! それをそのまま記録すると %APPDATA% に平文トークンが残る。
//!
//! 詳細は docs/DESIGN.md §13.4 を参照。

use std::sync::LazyLock;

use regex::Regex;

type Rule = (Regex, &'static str);

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        // URL 内の認証情報: scheme://user:secret@host
        (
            Regex::new(r"([A-Za-z][A-Za-z0-9+.\-]*://)([^/\s:@]+):([^/\s@]+)@").unwrap(),
            "${1}${2}:***@",
        ),
        // Authorization: Bearer <token>
        (
            Regex::new(r"(?i)(authorization\s*:\s*bearer\s+)[A-Za-z0-9._\-]+").unwrap(),
            "${1}***",
        ),
        // OpenAI 系
        (Regex::new(r"sk-[A-Za-z0-9_\-]{16,}").unwrap(), "sk-***"),
        // GitHub 系 (ghp_ / gho_ / ghu_ / ghs_ / ghr_)
        (Regex::new(r"gh[pousr]_[A-Za-z0-9]{20,}").unwrap(), "gh_***"),
        // GitLab 系
        (Regex::new(r"glpat-[A-Za-z0-9_\-]{16,}").unwrap(), "glpat-***"),
        // key = value 形式
        (
            Regex::new(
                r#"(?i)((?:api[_\-]?key|access[_\-]?token|auth[_\-]?token|secret)\s*[=:]\s*)["']?[A-Za-z0-9._\-]{12,}"#,
            )
            .unwrap(),
            "${1}***",
        ),
    ]
});

/// 秘匿情報をマスクした文字列を返す。
pub fn redact(input: &str) -> String {
    let mut out = input.to_string();
    for (pattern, replacement) in RULES.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_credentials_in_url() {
        assert_eq!(
            redact("https://tatsu:ghp_secretvalue@github.com/o/r.git"),
            "https://tatsu:***@github.com/o/r.git"
        );
    }

    #[test]
    fn masks_bare_tokens() {
        assert_eq!(
            redact("token=ghp_abcdefghijklmnopqrstuvwxyz01"),
            "token=gh_***"
        );
        assert_eq!(redact("sk-abcdefghijklmnopqrstuvwxyz"), "sk-***");
        assert_eq!(
            redact("glpat-abcdefghijklmnopqrst"),
            "glpat-***"
        );
    }

    #[test]
    fn masks_key_value_pairs() {
        assert_eq!(
            redact("api_key: abcdefghijklmnopqrst"),
            "api_key: ***"
        );
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        // コミット SHA や通常の URL を壊してはいけない。
        let sha = "9de57d3a1b2c3d4e5f60718293a4b5c6d7e8f901";
        assert_eq!(redact(sha), sha);
        assert_eq!(
            redact("https://github.com/owner/repo.git"),
            "https://github.com/owner/repo.git"
        );
        assert_eq!(
            redact("http://localhost:11434/v1"),
            "http://localhost:11434/v1"
        );
    }
}
