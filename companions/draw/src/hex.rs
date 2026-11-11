//! An optional, bounded 2D axial hex-grid layout and pixel-to-cell
//! selection module.
//!
//! See `docs/hex-2d-contract.md` for the frozen math and API contract
//! (MADR 0012, issues #133/#134). This module uses the axial
//! convention, side order, and corner lattice of the 3D hexagonal-prism
//! contract (MADR 0011): world `(x, z)` maps to 2D Y-down `(u, v)` as
//! `u = x`, `v = z`. It has no dependency on `miniquad-voxel`; the
//! shared tables are a deliberate, small, lock-tested duplication (see
//! the ADR's rejected option D).
//!
//! No `unsafe`, no I/O, no global state, no allocation.

use crate::geometry::MAX_COORDINATE;
use crate::transform::Transform2D;

/// The minimum valid axial coordinate (shared with the 3D contract).
pub const HEX_COORD_MIN: i32 = -65_536;
/// The maximum valid axial coordinate (shared with the 3D contract).
pub const HEX_COORD_MAX: i32 = 65_535;
/// The minimum valid [`HexLayout`] circumradius, in logical pixels.
pub const HEX_MIN_RADIUS: f32 = 1.0;
/// The maximum valid [`HexLayout`] circumradius, in logical pixels.
pub const HEX_MAX_RADIUS: f32 = 16_384.0;

/// `√3 / 2`, calculated in `f64` and used for the canonical lattice.
const S64: f64 = 0.866_025_403_784_438_6_f64;

/// The six flat-top corner lattice offsets (section 1.5). Shared with
/// the 3D contract's corner table (`KX`, `KZ`), restated here to avoid a
/// dependency on `miniquad-voxel`. A cross-contract test locks the two
/// tables together where the 3D crate is available.
const KX: [i64; 6] = [2, 1, -1, -2, -1, 1];
const KZ: [i64; 6] = [0, 1, 1, 0, -1, -1];

/// The six pointy-top corner lattice offsets (section 1.5): the
/// flat-top table turned by `+30°`.
const KU: [i64; 6] = [1, 0, -1, -1, 0, 1];
const KV: [i64; 6] = [1, 2, 1, -1, -2, -1];

/// The six axial neighbor deltas, in side order (section 1.3).
const SIDE_DELTA: [(i32, i32); 6] = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];

/// An error from a [`HexCoord`] or [`HexLayout`] operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexError {
    /// A `radius`, `origin`, or point component was `NaN` or infinite.
    NonFiniteInput,
    /// A finite `radius` was outside `HEX_MIN_RADIUS..=HEX_MAX_RADIUS`.
    InvalidRadius,
    /// A cell coordinate, or the result of a conversion, was outside
    /// `HEX_COORD_MIN..=HEX_COORD_MAX`.
    CoordinateOutOfRange,
    /// A finite `origin`, point, or output component exceeded
    /// `geometry::MAX_COORDINATE` in absolute value.
    PixelOutOfRange,
    /// A `side` passed to [`HexCoord::neighbor`] was not in `0..6`.
    InvalidSide,
}

impl std::fmt::Display for HexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            HexError::NonFiniteInput => "a hex input was NaN or infinite",
            HexError::InvalidRadius => "a hex layout radius was outside the valid range",
            HexError::CoordinateOutOfRange => "a hex coordinate was outside the valid range",
            HexError::PixelOutOfRange => "a hex pixel value exceeded the coordinate bound",
            HexError::InvalidSide => "a hex side index was not in 0..6",
        };
        f.write_str(message)
    }
}

impl std::error::Error for HexError {}

fn check_coord(q: i32, r: i32) -> Result<(), HexError> {
    if (HEX_COORD_MIN..=HEX_COORD_MAX).contains(&q) && (HEX_COORD_MIN..=HEX_COORD_MAX).contains(&r)
    {
        Ok(())
    } else {
        Err(HexError::CoordinateOutOfRange)
    }
}

