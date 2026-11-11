//! HUD layout and glyph math for the mixed-mode voxel example.
//!
//! This module holds the **pure** parts of the in-frame HUD contract:
//! the seven-segment glyph bitmasks, the exact pixel geometry
//! formulas, and the fixed 16-cell layout. It has no GPU code, so it
//! is unit-testable without a rendering backend. `examples/mixed.rs`
//! turns the geometry this module returns into quads.
//!
//! Segment bit order (`a`=bit0 .. `g`=bit6), matching a standard
//! seven-segment display:
//!
//! ```text
//!  aaa
//! f   b
//! f   b
//!  ggg
//! e   c
//! e   c
//!  ddd
//! ```

/// One glyph's closed segment mask (bits a..g in bits 0..6).
pub type GlyphMask = u8;

/// Returns the closed-segment mask for one supported token, or `None`
/// for an unsupported character. Only the exact token set in the HUD
/// contract is supported; there is no font and no texture.
pub fn glyph_mask(ch: char) -> Option<GlyphMask> {
    Some(match ch {
        '0' => 0x3F,
        '1' => 0x06,
        '2' => 0x5B,
        '3' => 0x4F,
        '4' => 0x66,
        '5' => 0x6D,
        '6' => 0x7D,
        '7' => 0x07,
        '8' => 0x7F,
        '9' => 0x6F,
        '-' => 0x40,
        ' ' => 0x00,
        'L' => 0x38,
        'O' => 0x3F,
        'C' => 0x39,
        'S' => 0x6D,
        'E' => 0x79,
        'F' => 0x71,
        'r' => 0x50,
        'o' => 0x5C,
        'n' => 0x54,
        _ => return None,
    })
}

/// Fixed HUD cell count: 0..2 mode, 3 blank, 4..7 status, 8 blank, 9
/// `'r'`, 10..15 six-digit revision. See `docs/architecture/voxel-protocol.md`.
pub const CELL_COUNT: usize = 16;

/// Mode token (cells 0..2): local/offline or server/mixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `LOC`: WASM-only, no network.
    Local,
    /// `SEr`: mixed WASM + server.
    Server,
}

impl Mode {
    fn chars(self) -> [char; 3] {
        match self {
            Mode::Local => ['L', 'O', 'C'],
            Mode::Server => ['S', 'E', 'r'],
        }
    }
}

/// Status token (cells 4..7): transport/session state shown in the HUD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// `Conn`: connecting or resynchronizing.
    Connecting,
    /// `On__`: online, snapshot applied.
    Online,
    /// `OFF_`: outage/timeout, last scene kept, read-only.
    Offline,
    /// `Err1`: unsupported protocol version. No retry.
    VersionError,
    /// `____`: offline/local mode (no transport status to show).
    None,
}

impl Status {
    fn chars(self) -> [char; 4] {
        match self {
            Status::Connecting => ['C', 'o', 'n', 'n'],
            Status::Online => ['O', 'n', ' ', ' '],
            Status::Offline => ['O', 'F', 'F', ' '],
            Status::VersionError => ['E', 'r', 'r', '1'],
            Status::None => ['_', '_', '_', '_'],
        }
    }
}

/// The displayed revision cell: `Unknown` before the first snapshot
/// (`------`), `Known` for a value that fits the six-digit display
/// (`0..=999_999`, zero-padded), or `Overflow` once the real
/// revision exceeds six decimal digits (`EEEEEE`): the HUD cannot
/// truthfully show a full `u32` in six digits, so values at or above
/// `1_000_000` are shown as an explicit overflow marker rather than
/// silently saturated to a smaller, wrong-looking number. The host's
/// semantic status text (not this fixed-width glyph strip) must
/// always carry the full decimal revision; see
/// `docs/architecture/voxel-protocol.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revision {
    /// No snapshot applied yet.
    Unknown,
    /// Applied revision, `0..=999_999`: fits the six-digit display.
    Known(u32),
    /// Applied revision `>= 1_000_000`: too large for six digits.
    Overflow,
}

const MAX_DISPLAY_REVISION: u32 = 999_999;

/// Classifies a raw revision `u32` (or `None` before the first
/// snapshot) into the displayable [`Revision`] the HUD renders.
pub fn classify_revision(rev: Option<u32>) -> Revision {
    match rev {
        None => Revision::Unknown,
        Some(rev) if rev <= MAX_DISPLAY_REVISION => Revision::Known(rev),
        Some(_) => Revision::Overflow,
    }
}

