//! Validation for bytes that JavaScript sends to Rust as text (contract
//! section 7: "JavaScript...cuts a message to 4096 bytes at a UTF-8
//! character boundary. Rust checks the bytes with `str::from_utf8`.").

pub const MAX_TEXT_BYTES: usize = 4096;

/// Validates an incoming byte buffer as UTF-8 text within the contract's
/// 4096-byte limit. Returns `Err(())` for invalid UTF-8 or an over-limit
/// buffer; the caller reports `ProofErrorCode::Internal` for either fault.
pub fn validate_incoming_text(bytes: &[u8]) -> Result<&str, ()> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(());
    }
    std::str::from_utf8(bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_buffer_is_the_empty_string() {
        assert_eq!(validate_incoming_text(&[]), Ok(""));
    }

    #[test]
    fn accented_text_is_valid() {
        let bytes = "caf\u{00e9}".as_bytes();
        assert_eq!(validate_incoming_text(bytes), Ok("caf\u{00e9}"));
    }

    #[test]
    fn emoji_text_is_valid() {
        let bytes = "\u{1f600}\u{1f601}".as_bytes();
        assert_eq!(validate_incoming_text(bytes), Ok("\u{1f600}\u{1f601}"));
    }

    #[test]
    fn exactly_4096_bytes_is_accepted() {
        let text = "a".repeat(MAX_TEXT_BYTES);
        assert!(validate_incoming_text(text.as_bytes()).is_ok());
    }

    #[test]
    fn over_4096_bytes_is_rejected() {
        let text = "a".repeat(MAX_TEXT_BYTES + 1);
        assert!(validate_incoming_text(text.as_bytes()).is_err());
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        let bytes: &[u8] = &[0xff, 0xfe, 0xfd];
        assert!(validate_incoming_text(bytes).is_err());
    }

    #[test]
    fn a_cut_multibyte_character_is_rejected() {
        // A boundary cut inside a 4-byte emoji scalar must not validate.
        let full = "\u{1f600}".as_bytes();
        assert!(validate_incoming_text(&full[..2]).is_err());
    }
}
