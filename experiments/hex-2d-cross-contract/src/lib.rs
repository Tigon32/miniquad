//! Executable cross-contract test, not published and not part of any
//! public crate. See `Cargo.toml` for the prerequisite and portability
//! note, and `docs/hex-2d-contract.md` section 2 for the contract.
//!
//! This crate has no public items of its own: it exists to run
//! `cargo test` and lock the 2D hex module's duplicated lattice tables
//! against the 3D hexagonal-prism voxel module's tables.

#[cfg(test)]
mod tests {
    use miniquad_draw::hex::{HexCoord, HexLayout, HexOrientation};
    use miniquad_voxel::hex::HexCell;

    /// Radius `1.0`, origin `(0.0, 0.0)`: the 2D layout's native unit
    /// scale, matching the 3D crate's fixed `HEX_RADIUS = 1.0` so the
    /// two crates' pixel/world outputs are directly comparable.
    fn unit_layout() -> HexLayout {
        HexLayout::new(HexOrientation::FlatTop, 1.0, (0.0, 0.0))
            .expect("radius 1.0 and origin (0.0, 0.0) are always in bounds")
    }

    /// A representative sample of cells: the origin, small cells in
    /// every direction, and cells near both ends of the shared
    /// `HEX_COORD_MIN..=HEX_COORD_MAX` bound.
    fn sample_cells() -> Vec<(i32, i32)> {
        vec![
            (0, 0),
            (1, 0),
            (0, 1),
            (-1, 1),
            (-1, 0),
            (0, -1),
            (1, -1),
            (3, -2),
            (-5, 7),
            (40, -17),
            (-65_536, 0),
            (65_535, 0),
            (0, -65_536),
            (0, 65_535),
            (65_535, -65_536),
        ]
    }

    /// `x` is calculated from the same integer lattice scaled by a power
    /// of two (`radius * 0.5`) on both sides, so it is bit-equal at
    /// `radius = 1.0` (contract section 2: "`x` is bit-equal").
    fn assert_x_bit_equal(a: f32, b: f32, what: &str) {
        assert_eq!(
            a, b,
            "{what}: 2D/3D x values must be bit-equal ({a} vs {b})"
        );
    }

    /// `z`/`v` scales the lattice by `sqrt(3) / 2`, an irrational
    /// constant: the 2D path rounds it from `f64`, the 3D path uses a
    /// fixed `f32` literal, so the two can differ by a representable
    /// rounding step. Contract section 2 bounds this at
    /// `4 * f32::EPSILON * max(1, |z|)`.
    fn assert_z_within_contract_tolerance(a: f32, b: f32, what: &str) {
        let tolerance = 4.0 * f32::EPSILON * a.abs().max(b.abs()).max(1.0);
        assert!(
            (a - b).abs() <= tolerance,
            "{what} mismatch: 2D/3D values {a} vs {b} (tolerance {tolerance})"
        );
    }

    #[test]
    fn center_matches_3d_world_x_z_mapping() {
        for (q, r) in sample_cells() {
            let cell_2d = HexCoord::new(q, r).expect("sample coordinate is in bounds");
            let (x2, y2) = unit_layout()
                .center(cell_2d)
                .expect("sample coordinate stays within the pixel bound");

            let cell_3d = HexCell::new(q, r, 0).expect("sample coordinate is in bounds");
            let [x3, _y3, z3] = cell_3d.center();

            // The 3D contract maps world (x, z) to 2D (u, v) as
            // u = x, v = z (docs/hex-voxel-contract.md section 1.10).
            assert_x_bit_equal(x2, x3, &format!("center x at ({q}, {r})"));
            assert_z_within_contract_tolerance(y2, z3, &format!("center v/z at ({q}, {r})"));
        }
    }

    #[test]
    fn corners_match_3d_bottom_ring() {
        for (q, r) in sample_cells() {
            let cell_2d = HexCoord::new(q, r).expect("sample coordinate is in bounds");
            let corners_2d = unit_layout()
                .corners(cell_2d)
                .expect("sample coordinate stays within the pixel bound");

            let cell_3d = HexCell::new(q, r, 0).expect("sample coordinate is in bounds");
            let corners_3d = cell_3d.corners();

            for k in 0..6 {
                let (x2, y2) = corners_2d[k];
                let [x3, _y3, z3] = corners_3d[k];
                assert_x_bit_equal(x2, x3, &format!("corner {k} x at ({q}, {r})"));
                assert_z_within_contract_tolerance(
                    y2,
                    z3,
                    &format!("corner {k} v/z at ({q}, {r})"),
                );
            }
        }
    }

    #[test]
    fn neighbor_delta_table_matches_3d_side_faces() {
        use miniquad_voxel::hex::HexFace;

        // Contract section 1.10: the origin, both interior samples
        // `(-3, 2)` and `(7, -5)`, and both ends of the shared
        // `HEX_COORD_MIN..=HEX_COORD_MAX` bound.
        let base_cells = [(0, 0), (-3, 2), (7, -5), (-65_536, 0), (65_535, 0)];

        for (q, r) in base_cells {
            let origin_2d = HexCoord::new(q, r).expect("base coordinate is in bounds");
            let origin_3d = HexCell::new(q, r, 0).expect("base coordinate is in bounds");

            for (k, face) in HexFace::SIDES.iter().enumerate() {
                let neighbor_2d = match origin_2d.neighbor(k) {
                    Ok(neighbor) => neighbor,
                    Err(_) => continue,
                };
                let neighbor_3d = match origin_3d.neighbor(*face) {
                    Ok(neighbor) => neighbor,
                    Err(_) => continue,
                };

                assert_eq!(
                    (neighbor_2d.q(), neighbor_2d.r()),
                    (neighbor_3d.q(), neighbor_3d.r()),
                    "2D side {k} neighbor of ({q}, {r}) disagrees with 3D face {face:?}"
                );
            }
        }
    }

    #[test]
    fn cell_at_recovers_cell_from_3d_center() {
        // Contract section 1.10: `cell_at` at the 3D center `(x, z)`
        // round-trips back to the originating `(q, r)`.
        for (q, r) in sample_cells() {
            let cell_3d = HexCell::new(q, r, 0).expect("sample coordinate is in bounds");
            let [x3, _y3, z3] = cell_3d.center();

            let recovered = unit_layout()
                .cell_at((x3, z3))
                .expect("a 3D cell center always resolves to a 2D cell");

            assert_eq!(
                (recovered.q(), recovered.r()),
                (q, r),
                "cell_at did not recover ({q}, {r}) from 3D center ({x3}, {z3})"
            );
        }
    }

    #[test]
    fn distance_matches_3d_planar_distance() {
        let a2 = HexCoord::new(-5, 7).expect("sample coordinate is in bounds");
        let b2 = HexCoord::new(3, -2).expect("sample coordinate is in bounds");
        let a3 = HexCell::new(-5, 7, 0).expect("sample coordinate is in bounds");
        let b3 = HexCell::new(3, -2, 0).expect("sample coordinate is in bounds");

        assert_eq!(a2.distance(b2), a3.planar_distance(b3));
    }
}