/// Builds the fixed 16-token HUD cell string (ASCII, one token per
/// cell; `'_'` means "blank cell" and is mapped to a space glyph by
/// the renderer, kept distinct here only for the `Status::None`
/// underscore tokens which are literal underscores per the contract).
pub fn cell_tokens(mode: Mode, status: Status, revision: Revision) -> [char; CELL_COUNT] {
    let mut cells = [' '; CELL_COUNT];
    let mode_chars = mode.chars();
    cells[0] = mode_chars[0];
    cells[1] = mode_chars[1];
    cells[2] = mode_chars[2];
    cells[3] = ' ';
    let status_chars = status.chars();
    cells[4] = status_chars[0];
    cells[5] = status_chars[1];
    cells[6] = status_chars[2];
    cells[7] = status_chars[3];
    cells[8] = ' ';
    cells[9] = 'r';
    let digits: [char; 6] = match revision {
        Revision::Unknown => ['-', '-', '-', '-', '-', '-'],
        Revision::Overflow => ['E', 'E', 'E', 'E', 'E', 'E'],
        Revision::Known(rev) => {
            let s = format!("{:06}", rev);
            let mut out = [' '; 6];
            for (i, c) in s.chars().enumerate() {
                out[i] = c;
            }
            out
        }
    };
    cells[10..16].copy_from_slice(&digits);
    cells
}

/// Resolved pixel geometry for the HUD panel, derived from the device
/// pixel ratio `d` per the exact formulas in the HUD contract.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    /// Device pixel ratio used to derive every other field.
    pub d: f32,
    /// Glyph cell height in device pixels.
    pub h: f32,
    /// Glyph cell width in device pixels.
    pub w: f32,
    /// Segment thickness in device pixels.
    pub t: f32,
    /// Glyph advance (pitch) in device pixels.
    pub a: f32,
    /// Panel inner padding in device pixels.
    pub p: f32,
    /// Gap between the status chip and the first glyph, in device pixels.
    pub g: f32,
    /// Outer margin from the viewport edge, in device pixels.
    pub m: f32,
    /// Panel width in device pixels.
    pub panel_width: f32,
    /// Panel height in device pixels.
    pub panel_height: f32,
}

/// Minimum glyph height, in device pixels, before the HUD gives up and
/// is hidden rather than drawn too small to read.
const MIN_GLYPH_HEIGHT_DEVICE_PX: f32 = 10.0;

/// Computes the HUD geometry for a `width_px x height_px` device
/// viewport at device pixel ratio `d`. Returns `None` when the HUD
/// does not fit even after shrinking the glyph height to the 10
/// device-pixel floor: the contract requires hiding the whole HUD in
/// that case, not the host status text.
pub fn compute_geometry(d: f32, width_px: f32, height_px: f32) -> Option<Geometry> {
    let mut h = (16.0 * d).round();
    loop {
        let w = (0.55 * h).round();
        let t = (h / 8.0).round().max(2.0);
        let a = w + (1.5 * t).round();
        let p = 2.0 * t;
        let g = 2.0 * t;
        let m = (8.0 * d).round();
        // Panel width: own chip slot (H square) + gap + 15 glyph
        // advances + the final glyph's own width, plus padding on
        // both sides.
        let panel_width = 2.0 * p + h + g + 15.0 * a + w;
        let panel_height = 2.0 * p + h;
        if m + panel_width + m <= width_px && m + panel_height + m <= height_px {
            return Some(Geometry {
                d,
                h,
                w,
                t,
                a,
                p,
                g,
                m,
                panel_width,
                panel_height,
            });
        }
        if h <= MIN_GLYPH_HEIGHT_DEVICE_PX {
            return None;
        }
        h = (h - 1.0).max(MIN_GLYPH_HEIGHT_DEVICE_PX);
    }
}

/// One glyph cell's top-left position and size in device pixels,
/// cell index `0..16`, matching `cell_tokens`'s order.
pub fn glyph_rect(geo: &Geometry, x0: f32, y0: f32, cell_index: usize) -> (f32, f32, f32, f32) {
    let gx = x0 + geo.p + geo.h + geo.g + (cell_index as f32) * geo.a;
    let gy = y0 + geo.p;
    (gx, gy, geo.w, geo.h)
}

