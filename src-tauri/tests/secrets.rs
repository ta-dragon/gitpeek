//! 資格情報の保管の結合テスト（T-20）。
//!
//! **本物の Windows 資格情報マネージャーを触る。** モックにすると
//! 「保存できたつもりで何も残っていない」形をそのまま通してしまう。
//!
//! 本番の項目を汚さないよう、サービス名は [`TEST_SERVICE`] を使い、
//! キーはテストごとに採番して**必ず後始末する**。

use gitpeek_lib::secret::{new_credential_key, Secrets, SERVICE};
use gitpeek_lib::store::paths::StorePaths;
use gitpeek_lib::store::settings::{self, LlmProfile, Settings};

/// 本番と別のサービス名。ここを本番と同じにしてはいけない。
const TEST_SERVICE: &str = "com.tatsu.gitpeek.test";

fn vault() -> Secrets {
    assert_ne!(TEST_SERVICE, SERVICE, "テストが本番の項目を触ってはいけない");
    Secrets::with_service(TEST_SERVICE)
}

/// 後始末を必ず走らせる。assert で落ちても資格情報を残さない。
struct Scoped {
    vault: Secrets,
    key: String,
}

impl Scoped {
    fn new() -> Self {
        Self {
            vault: vault(),
            key: new_credential_key(),
        }
    }
}

impl Drop for Scoped {
    fn drop(&mut self) {
        let _ = self.vault.delete(&self.key);
    }
}

#[test]
fn saves_loads_and_deletes_a_credential() {
    let scoped = Scoped::new();
    let secret = "sk-round-trip-0123456789";

    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        None,
        "採番したてのキーには何も無い"
    );
    assert!(!scoped.vault.has(&scoped.key));

    scoped.vault.save(&scoped.key, secret).unwrap();
    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        Some(secret.to_string()),
        "保存した値がそのまま戻ること"
    );
    assert!(scoped.vault.has(&scoped.key));

    scoped.vault.delete(&scoped.key).unwrap();
    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        None,
        "削除後に読むと None"
    );
    assert!(!scoped.vault.has(&scoped.key));
}

#[test]
fn overwrites_an_existing_credential() {
    let scoped = Scoped::new();
    scoped.vault.save(&scoped.key, "first").unwrap();
    scoped.vault.save(&scoped.key, "second").unwrap();

    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        Some("second".to_string())
    );
}

/// **削除の再実行で失敗させない。** プロファイル削除は「消し忘れない」ほうが大事で、
/// もともと無かった場合にエラーにすると、消えているのに消せないと表示される。
#[test]
fn deleting_twice_is_not_an_error() {
    let scoped = Scoped::new();
    scoped.vault.save(&scoped.key, "value").unwrap();

    scoped.vault.delete(&scoped.key).unwrap();
    scoped.vault.delete(&scoped.key).unwrap();
}

/// キーは日本語でも通る（`name` を変えても参照キーは変えない設計だが、念のため）。
#[test]
fn round_trips_a_multibyte_secret() {
    let scoped = Scoped::new();
    let secret = "秘密の鍵-αβγ";
    scoped.vault.save(&scoped.key, secret).unwrap();

    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        Some(secret.to_string())
    );
}

/// **`settings.json` に平文のキーが 1 文字も現れないこと。**
///
/// 保存の経路（プロファイルは `settings.json`、キーは資格情報マネージャー）を
/// 実際に両方走らせてから、ファイルを読んで確かめる。
#[test]
fn the_settings_file_never_holds_the_key_in_plain_text() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StorePaths::new(dir.path());
    paths.ensure().unwrap();

    let scoped = Scoped::new();
    let secret = "sk-plaintext-must-not-appear-0123456789";

    let mut stored = Settings::default();
    stored.llm_profiles.push(LlmProfile {
        id: "p1".to_string(),
        name: "テスト接続先".to_string(),
        base_url: "https://api.example.com/v1".to_string(),
        model: "gpt-4o-mini".to_string(),
        credential_key: scoped.key.clone(),
        ..LlmProfile::default()
    });

    settings::save(&paths, &stored).unwrap();
    scoped.vault.save(&scoped.key, secret).unwrap();

    let text = std::fs::read_to_string(paths.settings_file()).unwrap();
    assert!(
        !text.contains(secret),
        "settings.json に平文のキーがある: {text}"
    );
    assert!(!text.contains("apiKey"), "{text}");
    assert!(
        text.contains(&scoped.key),
        "参照キーだけは書く（資格情報を引き当てるため）: {text}"
    );
    // キーは資格情報マネージャー側にある。
    assert_eq!(
        scoped.vault.load(&scoped.key).unwrap(),
        Some(secret.to_string())
    );
}
