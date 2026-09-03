//! 文字コードの判別とデコード、改行コードの検出（docs/DESIGN.md §9）。
//!
//! **閲覧対象には Linux 由来のソースが含まれる**前提なので、UTF-8 以外が来る。
//! `git::exec::run` が返す `GitOutput.stdout` は生バイト列であり、
//! **`stdout_lossy` をファイル内容に使ってはいけない**（§9.1）。ここを通すこと。
//!
//! 判別は**順序で決める**。統計的推定（chardet 系）は入れない — 誤ると黙って化けるうえ、
//! 手動上書きがあれば足りる。

use serde::{Deserialize, Serialize};

/// バイナリ判定で見るバイト数。
///
/// **git 自身の判定と同じ範囲**にしてある（git は先頭 8000 バイトに NUL があれば
/// バイナリとみなす）。ここを広げると、git が差分を出したファイルをこちらだけが
/// バイナリ扱いする、という食い違いが起きる。
const BINARY_SNIFF_LEN: usize = 8000;

/// 判別・指定できる文字コード。
///
/// この 3 つで打ち止めにする（§9.1）。BOM 付き UTF-16 は NUL を含むので
/// バイナリとして落ちる。git も同じ扱いなので v1 ではそれでよい。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    ShiftJis,
    EucJp,
}

impl TextEncoding {
    fn codec(self) -> &'static encoding_rs::Encoding {
        match self {
            // Windows-31J（NEC/IBM 拡張込み）。日本語 Windows で作られたファイルはこちら。
            TextEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
            TextEncoding::EucJp => encoding_rs::EUC_JP,
            TextEncoding::Utf8 => encoding_rs::UTF_8,
        }
    }
}

/// 試す順序。**UTF-8 が先**。UTF-8 として妥当なバイト列を Shift_JIS と読める場合があるため、
/// 順序を入れ替えてはいけない。
const CANDIDATES: [TextEncoding; 3] = [
    TextEncoding::Utf8,
    TextEncoding::ShiftJis,
    TextEncoding::EucJp,
];

/// 改行コードの種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
}

/// 改行コードの内訳。**CRLF を CR と LF に二重計上しない。**
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEndingCounts {
    pub lf: u32,
    pub crlf: u32,
    pub cr: u32,
}

impl LineEndingCounts {
    /// 最も多い改行コード。1 つも無ければ `None`（1 行だけのファイル）。
    ///
    /// 同数のときは LF → CRLF → CR の順で選ぶ。混在の警告が出ている状況なので、
    /// どれを選んでも「代表」でしかない。
    pub fn dominant(&self) -> Option<LineEnding> {
        let max = self.lf.max(self.crlf).max(self.cr);
        if max == 0 {
            return None;
        }
        if self.lf == max {
            Some(LineEnding::Lf)
        } else if self.crlf == max {
            Some(LineEnding::Crlf)
        } else {
            Some(LineEnding::Cr)
        }
    }

    /// 2 種類以上が混ざっているか。
    ///
    /// **Linux 用シェルスクリプトに CRLF が混入すると実行時に壊れる**ので、
    /// 目視で気付けることに実利がある（§9.2）。
    pub fn mixed(&self) -> bool {
        let kinds = u8::from(self.lf > 0) + u8::from(self.crlf > 0) + u8::from(self.cr > 0);
        kinds > 1
    }
}

/// デコード結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedText {
    pub text: String,
    pub encoding: TextEncoding,
    /// UTF-8 BOM を取り除いたか。**残すと差分の先頭に U+FEFF が出る。**
    pub had_bom: bool,
    /// 置換文字（U+FFFD）が出たか。手動上書きを間違えたときの合図になる。
    pub lossy: bool,
    /// **渡されたバイト列そのもの**に対する数え上げ。
    ///
    /// 何を渡すかは呼び出し側が決める。diff 出力をまるごと渡すと、ヘッダ行が常に LF
    /// なので CRLF のファイルが全部「混在」になる。**内容行だけを渡すこと。**
    pub line_endings: LineEndingCounts,
}

/// デコードの結果。バイナリはデコードしない。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Decoded {
    /// NUL バイトを含んでいた。`size` は元のバイト数。
    Binary { size: usize },
    Text(DecodedText),
}

/// NUL バイトの有無でバイナリを判定する（先頭 [`BINARY_SNIFF_LEN`] バイトのみ）。
pub fn is_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_LEN)];
    head.contains(&0)
}

/// 文字コードを判別する。**BOM を取り除いた後のバイト列を渡すこと。**
///
/// 置換なしで最初に読めたものを採る。どれも読めなければ `None`。
fn detect(bytes: &[u8]) -> Option<TextEncoding> {
    CANDIDATES.into_iter().find(|candidate| {
        candidate
            .codec()
            .decode_without_bom_handling_and_without_replacement(bytes)
            .is_some()
    })
}