/// The status chip's square rect in device pixels (own slot, left of
/// the first glyph).
pub fn chip_rect(geo: &Geometry, x0: f32, y0: f32) -> (f32, f32, f32, f32) {
    (x0 + geo.p, y0 + geo.p, geo.h, geo.h)
}

/// Chip fill color (straight alpha, opaque) for a transport status.
/// Returns `None` for `Status::Offline` ("offline chip not drawn").
pub fn chip_color(status: Status) -> Option<[f32; 4]> {
    match status {
        Status::Online => Some([
            0x5F as f32 / 255.0,
            0xD3 as f32 / 255.0,
            0x8D as f32 / 255.0,
            1.0,
        ]),
        Status::Connecting => Some([
            0xFF as f32 / 255.0,
            0xC2 as f32 / 255.0,
            0x4B as f32 / 255.0,
            1.0,
        ]),
        Status::VersionError => Some([
            0xFF as f32 / 255.0,
            0x6B as f32 / 255.0,
            0x6B as f32 / 255.0,
            1.0,
        ]),
        Status::Offline => None,
        Status::None => None,
    }
}

/// Panel fill color: black, alpha 0.85 (straight alpha).
pub const PANEL_COLOR: [f32; 4] = [0.0, 0.0, 0.0, 0.85];
/// Glyph fill color: opaque near-white.
pub const GLYPH_COLOR: [f32; 4] = [
    0xF2 as f32 / 255.0,
    0xF2 as f32 / 255.0,
    0xF2 as f32 / 255.0,
    1.0,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digit_masks_match_standard_seven_segment_encoding() {
        let expected = [
            ('0', 0x3F),
            ('1', 0x06),
            ('2', 0x5B),
            ('3', 0x4F),
            ('4', 0x66),
            ('5', 0x6D),
            ('6', 0x7D),
            ('7', 0x07),
            ('8', 0x7F),
            ('9', 0x6F),
        ];
        for (ch, mask) in expected {
            assert_eq!(glyph_mask(ch), Some(mask), "glyph {ch}");
        }
    }

    #[test]
    fn every_contract_token_is_supported_and_no_stray_glyph_is_added() {
        let supported = "0123456789-  LOCSEFron";
        for ch in supported.chars() {
            assert!(glyph_mask(ch).is_some(), "token {ch:?} must be supported");
        }
        // A character outside the exact contract set must be rejected,
        // so a future typo cannot silently draw an unrelated glyph.
        assert_eq!(glyph_mask('Z'), None);
        assert_eq!(glyph_mask('%'), None);
    }

    #[test]
    fn blank_and_dash_masks_are_exact() {
        assert_eq!(glyph_mask(' '), Some(0x00));
        assert_eq!(glyph_mask('-'), Some(0x40));
    }

    #[test]
    fn cell_layout_is_exactly_16_cells_in_fixed_order() {
        let cells = cell_tokens(Mode::Local, Status::None, Revision::Unknown);
        assert_eq!(cells.len(), 16);
        assert_eq!(&cells[0..3], &['L', 'O', 'C']);
        assert_eq!(cells[3], ' ');
        assert_eq!(&cells[4..8], &['_', '_', '_', '_']);
        assert_eq!(cells[8], ' ');
        assert_eq!(cells[9], 'r');
        assert_eq!(&cells[10..16], &['-', '-', '-', '-', '-', '-']);
    }

    #[test]
    fn server_mode_online_status_and_known_revision_render_exact_cells() {
        let cells = cell_tokens(Mode::Server, Status::Online, Revision::Known(42));
        assert_eq!(&cells[0..3], &['S', 'E', 'r']);
        assert_eq!(&cells[4..8], &['O', 'n', ' ', ' ']);
        assert_eq!(&cells[10..16], &['0', '0', '0', '0', '4', '2']);
    }

    #[test]
    fn revision_overflow_renders_eeeeee_at_and_above_one_million() {
        let cells = cell_tokens(Mode::Server, Status::Online, Revision::Overflow);
        assert_eq!(&cells[10..16], &['E', 'E', 'E', 'E', 'E', 'E']);
    }

    #[test]
    fn classify_revision_boundaries_are_exact() {
        assert_eq!(classify_revision(None), Revision::Unknown);
        assert_eq!(classify_revision(Some(0)), Revision::Known(0));
        assert_eq!(classify_revision(Some(42)), Revision::Known(42));
        assert_eq!(classify_revision(Some(999_999)), Revision::Known(999_999));
        assert_eq!(classify_revision(Some(1_000_000)), Revision::Overflow);
        assert_eq!(classify_revision(Some(u32::MAX)), Revision::Overflow);
    }

    #[test]
    fn classified_overflow_revision_renders_eeeeee_end_to_end() {
        let cells = cell_tokens(
            Mode::Server,
            Status::Online,
            classify_revision(Some(u32::MAX)),
        );
        assert_eq!(&cells[10..16], &['E', 'E', 'E', 'E', 'E', 'E']);
    }

    #[test]
    fn connecting_resync_outage_and_version_error_status_tokens_are_exact() {
        assert_eq!(Status::Connecting.chars(), ['C', 'o', 'n', 'n']);
        assert_eq!(Status::Offline.chars(), ['O', 'F', 'F', ' ']);
        assert_eq!(Status::VersionError.chars(), ['E', 'r', 'r', '1']);
    }

    #[test]
    fn default_800x500_at_dpr_1_matches_the_contract_example() {
        let geo = compute_geometry(1.0, 800.0, 500.0).expect("must fit at the documented default");
        assert_eq!(geo.h, 16.0);
        assert_eq!(geo.w, 9.0); // round(0.55 * 16) = round(8.8) = 9
        assert_eq!(geo.t, 2.0); // max(2, round(16/8)) = max(2, 2)
        assert_eq!(geo.m, 8.0); // round(8*1)
        assert_eq!(geo.p, 4.0);
        assert_eq!(geo.g, 4.0);
        // Panel: x0 = y0 = M = 8, per the contract's worked example.
        let x0 = geo.m;
        let y0 = geo.m;
        assert_eq!(x0, 8.0);
        assert_eq!(y0, 8.0);
        assert_eq!(x0 + geo.panel_width, 225.0, "panel right edge x .. 225");
        assert_eq!(y0 + geo.panel_height, 32.0, "panel bottom edge y .. 32");

        let chip = chip_rect(&geo, x0, y0);
        assert_eq!(chip, (12.0, 12.0, 16.0, 16.0)); // x12..28 y12..28, H square

        let cell0 = glyph_rect(&geo, x0, y0, 0);
        assert_eq!((cell0.0, cell0.0 + cell0.2), (32.0, 41.0)); // cell0 x32..41
        let cell15 = glyph_rect(&geo, x0, y0, 15);
        assert_eq!((cell15.0, cell15.0 + cell15.2), (212.0, 221.0)); // cell15 x212..221
    }

    #[test]
    fn geometry_shrinks_glyph_height_before_hiding_the_hud() {
        // A narrow viewport should still fit by shrinking H, not by
        // disappearing immediately.
        let geo = compute_geometry(1.0, 180.0, 60.0);
        assert!(
            geo.is_some(),
            "a narrow-but-plausible viewport should shrink, not hide"
        );
        let geo = geo.unwrap();
        assert!(
            geo.h < 16.0,
            "glyph height must have shrunk from the default"
        );
        assert!(geo.h >= MIN_GLYPH_HEIGHT_DEVICE_PX);
    }

    #[test]
    fn geometry_is_none_when_even_the_minimum_height_does_not_fit() {
        assert_eq!(compute_geometry(1.0, 10.0, 10.0), None);
    }

    #[test]
    fn offline_chip_is_not_drawn() {
        assert_eq!(chip_color(Status::Offline), None);
        assert_eq!(chip_color(Status::None), None);
        assert!(chip_color(Status::Online).is_some());
        assert!(chip_color(Status::Connecting).is_some());
        assert!(chip_color(Status::VersionError).is_some());
    }

    #[test]
    fn panel_and_glyph_colors_meet_the_documented_contrast_floor() {
        // Worst-case backdrop #262626 behind panel alpha 0.85 black:
        // composited luminance stays near-black, so glyph #F2F2F2
        // keeps a very large contrast ratio against it. This is a
        // bounds check, not a full WCAG implementation.
        let backdrop = 0x26 as f32 / 255.0;
        let panel_alpha = PANEL_COLOR[3];
        let composited = backdrop * (1.0 - panel_alpha); // panel is black
        let glyph = GLYPH_COLOR[0];
        assert!(
            glyph > composited * 7.0,
            "glyph must clear a 7:1-like contrast floor"
        );
    }
}
