//! API キーの保管（Windows 資格情報マネージャー）。
//!
//! **キーの平文に触ってよいのはこのモジュールだけ**（CLAUDE.md §4）。
//! `settings.json` に書くのは参照キー（`credential_key`）だけであり、値そのものは
//! ここを通して OS の資格情報マネージャーへ入れる。
//!
//! 守っていること:
//!
//! - **キーの値を戻り値以外へ出さない。** `Debug` に載せない、ログに書かない、
//!   エラーメッセージへ混ぜない。エラーは「保存できませんでした」までしか言わない
//! - サービス名は [`SERVICE`]、ユーザー名は `credential_key` に固定する。
//!   `credential_key` はプロファイル作成時に採番して以後変えないので、
//!   名前や base URL を変えても資格情報を追いかけ直さなくて済む
//! - プロファイルを消したら資格情報も消す。消し忘れると資格情報マネージャーに孤児が残る

use keyring::{Entry, Error};

/// 資格情報マネージャーに登録するサービス名。`%APPDATA%` のフォルダ名と揃えてある。
pub const SERVICE: &str = "com.tatsu.gitpeek";

/// `credential_key` の採番。プロファイル 1 つにつき 1 度だけ呼ぶ。
///
/// 名前や base URL ではなく uuid にしてあるのは、**利用者が名前を変えても
/// 資格情報を追いかけ直さなくて済むようにする**ため。
pub fn new_credential_key() -> String {
    format!("llm/{}", uuid::Uuid::new_v4())
}

/// 資格情報マネージャーへの入口。
///
/// サービス名を持たせてあるのは**テストが本番の項目を汚さないようにする**ためだけで、
/// アプリからは常に [`Secrets::new`]（＝[`SERVICE`]）を使う。
pub struct Secrets {
    service: String,
}

impl Default for Secrets {
    fn default() -> Self {
        Self::new()
    }
}

impl Secrets {
    /// アプリが使う唯一の形。サービス名は [`SERVICE`] に固定される。
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    /// **テスト専用。** 本番の資格情報を上書きしないよう、別のサービス名で開く。
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &str) -> Result<Entry, String> {
        Entry::new(&self.service, key).map_err(|error| unavailable(&error))
    }

    /// キーを保存する（既にあれば上書き）。
    pub fn save(&self, key: &str, secret: &str) -> Result<(), String> {
        self.entry(key)?
            .set_password(secret)
            // **`error` を混ぜない。** 保存に失敗した値が文字列化される経路を作らない。
            .map_err(|error| match error {
                Error::NoDefaultStore | Error::Invalid(..) => unavailable(&error),
                _ => "API キーを Windows 資格情報マネージャーへ保存できませんでした。".to_string(),
            })
    }

    /// キーを読む。**登録が無いのは失敗ではない**（Ollama のようにキー不要の接続先がある）。
    pub fn load(&self, key: &str) -> Result<Option<String>, String> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(Error::NoDefaultStore) | Err(Error::Invalid(..)) => {
                Err(unavailable(&Error::NoDefaultStore))
            }
            Err(_) => {
                Err("API キーを Windows 資格情報マネージャーから読み出せませんでした。".to_string())
            }
        }
    }

    /// キーを消す。**もともと無ければ成功**（削除の再実行で失敗させない）。
    pub fn delete(&self, key: &str) -> Result<(), String> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(Error::NoDefaultStore) | Err(Error::Invalid(..)) => {
                Err(unavailable(&Error::NoDefaultStore))
            }
            Err(_) => Err("API キーを Windows 資格情報マネージャーから削除できませんでした。\
                資格情報マネージャーを開いて手で消してください。"
                .to_string()),
        }
    }

    /// キーが登録済みかどうかだけを見る。**値は返さない。**
    ///
    /// 画面の「保存済み」表示に使う。既存のキーを読み出して見せてはいけない。
    pub fn has(&self, key: &str) -> bool {
        matches!(self.load(key), Ok(Some(_)))
    }
}

/// 資格情報マネージャーそのものが使えないときの文言。
///
/// `error` を書き出さないのは、**この経路にキーの値が乗らないと言い切る**ため。
fn unavailable(_error: &Error) -> String {
    "Windows 資格情報マネージャーを利用できません。API キーを保存できないので、\
     キーの要らない接続先（Ollama など）を使うか、Windows にサインインし直してください。"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{new_credential_key, Secrets, SERVICE};

    #[test]
    fn credential_keys_are_unique_and_namespaced() {
        let first = new_credential_key();
        let second = new_credential_key();
        assert!(first.starts_with("llm/"), "{first}");
        assert_ne!(first, second, "プロファイルごとに別のキーを採番する");
    }

    #[test]
    fn the_service_name_matches_the_app_data_folder() {
        assert_eq!(SERVICE, "com.tatsu.gitpeek");
        assert_eq!(Secrets::new().service, SERVICE);
    }
}