/// 生バイト列を文字列にする。
///
/// `forced` を指定すると判別を飛ばしてその文字コードで読む（画面からの手動上書き）。
/// 指定が合っていなければ置換文字が出るので、`lossy` が立つ。
///
/// 判別に失敗した場合は **UTF-8 の置換ありデコード**に落とす。ASCII 部分は読めるので、
/// この環境では最も傷が浅い。
pub fn decode(bytes: &[u8], forced: Option<TextEncoding>) -> Decoded {
    if is_binary(bytes) {
        return Decoded::Binary { size: bytes.len() };
    }

    // BOM は判別の前に落とす。付いたまま Shift_JIS を試すと、BOM が化けて成功しうる。
    let had_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if had_bom { &bytes[3..] } else { bytes };

    let encoding = forced
        .or_else(|| detect(body))
        .unwrap_or(TextEncoding::Utf8);
    let (text, lossy) = encoding.codec().decode_without_bom_handling(body);

    Decoded::Text(DecodedText {
        text: text.into_owned(),
        encoding,
        had_bom,
        lossy,
        line_endings: line_endings(body),
    })
}

/// 改行コードを数える。
///
/// 改行は 3 つの文字コードすべてで ASCII と同じバイトなので、デコード前に数えてよい。
pub fn line_endings(bytes: &[u8]) -> LineEndingCounts {
    let mut counts = LineEndingCounts::default();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    counts.crlf += 1;
                    index += 2;
                    continue;
                }
                counts.cr += 1;
            }
            b'\n' => counts.lf += 1,
            _ => {}
        }
        index += 1;
    }

    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「日本語」の Shift_JIS 表現。**符号化し直さず値で持つ**
    /// （同じクレートで encode → decode すると、判別の誤りを検出できない）。
    const NIHONGO_SJIS: &[u8] = &[0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA];
    /// 「日本語」の EUC-JP 表現。
    const NIHONGO_EUC: &[u8] = &[0xC6, 0xFC, 0xCB, 0xDC, 0xB8, 0xEC];

    fn text(decoded: Decoded) -> DecodedText {
        match decoded {
            Decoded::Text(text) => text,
            Decoded::Binary { size } => panic!("バイナリと判定された（{size} バイト）"),
        }
    }

    #[test]
    fn ascii_is_utf8() {
        let decoded = text(decode(b"fn main() {}", None));
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert_eq!(decoded.text, "fn main() {}");
        assert!(!decoded.lossy);
        assert!(!decoded.had_bom);
    }

    #[test]
    fn utf8_japanese() {
        let decoded = text(decode("日本語のファイル".as_bytes(), None));
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert_eq!(decoded.text, "日本語のファイル");
        assert!(!decoded.lossy);
    }

    #[test]
    fn utf8_bom_is_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("日本語".as_bytes());

        let decoded = text(decode(&bytes, None));
        assert!(decoded.had_bom);
        // U+FEFF が残っていないこと。残ると差分の先頭に見えない文字が出る。
        assert_eq!(decoded.text, "日本語");
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
    }

    #[test]
    fn shift_jis_is_detected() {
        let decoded = text(decode(NIHONGO_SJIS, None));
        assert_eq!(decoded.encoding, TextEncoding::ShiftJis);
        assert_eq!(decoded.text, "日本語");
        assert!(!decoded.lossy);
    }

    #[test]
    fn euc_jp_is_detected() {
        let decoded = text(decode(NIHONGO_EUC, None));
        assert_eq!(decoded.encoding, TextEncoding::EucJp);
        assert_eq!(decoded.text, "日本語");
        assert!(!decoded.lossy);
    }

    /// 実ファイルは ASCII の中に日本語が混ざる。前後の ASCII で判別が鈍らないこと。
    #[test]
    fn shift_jis_mixed_with_ascii() {
        let mut bytes = b"// ".to_vec();
        bytes.extend_from_slice(NIHONGO_SJIS);
        bytes.extend_from_slice(b" comment\n");

        let decoded = text(decode(&bytes, None));
        assert_eq!(decoded.encoding, TextEncoding::ShiftJis);
        assert!(decoded.text.contains("日本語"));
    }

    /// **順序による判別の限界を固定するテスト。**
    ///
    /// EUC-JP のひらがなは 1 バイトずつが Shift_JIS の半角カナとして妥当なので、
    /// 厳密デコードが通ってしまい Shift_JIS と判定される。
    /// **これは不具合ではなく、順序で決める方式の帰結**（docs/DESIGN.md §9.1）。
    /// 直す手段は手動上書きであり、判定が変わったらこのテストが落ちて気付ける。
    #[test]
    fn euc_jp_hiragana_is_misdetected_as_shift_jis() {
        // 「こんにちは」の EUC-JP 表現。すべて 0xA1〜0xDF に収まる。
        let bytes: &[u8] = &[0xA4, 0xB3, 0xA4, 0xF3, 0xA4, 0xCB, 0xA4, 0xC1, 0xA4, 0xCF];

        let detected = text(decode(bytes, None));
        assert_eq!(detected.encoding, TextEncoding::ShiftJis);
        assert!(!detected.lossy, "化けても置換文字は出ないので lossy では気付けない");

        // 手動上書きで正しく読めること。
        let forced = text(decode(bytes, Some(TextEncoding::EucJp)));
        assert_eq!(forced.text, "こんにちは");
    }

    #[test]
    fn undecodable_falls_back_to_lossy_utf8() {
        let decoded = text(decode(&[0xFF, 0xFF, b'a'], None));
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert!(decoded.lossy);
        // ASCII 部分は読めること（落とす価値があるのはここ）。
        assert!(decoded.text.ends_with('a'));
    }

    #[test]
    fn empty_is_text() {
        let decoded = text(decode(b"", None));
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert_eq!(decoded.text, "");
        assert_eq!(decoded.line_endings, LineEndingCounts::default());
    }

    #[test]
    fn nul_byte_is_binary() {
        assert_eq!(
            decode(&[b'a', 0x00, b'b'], None),
            Decoded::Binary { size: 3 }
        );
        assert!(is_binary(&[0x00]));
    }

    /// 判定範囲は git と同じ先頭 8000 バイト。それより後ろの NUL は見ない。
    #[test]
    fn nul_beyond_the_sniff_window_is_text() {
        let mut bytes = vec![b'a'; BINARY_SNIFF_LEN];
        bytes.push(0x00);

        assert!(!is_binary(&bytes));
        let decoded = text(decode(&bytes, None));
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
    }

    #[test]
    fn forced_encoding_skips_detection() {
        // Shift_JIS のバイト列を EUC-JP と指定すると化ける。黙って化けないこと。
        let decoded = text(decode(NIHONGO_SJIS, Some(TextEncoding::EucJp)));
        assert_eq!(decoded.encoding, TextEncoding::EucJp);
        assert!(decoded.lossy);
        assert_ne!(decoded.text, "日本語");
    }

    #[test]
    fn forced_encoding_can_be_correct() {
        let decoded = text(decode(NIHONGO_EUC, Some(TextEncoding::EucJp)));
        assert_eq!(decoded.text, "日本語");
        assert!(!decoded.lossy);
    }

    #[test]
    fn line_endings_lf_only() {
        let counts = line_endings(b"a\nb\n");
        assert_eq!(
            counts,
            LineEndingCounts {
                lf: 2,
                crlf: 0,
                cr: 0
            }
        );
        assert_eq!(counts.dominant(), Some(LineEnding::Lf));
        assert!(!counts.mixed());
    }

    /// CRLF を CR と LF に二重計上しないこと。ここを間違えると全ファイルが「混在」になる。
    #[test]
    fn crlf_is_counted_once() {
        let counts = line_endings(b"a\r\nb\r\n");
        assert_eq!(
            counts,
            LineEndingCounts {
                lf: 0,
                crlf: 2,
                cr: 0
            }
        );
        assert_eq!(counts.dominant(), Some(LineEnding::Crlf));
        assert!(!counts.mixed());
    }

    #[test]
    fn lone_cr_is_counted() {
        let counts = line_endings(b"a\rb\r");
        assert_eq!(
            counts,
            LineEndingCounts {
                lf: 0,
                crlf: 0,
                cr: 2
            }
        );
        assert_eq!(counts.dominant(), Some(LineEnding::Cr));
    }

    #[test]
    fn mixed_line_endings_are_detected() {
        let counts = line_endings(b"a\nb\r\nc\rd");
        assert_eq!(
            counts,
            LineEndingCounts {
                lf: 1,
                crlf: 1,
                cr: 1
            }
        );
        assert!(counts.mixed());
    }

    #[test]
    fn no_line_ending_at_all() {
        let counts = line_endings(b"one line");
        assert_eq!(counts.dominant(), None);
        assert!(!counts.mixed());
    }

    /// CR で終わるバッファの末尾で 1 バイト先を見に行っても落ちないこと。
    #[test]
    fn trailing_cr_does_not_overrun() {
        assert_eq!(
            line_endings(b"a\r"),
            LineEndingCounts {
                lf: 0,
                crlf: 0,
                cr: 1
            }
        );
    }

    #[test]
    fn decode_counts_line_endings_of_the_body() {
        // BOM を落とした後のバイト列に対して数えること。
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"a\r\nb\n");

        let decoded = text(decode(&bytes, None));
        assert!(decoded.had_bom);
        assert_eq!(
            decoded.line_endings,
            LineEndingCounts {
                lf: 1,
                crlf: 1,
                cr: 0
            }
        );
        assert!(decoded.line_endings.mixed());
    }
}