fn check_pixel(x: f32, y: f32) -> Result<(), HexError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(HexError::NonFiniteInput);
    }
    if x.abs() > MAX_COORDINATE || y.abs() > MAX_COORDINATE {
        return Err(HexError::PixelOutOfRange);
    }
    Ok(())
}

/// An axial hex-grid cell, with no layer. See `docs/hex-2d-contract.md`
/// section 1.2 for the coordinate convention.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HexCoord {
    q: i32,
    r: i32,
}

impl HexCoord {
    /// Builds a cell. Errors with [`HexError::CoordinateOutOfRange`] if
    /// `q` or `r` is outside `HEX_COORD_MIN..=HEX_COORD_MAX`.
    pub fn new(q: i32, r: i32) -> Result<HexCoord, HexError> {
        check_coord(q, r)?;
        Ok(HexCoord { q, r })
    }

    pub const fn q(self) -> i32 {
        self.q
    }

    pub const fn r(self) -> i32 {
        self.r
    }

    /// The neighbor across side `side` (section 1.3). Errors with
    /// [`HexError::InvalidSide`] if `side >= 6`, or with
    /// [`HexError::CoordinateOutOfRange`] if the result would overflow
    /// or fall outside the bound. Never panics or wraps.
    pub fn neighbor(self, side: usize) -> Result<HexCoord, HexError> {
        let (dq, dr) = *SIDE_DELTA.get(side).ok_or(HexError::InvalidSide)?;
        let q = self
            .q
            .checked_add(dq)
            .ok_or(HexError::CoordinateOutOfRange)?;
        let r = self
            .r
            .checked_add(dr)
            .ok_or(HexError::CoordinateOutOfRange)?;
        HexCoord::new(q, r)
    }

    /// The axial (hex) distance to `other`, ignoring any layer. Equal
    /// to the 3D contract's `planar_distance`.
    pub fn distance(self, other: HexCoord) -> u32 {
        let dq = i64::from(self.q) - i64::from(other.q);
        let dr = i64::from(self.r) - i64::from(other.r);
        let value = (dq.abs() + dr.abs() + (dq + dr).abs()) / 2;
        value as u32
    }
}

/// The 2D hex orientation. See `docs/hex-2d-contract.md` section 1.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HexOrientation {
    FlatTop,
    PointyTop,
}

/// A bounded 2D hex-grid layout: an orientation, a circumradius in
/// logical pixels, and a pixel origin. A layout supports a similarity
/// transform only (uniform scale, translation, and the fixed 30°
/// orientation turn). See `docs/hex-2d-contract.md` section 1.8: do not
/// call [`HexLayout::cell_at`] on a pixel moved by a different drawing
/// transform.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexLayout {
    orientation: HexOrientation,
    radius: f32,
    origin: (f32, f32),
}

/// Canonical lattice integer pair for corner `k` (or the center, when
/// `k` is `None`) of a flat-top cell `(q, r)`.
fn flat_top_lattice(q: i32, r: i32, k: Option<usize>) -> (i64, i64) {
    let (kx, kz) = k.map_or((0, 0), |k| (KX[k], KZ[k]));
    let x = 3 * i64::from(q) + kx;
    let z = 2 * i64::from(r) + i64::from(q) + kz;
    (x, z)
}

/// Canonical lattice integer pair for corner `k` (or the center, when
/// `k` is `None`) of a pointy-top cell `(q, r)`.
fn pointy_top_lattice(q: i32, r: i32, k: Option<usize>) -> (i64, i64) {
    let (ku, kv) = k.map_or((0, 0), |k| (KU[k], KV[k]));
    let u = i64::from(q) - i64::from(r) + ku;
    let v = 3 * (i64::from(q) + i64::from(r)) + kv;
    (u, v)
}

