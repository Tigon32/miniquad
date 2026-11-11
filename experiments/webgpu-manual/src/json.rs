//! A minimal, dependency-free JSON writer. The contract needs one stable
//! status shape (section 5); a full JSON library is not required for it.

pub struct JsonWriter {
    out: String,
}

impl JsonWriter {
    pub fn new() -> Self {
        JsonWriter { out: String::new() }
    }

    pub fn into_string(self) -> String {
        self.out
    }

    pub fn raw(&mut self, text: &str) {
        self.out.push_str(text);
    }

    pub fn string(&mut self, value: &str) {
        self.out.push('"');
        for ch in value.chars() {
            match ch {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                '\n' => self.out.push_str("\\n"),
                '\r' => self.out.push_str("\\r"),
                '\t' => self.out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    self.out.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => self.out.push(c),
            }
        }
        self.out.push('"');
    }

    pub fn number(&mut self, value: i64) {
        self.out.push_str(&value.to_string());
    }

    pub fn boolean(&mut self, value: bool) {
        self.out.push_str(if value { "true" } else { "false" });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_quotes_and_control_characters() {
        let mut w = JsonWriter::new();
        w.string("a\"b\\c\nd\u{0001}");
        assert_eq!(w.into_string(), "\"a\\\"b\\\\c\\nd\\u0001\"");
    }

    #[test]
    fn keeps_accented_and_emoji_text_intact() {
        let mut w = JsonWriter::new();
        w.string("caf\u{00e9} \u{1f600}");
        assert_eq!(w.into_string(), "\"caf\u{00e9} \u{1f600}\"");
    }

    #[test]
    fn empty_string_is_two_quotes() {
        let mut w = JsonWriter::new();
        w.string("");
        assert_eq!(w.into_string(), "\"\"");
    }
}