impl HexLayout {
    /// Builds a layout. Checks, in order: a non-finite `radius` or
    /// `origin` component gives [`HexError::NonFiniteInput`]; a finite
    /// `radius` outside `HEX_MIN_RADIUS..=HEX_MAX_RADIUS` gives
    /// [`HexError::InvalidRadius`]; an `origin` component with
    /// `|value| > MAX_COORDINATE` gives [`HexError::PixelOutOfRange`].
    pub fn new(
        orientation: HexOrientation,
        radius: f32,
        origin: (f32, f32),
    ) -> Result<HexLayout, HexError> {
        if !radius.is_finite() || !origin.0.is_finite() || !origin.1.is_finite() {
            return Err(HexError::NonFiniteInput);
        }
        if !(HEX_MIN_RADIUS..=HEX_MAX_RADIUS).contains(&radius) {
            return Err(HexError::InvalidRadius);
        }
        if origin.0.abs() > MAX_COORDINATE || origin.1.abs() > MAX_COORDINATE {
            return Err(HexError::PixelOutOfRange);
        }
        Ok(HexLayout {
            orientation,
            radius,
            origin,
        })
    }

    pub const fn orientation(self) -> HexOrientation {
        self.orientation
    }

    pub const fn radius(self) -> f32 {
        self.radius
    }

    pub const fn origin(self) -> (f32, f32) {
        self.origin
    }

    /// Converts a canonical lattice integer pair to a pixel, scaling by
    /// the layout radius and origin (section 1.5). `f64` throughout,
    /// converted to `f32` once at the end.
    fn lattice_to_pixel(self, lattice: (i64, i64)) -> Result<(f32, f32), HexError> {
        let r = f64::from(self.radius);
        let ox = f64::from(self.origin.0);
        let oy = f64::from(self.origin.1);
        let (a, b) = lattice;
        let (x, y) = match self.orientation {
            HexOrientation::FlatTop => (ox + (a as f64) * (r * 0.5), oy + (b as f64) * (r * S64)),
            HexOrientation::PointyTop => (ox + (a as f64) * (r * S64), oy + (b as f64) * (r * 0.5)),
        };
        let (x, y) = (x as f32, y as f32);
        check_pixel(x, y).map_err(|_| HexError::PixelOutOfRange)?;
        Ok((x, y))
    }

    /// The center of `cell`, in logical pixels.
    pub fn center(self, cell: HexCoord) -> Result<(f32, f32), HexError> {
        let lattice = match self.orientation {
            HexOrientation::FlatTop => flat_top_lattice(cell.q, cell.r, None),
            HexOrientation::PointyTop => pointy_top_lattice(cell.q, cell.r, None),
        };
        self.lattice_to_pixel(lattice)
    }

    /// The six corners of `cell`, in side order (corner `k` is shared
    /// by sides `(k + 5) % 6` and `k`; see section 1.3).
    pub fn corners(self, cell: HexCoord) -> Result<[(f32, f32); 6], HexError> {
        let mut out = [(0.0_f32, 0.0_f32); 6];
        for (k, slot) in out.iter_mut().enumerate() {
            let lattice = match self.orientation {
                HexOrientation::FlatTop => flat_top_lattice(cell.q, cell.r, Some(k)),
                HexOrientation::PointyTop => pointy_top_lattice(cell.q, cell.r, Some(k)),
            };
            *slot = self.lattice_to_pixel(lattice)?;
        }
        Ok(out)
    }

    /// The [`Transform2D`] that `Batch::circle((0.0, 0.0), r, 6, color,
    /// t)` needs to fill `cell` (section 1.8).
    pub fn cell_transform(self, cell: HexCoord) -> Result<Transform2D, HexError> {
        let (cx, cy) = self.center(cell)?;
        let translate = Transform2D::translation(cx, cy);
        Ok(match self.orientation {
            HexOrientation::FlatTop => translate,
            HexOrientation::PointyTop => {
                Transform2D::rotation(std::f32::consts::FRAC_PI_6).then(translate)
            }
        })
    }

    /// Selects the cell whose center is nearest to `point` (section
    /// 1.6). Errors with [`HexError::NonFiniteInput`] for a non-finite
    /// component, [`HexError::PixelOutOfRange`] for a finite component
    /// with `|value| > MAX_COORDINATE`, or
    /// [`HexError::CoordinateOutOfRange`] if the selected cell would be
    /// outside the bound (no other cell is substituted).
    pub fn cell_at(self, point: (f32, f32)) -> Result<HexCoord, HexError> {
        if !point.0.is_finite() || !point.1.is_finite() {
            return Err(HexError::NonFiniteInput);
        }
        if point.0.abs() > MAX_COORDINATE || point.1.abs() > MAX_COORDINATE {
            return Err(HexError::PixelOutOfRange);
        }

        let r = f64::from(self.radius);
        let ox = f64::from(self.origin.0);
        let oy = f64::from(self.origin.1);
        let dx = f64::from(point.0) - ox;
        let dy = f64::from(point.1) - oy;

        let (a, b) = match self.orientation {
            HexOrientation::FlatTop => (dx / (r * 0.5), dy / (r * S64)),
            HexOrientation::PointyTop => (dx / (r * S64), dy / (r * 0.5)),
        };
        let (qf, rf) = match self.orientation {
            HexOrientation::FlatTop => {
                let qf = a / 3.0;
                let rf = (b - qf) / 2.0;
                (qf, rf)
            }
            HexOrientation::PointyTop => {
                let qf = (a + b / 3.0) / 2.0;
                let rf = (b / 3.0 - a) / 2.0;
                (qf, rf)
            }
        };
        let sf = -qf - rf;
        let mut q = qf.round();
        let mut rr = rf.round();
        let s = sf.round();
        let dqa = (q - qf).abs();
        let dra = (rr - rf).abs();
        let dsa = (s - sf).abs();
        if dqa > dra && dqa > dsa {
            q = -rr - s;
        } else if dra > dsa {
            rr = -q - s;
        }
        let rounded_q = q as i64;
        let rounded_r = rr as i64;

        let distance = |q: i64, r: i64| -> f64 {
            match self.orientation {
                HexOrientation::FlatTop => {
                    let dq = a - (3 * q) as f64;
                    let dr = b - ((2 * r + q) as f64);
                    dq * dq + 3.0 * dr * dr
                }
                HexOrientation::PointyTop => {
                    let du = a - (q - r) as f64;
                    let dv = b - (3 * (q + r)) as f64;
                    3.0 * du * du + dv * dv
                }
            }
        };

        let mut candidates = [(0_i64, 0_i64); 7];
        candidates[0] = (rounded_q, rounded_r);
        for (slot, &(dq, dr)) in candidates[1..].iter_mut().zip(SIDE_DELTA.iter()) {
            *slot = (rounded_q + i64::from(dq), rounded_r + i64::from(dr));
        }

        let mut best = candidates[0];
        let mut best_d = distance(best.0, best.1);
        for &candidate in &candidates[1..] {
            let d = distance(candidate.0, candidate.1);
            if d < best_d || (d == best_d && candidate < best) {
                best = candidate;
                best_d = d;
            }
        }

        if best.0 < i64::from(HEX_COORD_MIN)
            || best.0 > i64::from(HEX_COORD_MAX)
            || best.1 < i64::from(HEX_COORD_MIN)
            || best.1 > i64::from(HEX_COORD_MAX)
        {
            return Err(HexError::CoordinateOutOfRange);
        }
        Ok(HexCoord {
            q: best.0 as i32,
            r: best.1 as i32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S32: f32 = 0.866_025_4_f32;

    fn flat(radius: f32, origin: (f32, f32)) -> HexLayout {
        HexLayout::new(HexOrientation::FlatTop, radius, origin).unwrap()
    }

    fn pointy(radius: f32, origin: (f32, f32)) -> HexLayout {
        HexLayout::new(HexOrientation::PointyTop, radius, origin).unwrap()
    }

    // --- HexCoord: side table, neighbor, distance ---------------------

    #[test]
    fn side_table_matches_contract_deltas() {
        let expected = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];
        assert_eq!(SIDE_DELTA, expected);
    }

    #[test]
    fn neighbor_then_opposite_returns_origin_cell() {
        let origin = HexCoord::new(5, -3).unwrap();
        for k in 0..6 {
            let n = origin.neighbor(k).unwrap();
            let back = n.neighbor((k + 3) % 6).unwrap();
            assert_eq!(back, origin, "side {k} round trip");
        }
    }

    #[test]
    fn neighbor_rejects_invalid_side() {
        let origin = HexCoord::new(0, 0).unwrap();
        assert_eq!(origin.neighbor(6), Err(HexError::InvalidSide));
    }

    #[test]
    fn neighbor_rejects_overflow_at_the_coordinate_bound() {
        let max_q = HexCoord::new(HEX_COORD_MAX, 0).unwrap();
        assert_eq!(max_q.neighbor(0), Err(HexError::CoordinateOutOfRange));
        let min_q = HexCoord::new(HEX_COORD_MIN, 0).unwrap();
        assert_eq!(min_q.neighbor(3), Err(HexError::CoordinateOutOfRange));
    }

    #[test]
    fn hex_coord_new_rejects_out_of_range() {
        assert_eq!(
            HexCoord::new(HEX_COORD_MAX + 1, 0),
            Err(HexError::CoordinateOutOfRange)
        );
        assert_eq!(
            HexCoord::new(0, HEX_COORD_MIN - 1),
            Err(HexError::CoordinateOutOfRange)
        );
    }

    #[test]
    fn distance_zero_for_equal_cells() {
        let a = HexCoord::new(12, -7).unwrap();
        assert_eq!(a.distance(a), 0);
    }

    #[test]
    fn distance_one_for_each_neighbor() {
        let origin = HexCoord::new(0, 0).unwrap();
        for k in 0..6 {
            let n = origin.neighbor(k).unwrap();
            assert_eq!(origin.distance(n), 1, "side {k}");
        }
    }

    #[test]
    fn distance_at_the_bound_corners() {
        let a = HexCoord::new(HEX_COORD_MIN, HEX_COORD_MAX).unwrap();
        let b = HexCoord::new(HEX_COORD_MAX, HEX_COORD_MIN).unwrap();
        let dq = i64::from(HEX_COORD_MAX) - i64::from(HEX_COORD_MIN);
        let dr = i64::from(HEX_COORD_MIN) - i64::from(HEX_COORD_MAX);
        let expected = ((dq.abs() + dr.abs() + (dq + dr).abs()) / 2) as u32;
        assert_eq!(a.distance(b), expected);
    }

    // --- Literal 3D agreement (section 1.10) ---------------------------

    /// Locks the module's private `KX`/`KZ`/`KU`/`KV` tables against the
    /// literal integers of contract section 1.5, typed in here directly
    /// (not through `flat_top_lattice`/`pointy_top_lattice`). This is the
    /// independent oracle: the test below reuses the module's own helpers
    /// for the center/corner formula, so without this lock a corrupted
    /// private table could still agree with itself.
    #[test]
    fn contract_literal_lattice_tables_match_module_tables() {
        const CONTRACT_KX: [i64; 6] = [2, 1, -1, -2, -1, 1];
        const CONTRACT_KZ: [i64; 6] = [0, 1, 1, 0, -1, -1];
        const CONTRACT_KU: [i64; 6] = [1, 0, -1, -1, 0, 1];
        const CONTRACT_KV: [i64; 6] = [1, 2, 1, -1, -2, -1];
        assert_eq!(KX, CONTRACT_KX, "KX must match contract section 1.5");
        assert_eq!(KZ, CONTRACT_KZ, "KZ must match contract section 1.5");
        assert_eq!(KU, CONTRACT_KU, "KU must match contract section 1.5");
        assert_eq!(KV, CONTRACT_KV, "KV must match contract section 1.5");
    }

    #[test]
    fn literal_3d_agreement_flat_top_center_and_corners() {
        let layout = flat(1.0, (0.0, 0.0));
        let cells = [
            (0, 0),
            (-3, 2),
            (7, -5),
            (HEX_COORD_MIN, HEX_COORD_MAX),
            (HEX_COORD_MAX, HEX_COORD_MIN),
        ];
        for (q, r) in cells {
            let cell = HexCoord::new(q, r).unwrap();
            for k in 0..6 {
                let (x, z) = flat_top_lattice(q, r, Some(k));
                let expected_x = x as f32 * 0.5;
                let expected_y = z as f32 * S32;
                let corner = layout.corners(cell).unwrap()[k];
                assert_eq!(corner.0, expected_x, "cell ({q},{r}) corner {k} x");
                let tol = 4.0 * f32::EPSILON * expected_y.abs().max(1.0);
                assert!(
                    (corner.1 - expected_y).abs() <= tol,
                    "cell ({q},{r}) corner {k} y: {} vs {}",
                    corner.1,
                    expected_y
                );
            }
        }
    }

    // --- Shared corners, both orientations ------------------------------

    #[test]
    fn shared_corners_both_orientations() {
        for layout in [flat(10.0, (0.0, 0.0)), pointy(10.0, (0.0, 0.0))] {
            for (q, r) in [(0, 0), (-4, -3), (-2, 5)] {
                let cell = HexCoord::new(q, r).unwrap();
                let corners = layout.corners(cell).unwrap();
                for k in 0..6 {
                    let n = cell.neighbor(k).unwrap();
                    let n_corners = layout.corners(n).unwrap();
                    assert_eq!(
                        corners[k],
                        n_corners[(k + 4) % 6],
                        "cell ({q},{r}) side {k}"
                    );
                    assert_eq!(
                        corners[(k + 1) % 6],
                        n_corners[(k + 3) % 6],
                        "cell ({q},{r}) side {k} second corner"
                    );
                }
            }
        }
    }

    // --- Geometry: equal sides, radius, orientation relationship -------

    #[test]
    fn geometry_equal_sides_and_radius_both_orientations() {
        for layout in [flat(37.0, (3.0, -4.0)), pointy(37.0, (3.0, -4.0))] {
            let cell = HexCoord::new(2, -1).unwrap();
            let center = layout.center(cell).unwrap();
            let corners = layout.corners(cell).unwrap();
            let radius = layout.radius();
            let tol = 1e-5 * radius;
            for k in 0..6 {
                let dx = corners[k].0 - center.0;
                let dy = corners[k].1 - center.1;
                let d = (dx * dx + dy * dy).sqrt();
                assert!((d - radius).abs() <= tol, "corner {k} distance {d}");
                let next = (k + 1) % 6;
                let ex = corners[next].0 - corners[k].0;
                let ey = corners[next].1 - corners[k].1;
                let side_len = (ex * ex + ey * ey).sqrt();
                let dx0 = corners[1].0 - corners[0].0;
                let dy0 = corners[1].1 - corners[0].1;
                let side0 = (dx0 * dx0 + dy0 * dy0).sqrt();
                assert!(
                    (side_len - side0).abs() <= tol,
                    "side {k} length {side_len}"
                );
            }
        }
    }

    #[test]
    fn pointy_top_corners_are_flat_top_turned_by_30_degrees() {
        let origin = (5.0_f32, -2.0_f32);
        let radius = 50.0_f32;
        let flat_layout = flat(radius, origin);
        let pointy_layout = pointy(radius, origin);
        let cell = HexCoord::new(0, 0).unwrap();
        let flat_corners = flat_layout.corners(cell).unwrap();
        let pointy_corners = pointy_layout.corners(cell).unwrap();
        let (sin, cos) = std::f32::consts::FRAC_PI_6.sin_cos();
        let tol = 1e-5 * radius;
        for k in 0..6 {
            let (fx, fy) = (flat_corners[k].0 - origin.0, flat_corners[k].1 - origin.1);
            // Y-down rotation by +30 deg (clockwise on screen), matching
            // Transform2D::rotation's sign convention.
            let rx = fx * cos - fy * sin;
            let ry = fx * sin + fy * cos;
            let (px, py) = (
                pointy_corners[k].0 - origin.0,
                pointy_corners[k].1 - origin.1,
            );
            assert!((rx - px).abs() <= tol, "corner {k} x: {rx} vs {px}");
            assert!((ry - py).abs() <= tol, "corner {k} y: {ry} vs {py}");
        }
    }

    // --- Round trip ------------------------------------------------------

    #[test]
    fn round_trip_center_and_corners_both_orientations() {
        let radii = [1.0_f32, 40.0_f32, 16_384.0_f32];
        let origins = [(0.0_f32, 0.0_f32), (-123.5_f32, 77.25_f32)];
        let cells = [
            (0, 0),
            (-3, 2),
            (1000, -777),
            (HEX_COORD_MIN, 0),
            (0, HEX_COORD_MAX),
        ];
        for orientation in [HexOrientation::FlatTop, HexOrientation::PointyTop] {
            for radius in radii {
                for origin in origins {
                    let layout = HexLayout::new(orientation, radius, origin).unwrap();
                    for (q, r) in cells {
                        let cell = HexCoord::new(q, r).unwrap();
                        let center = match layout.center(cell) {
                            Ok(c) => c,
                            Err(HexError::PixelOutOfRange) => continue,
                            Err(e) => panic!("unexpected error {e:?}"),
                        };
                        assert_eq!(
                            layout.cell_at(center).unwrap(),
                            cell,
                            "{orientation:?} center round trip"
                        );

                        let corners = match layout.corners(cell) {
                            Ok(c) => c,
                            Err(HexError::PixelOutOfRange) => continue,
                            Err(e) => panic!("unexpected error {e:?}"),
                        };
                        for corner in corners {
                            let cx = f64::from(center.0)
                                + 0.75 * (f64::from(corner.0) - f64::from(center.0));
                            let cy = f64::from(center.1)
                                + 0.75 * (f64::from(corner.1) - f64::from(center.1));
                            let point = (cx as f32, cy as f32);
                            if point.0.abs() > MAX_COORDINATE || point.1.abs() > MAX_COORDINATE {
                                continue;
                            }
                            assert_eq!(
                                layout.cell_at(point).unwrap(),
                                cell,
                                "{orientation:?} 0.75-corner round trip"
                            );
                        }
                    }
                }
            }
        }
    }

    // --- Exact ties -------------------------------------------------------

    #[test]
    fn exact_ties_flat_top() {
        let layout = flat(40.0, (400.0, 300.0));
        let cases: [((f32, f32), (i32, i32)); 4] = [
            ((440.0, 300.0), (0, 0)),
            ((460.0, 300.0), (1, -1)),
            ((340.0, 300.0), (-1, 0)),
            ((360.0, 300.0), (-1, 0)),
        ];
        for (point, expected) in cases {
            for _ in 0..3 {
                let cell = layout.cell_at(point).unwrap();
                assert_eq!((cell.q(), cell.r()), expected, "point {point:?}");
            }
        }
    }

    #[test]
    fn exact_ties_pointy_top() {
        let layout = pointy(40.0, (400.0, 300.0));
        let cases: [((f32, f32), (i32, i32)); 4] = [
            ((400.0, 340.0), (0, 0)),
            ((400.0, 360.0), (0, 1)),
            ((400.0, 240.0), (-1, 0)),
            ((400.0, 260.0), (-1, 0)),
        ];
        for (point, expected) in cases {
            for _ in 0..3 {
                let cell = layout.cell_at(point).unwrap();
                assert_eq!((cell.q(), cell.r()), expected, "point {point:?}");
            }
        }
    }

    // --- Errors -------------------------------------------------------------

    #[test]
    fn layout_new_rejects_non_finite_radius_or_origin() {
        assert_eq!(
            HexLayout::new(HexOrientation::FlatTop, f32::NAN, (0.0, 0.0)),
            Err(HexError::NonFiniteInput)
        );
        assert_eq!(
            HexLayout::new(HexOrientation::FlatTop, f32::INFINITY, (0.0, 0.0)),
            Err(HexError::NonFiniteInput)
        );
        assert_eq!(
            HexLayout::new(HexOrientation::FlatTop, 10.0, (f32::NAN, 0.0)),
            Err(HexError::NonFiniteInput)
        );
        assert_eq!(
            HexLayout::new(HexOrientation::FlatTop, 10.0, (0.0, f32::INFINITY)),
            Err(HexError::NonFiniteInput)
        );
    }

    #[test]
    fn layout_new_rejects_invalid_radius() {
        for radius in [0.0_f32, -1.0, 0.999, 16_384.5] {
            assert_eq!(
                HexLayout::new(HexOrientation::FlatTop, radius, (0.0, 0.0)),
                Err(HexError::InvalidRadius),
                "radius {radius}"
            );
        }
    }

    #[test]
    fn layout_new_rejects_origin_out_of_pixel_bound() {
        assert_eq!(
            HexLayout::new(HexOrientation::FlatTop, 10.0, (MAX_COORDINATE + 1.0, 0.0)),
            Err(HexError::PixelOutOfRange)
        );
    }

    #[test]
    fn cell_at_rejects_non_finite_and_out_of_bound_point() {
        let layout = flat(10.0, (0.0, 0.0));
        assert_eq!(
            layout.cell_at((f32::NAN, 0.0)),
            Err(HexError::NonFiniteInput)
        );
        assert_eq!(
            layout.cell_at((f32::INFINITY, 0.0)),
            Err(HexError::NonFiniteInput)
        );
        assert_eq!(
            layout.cell_at((MAX_COORDINATE + 1.0, 0.0)),
            Err(HexError::PixelOutOfRange)
        );
    }

    #[test]
    fn cell_at_rejects_a_point_selecting_a_cell_outside_the_bound() {
        let layout = flat(1.0, (0.0, 0.0));
        assert_eq!(
            layout.cell_at((98_305.0, 0.0)),
            Err(HexError::CoordinateOutOfRange)
        );
    }

    #[test]
    fn center_rejects_pixel_out_of_range() {
        let layout = flat(16_384.0, (0.0, 0.0));
        let cell = HexCoord::new(HEX_COORD_MAX, 0).unwrap();
        assert_eq!(layout.center(cell), Err(HexError::PixelOutOfRange));
    }

    // --- Existing fan covers both orientations ------------------------------

    #[test]
    fn existing_circle_fan_covers_both_orientations() {
        use crate::color::Color;
        use crate::geometry::circle;

        for layout in [flat(50.0, (0.0, 0.0)), pointy(50.0, (0.0, 0.0))] {
            let cell = HexCoord::new(3, -2).unwrap();
            let transform = layout.cell_transform(cell).unwrap();
            let corners = layout.corners(cell).unwrap();
            let radius = layout.radius();
            let (verts, indices) = circle((0.0, 0.0), radius, 6, Color::WHITE, transform).unwrap();
            assert_eq!(verts.len(), 7);
            assert_eq!(indices.len(), 18);
            for k in 0..6 {
                let rim = verts[k + 1].pos;
                let corner = corners[k];
                let dx = rim[0] - corner.0;
                let dy = rim[1] - corner.1;
                let d = (dx * dx + dy * dy).sqrt();
                let tol = 1e-4 * radius + 4e-3;
                assert!(
                    d <= tol,
                    "orientation {:?} corner {k}: {d} > {tol}",
                    layout.orientation()
                );
            }
        }
    }
}
