//! Analytic, deterministic hexagonal-prism picking: pixel to ray, then a
//! bounded walk through hex prism cells.
//!
//! This module implements section 2 of `docs/hex-voxel-contract.md`
//! (frozen design contract for #131). It uses only the public items of
//! [`crate::hex`] and [`crate::camera::OrbitCamera`]. Pure Rust, no
//! `unsafe`, no I/O. All picking math is `f64`, independent of the
//! `f32` rendering path, so picking stays accurate at the coordinate
//! bound (section 1.3 of the contract).
//!
//! The two determinism rules (contract section 2.3 and 2.4) are named
//! here as they are in the contract: **tie rule A** (point to cell)
//! and **tie rule B** (walk exit).

use crate::camera::OrbitCamera;
use crate::hex::{HexCell, HexError, HexFace};
use crate::world::World;

/// Largest permitted number of cell-steps in one [`pick_hex`] walk.
pub const HEX_PICK_MAX_STEPS: u32 = 4_096;
/// Largest permitted `viewport` component, in backing-store pixels.
pub const HEX_PICK_MAX_VIEWPORT: f64 = 16_384.0;

/// A ray: `origin` in world space, `dir` a **unit-length** direction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexRay {
    pub origin: [f64; 3],
    pub dir: [f64; 3],
}

/// Bounds for one [`pick_hex`] walk.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexPickParams {
    pub max_distance: f64,
    pub max_steps: u32,
    pub min_layer: i32,
    pub max_layer: i32,
}

/// One successful pick: the hit cell, the entered face (`None` only
/// when the ray origin already starts inside the hit cell's layer
/// slab with no face crossed), and the ray distance to the hit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexHit {
    pub cell: HexCell,
    pub face: Option<HexFace>,
    pub distance: f64,
}

/// An error from [`ray_from_pixel`] or [`pick_hex`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexPickError {
    InvalidViewport,
    InvalidPixel,
    InvalidCamera,
    InvalidParams,
}

impl std::fmt::Display for HexPickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            HexPickError::InvalidViewport => "viewport must be finite, positive, and bounded",
            HexPickError::InvalidPixel => "pixel must be finite and within the viewport",
            HexPickError::InvalidCamera => "camera produced a non-finite or degenerate ray",
            HexPickError::InvalidParams => "pick parameters or ray are invalid",
        };
        f.write_str(message)
    }
}

impl std::error::Error for HexPickError {}

const HALF_FOV_Y_RADIANS: f64 = 22.5 * std::f64::consts::PI / 180.0; // half of 45 degrees (camera.rs)
const APOTHEM: f64 = 0.866_025_403_784_438_6; // sqrt(3)/2, exact to f64 precision
const LAYER_HEIGHT: f64 = crate::hex::HEX_LAYER_HEIGHT as f64;

fn column_center(q: i32, r: i32) -> [f64; 2] {
    // Keep analytic ties independent of the mesh's f32 rounding.
    [1.5 * q as f64, (2.0 * r as f64 + q as f64) * APOTHEM]
}

fn finite3(v: [f64; 3]) -> bool {
    v.iter().all(|c| c.is_finite())
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn length3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}

/// Returns a unit-length vector, or `None` for a zero-length or
/// non-finite input.
fn normalize3(a: [f64; 3]) -> Option<[f64; 3]> {
    if !finite3(a) {
        return None;
    }
    let len = length3(a);
    if !(len.is_finite()) || len <= 1e-12 {
        return None;
    }
    Some(scale3(a, 1.0 / len))
}

/// Builds an analytic pixel-to-ray for `camera`, per contract section
/// 2.2. `pixel` and `viewport` are in backing-store pixels (CSS pixels
/// times device pixel ratio), so device pixel ratio 1 and 2 produce
/// the same world-space ray for the same CSS-relative pixel.
pub fn ray_from_pixel(
    camera: &OrbitCamera,
    pixel: [f64; 2],
    viewport: [f64; 2],
) -> Result<HexRay, HexPickError> {
    let [w, h] = viewport;
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0)
        || w > HEX_PICK_MAX_VIEWPORT
        || h > HEX_PICK_MAX_VIEWPORT
    {
        return Err(HexPickError::InvalidViewport);
    }
    let [px, py] = pixel;
    if !(px.is_finite() && py.is_finite()) || px < 0.0 || px > w || py < 0.0 || py > h {
        return Err(HexPickError::InvalidPixel);
    }

    let ndc_x = 2.0 * px / w - 1.0;
    let ndc_y = 1.0 - 2.0 * py / h;
    let aspect = w / h;
    let t = HALF_FOV_Y_RADIANS.tan();

    let target = [
        camera.target.x as f64,
        camera.target.y as f64,
        camera.target.z as f64,
    ];
    let distance = camera.distance as f64;
    let yaw = camera.yaw as f64;
    let pitch = camera.pitch as f64;
    let eye = add3(
        target,
        [
            distance * pitch.cos() * yaw.sin(),
            distance * pitch.sin(),
            distance * pitch.cos() * yaw.cos(),
        ],
    );

    let forward = match normalize3(sub3(target, eye)) {
        Some(f) => f,
        None => return Err(HexPickError::InvalidCamera),
    };
    let up_hint = [0.0, 1.0, 0.0];
    let right = match normalize3(cross3(forward, up_hint)) {
        Some(s) => s,
        None => return Err(HexPickError::InvalidCamera),
    };
    let up = cross3(right, forward);

    let dir_unnormalized = add3(
        add3(forward, scale3(right, ndc_x * t * aspect)),
        scale3(up, ndc_y * t),
    );
    let dir = match normalize3(dir_unnormalized) {
        Some(d) => d,
        None => return Err(HexPickError::InvalidCamera),
    };
    if !finite3(eye) {
        return Err(HexPickError::InvalidCamera);
    }
    Ok(HexRay { origin: eye, dir })
}

/// Returns the hex cell whose center (in the `x`-`z` plane) is nearest
/// `(x, z)`, at the given `layer`. Implements contract section 2.3,
/// including **tie rule A**: at equal distance, the smallest `(q, r)`
/// in lexicographic order wins.
pub fn hex_cell_at_xz(x: f64, z: f64, layer: i32) -> Result<HexCell, HexError> {
    if !(x.is_finite() && z.is_finite()) {
        return Err(HexError::CoordinateOutOfRange);
    }
    // Invert the analytic center formula of contract section 2.3.
    let q_frac = x / 1.5;
    let two_r_plus_q = z / APOTHEM;
    let r_frac = (two_r_plus_q - q_frac) / 2.0;

    // Standard axial-to-cube rounding: s = -q - r.
    let s_frac = -q_frac - r_frac;
    let mut rq = q_frac.round();
    let mut rr = r_frac.round();
    let rs = s_frac.round();
    let dq = (rq - q_frac).abs();
    let dr = (rr - r_frac).abs();
    let ds = (rs - s_frac).abs();
    if dq > dr && dq > ds {
        rq = -rr - rs;
    } else if dr > ds {
        rr = -rq - rs;
    }
    let candidate_q = rq as i32;
    let candidate_r = rr as i32;

    // Compare the rounded candidate and its 6 neighbors by squared
    // distance to the actual query point, tie-broken by tie rule A.
    let mut best: Option<(i32, i32, f64)> = None;
    let mut consider = |q: i32, r: i32| {
        let [cx, cz] = column_center(q, r);
        let ddx = cx - x;
        let ddz = cz - z;
        let dist2 = ddx * ddx + ddz * ddz;
        best = Some(match best {
            None => (q, r, dist2),
            Some((bq, br, bdist)) => {
                if dist2 < bdist - 1e-9 || ((dist2 - bdist).abs() <= 1e-9 && (q, r) < (bq, br)) {
                    (q, r, dist2)
                } else {
                    (bq, br, bdist)
                }
            }
        });
    };
    consider(candidate_q, candidate_r);
    for face in HexFace::SIDES {
        let (dq, dr, _dlayer) = face.delta();
        if let (Some(q), Some(r)) = (candidate_q.checked_add(dq), candidate_r.checked_add(dr)) {
            consider(q, r);
        }
    }
    match best {
        Some((q, r, _)) => HexCell::new(q, r, layer),
        None => Err(HexError::CoordinateOutOfRange),
    }
}

/// Reports whether the hex cell is solid: resolves `cell` to its
/// owning chunk and local coordinate, then queries the chunk. A cell
/// whose chunk is not resident, or whose coordinate is out of the hex
/// coordinate bound, is treated as **not solid** (air), matching the
/// cubic `World::is_solid` missing-neighbor policy.
fn is_cell_solid(world: &World, cell: HexCell) -> bool {
    let Ok((coord, local)) = cell.to_chunk_local(world.dims()) else {
        return false;
    };
    match world.get(coord) {
        Some(chunk) => chunk.is_solid(local[0], local[1], local[2]),
        None => false,
    }
}

/// Clips `[t0, t1]` to the inclusive range `[lo, hi]`. Returns `None`
/// if the ranges do not overlap.
fn clip_range(t0: f64, t1: f64, lo: f64, hi: f64) -> Option<(f64, f64)> {
    let a = t0.max(lo);
    let b = t1.min(hi);
    if a <= b {
        Some((a, b))
    } else {
        None
    }
}

/// Walks a ray through hex prism cells and returns the first solid
/// cell and the face through which the ray entered it, per contract
/// section 2.4. Implements **tie rule B**: at an equal side-exit
/// distance (an edge or vertex crossing), the lowest face index wins.
pub fn pick_hex(
    world: &World,
    ray: &HexRay,
    params: &HexPickParams,
) -> Result<Option<HexHit>, HexPickError> {
    if !(params.max_distance.is_finite() && params.max_distance > 0.0)
        || !(1..=HEX_PICK_MAX_STEPS).contains(&params.max_steps)
        || params.min_layer > params.max_layer
        || params.min_layer < crate::hex::HEX_COORD_MIN
        || params.max_layer > crate::hex::HEX_COORD_MAX
    {
        return Err(HexPickError::InvalidParams);
    }
    if !finite3(ray.origin) || !finite3(ray.dir) {
        return Err(HexPickError::InvalidParams);
    }
    let dir_len = length3(ray.dir);
    if (dir_len - 1.0).abs() > 1e-9 {
        return Err(HexPickError::InvalidParams);
    }

    let slab_lo = params.min_layer as f64 * LAYER_HEIGHT;
    let slab_hi = (params.max_layer as f64 + 1.0) * LAYER_HEIGHT;
    let oy = ray.origin[1];
    let dy = ray.dir[1];

    // Clip to the layer slab along y.
    let y_interval = if dy.abs() <= 1e-12 {
        if oy >= slab_lo && oy <= slab_hi {
            Some((f64::NEG_INFINITY, f64::INFINITY))
        } else {
            None
        }
    } else {
        let t_a = (slab_lo - oy) / dy;
        let t_b = (slab_hi - oy) / dy;
        Some((t_a.min(t_b), t_a.max(t_b)))
    };
    let Some((y_t0, y_t1)) = y_interval else {
        return Ok(None);
    };
    let Some((t0, t1)) = clip_range(y_t0, y_t1, 0.0, params.max_distance) else {
        return Ok(None);
    };

    // Entry face: Top if the clipped entry is the slab's top boundary
    // and the ray is descending into it; Bottom if it is the slab's
    // bottom boundary and the ray is ascending into it; None if the
    // entry is the t=0 distance boundary (origin already in the slab).
    let mut entry_face = if t0 <= 0.0 + 1e-12 {
        None
    } else if dy < 0.0 {
        Some(HexFace::Top)
    } else if dy > 0.0 {
        Some(HexFace::Bottom)
    } else {
        None
    };

    let mut t = t0;
    let mut steps: u32 = 0;
    let start_point = add3(ray.origin, scale3(ray.dir, t));
    let mut cell_q_r = {
        let Ok(cell) = hex_cell_at_xz(start_point[0], start_point[2], params.min_layer) else {
            return Ok(None);
        };
        (cell.q(), cell.r())
    };

    while t <= t1 + 1e-9 && steps < params.max_steps {
        let (q, r) = cell_q_r;
        let [cx, cz] = column_center(q, r);

        // Column exit: smallest t_k among the six side planes with
        // the ray moving outward through that side (tie rule B: on an
        // equal t_k, the lowest face index wins).
        let mut best_exit: Option<(usize, f64)> = None;
        for face in HexFace::SIDES {
            let (dq, dr, _) = face.delta();
            let nx = dq as f64 * APOTHEM;
            let nz = (2 * dr + dq) as f64 * 0.5;
            let d_dot_n = ray.dir[0] * nx + ray.dir[2] * nz;
            if d_dot_n <= 1e-12 {
                continue;
            }
            let o_minus_c = [ray.origin[0] - cx, 0.0, ray.origin[2] - cz];
            let num = APOTHEM - (o_minus_c[0] * nx + o_minus_c[2] * nz);
            let t_k = num / d_dot_n;
            if t_k < t - 1e-9 {
                continue;
            }
            best_exit = Some(match best_exit {
                None => (face.index(), t_k),
                Some((bi, bt)) => {
                    if t_k < bt - 1e-9 || ((t_k - bt).abs() <= 1e-9 && face.index() < bi) {
                        (face.index(), t_k)
                    } else {
                        (bi, bt)
                    }
                }
            });
        }
        let column_t_out = match best_exit {
            Some((_, t_k)) => t_k.min(t1),
            None => t1, // dx = dz = 0: stays in the start column.
        };
        if column_t_out < t {
            return Ok(None);
        }

        // Visit the layers crossed in this column, in ray order.
        let mut layer_t = t;
        let mut current_entry_face = entry_face;
        let p = add3(ray.origin, scale3(ray.dir, layer_t));
        let Some(mut layer) = layer_at_y(p[1], dy, params.min_layer, params.max_layer) else {
            return Ok(None);
        };
        loop {
            if layer_t > column_t_out + 1e-9 || steps >= params.max_steps {
                break;
            }
            let cell = match HexCell::new(q, r, layer) {
                Ok(cell) => cell,
                Err(_) => return Ok(None),
            };
            steps += 1;
            if is_cell_solid(world, cell) {
                return Ok(Some(HexHit {
                    cell,
                    face: current_entry_face,
                    distance: layer_t.max(0.0),
                }));
            }
            // Advance to the next layer boundary in ray-order.
            let next_boundary_y = if dy > 0.0 {
                (layer as f64 + 1.0) * LAYER_HEIGHT
            } else if dy < 0.0 {
                layer as f64 * LAYER_HEIGHT
            } else {
                break; // horizontal within this column: one layer only.
            };
            let t_next = (next_boundary_y - ray.origin[1]) / dy;
            if !(t_next.is_finite()) || t_next <= layer_t {
                break;
            }
            if (dy > 0.0 && layer == params.max_layer) || (dy < 0.0 && layer == params.min_layer) {
                break;
            }
            layer += if dy > 0.0 { 1 } else { -1 };
            layer_t = t_next;
            current_entry_face = if dy > 0.0 {
                Some(HexFace::Bottom)
            } else {
                Some(HexFace::Top)
            };
        }

        if steps >= params.max_steps {
            return Ok(None);
        }
        match best_exit {
            Some((face_index, t_k)) if t_k <= t1 + 1e-9 => {
                let face = HexFace::SIDES[face_index];
                let next_cell = match HexCell::new(q, r, params.min_layer)
                    .and_then(|cell| cell.neighbor(face))
                {
                    Ok(cell) => cell,
                    Err(_) => return Ok(None),
                };
                cell_q_r = (next_cell.q(), next_cell.r());
                entry_face = Some(face.opposite());
                t = t_k;
            }
            _ => return Ok(None),
        }
    }
    Ok(None)
}

/// Selects the layer the ray moves into. Do not clamp an outward ray
/// to a solid layer it does not enter.
fn layer_at_y(y: f64, dy: f64, min_layer: i32, max_layer: i32) -> Option<i32> {
    let fractional = y / LAYER_HEIGHT;
    let layer = if dy < 0.0 {
        fractional.ceil() - 1.0
    } else {
        fractional.floor()
    };
    if layer >= min_layer as f64 && layer <= max_layer as f64 {
        Some(layer as i32)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world_with_cell(cell: HexCell) -> World {
        let dims = crate::chunk::ChunkDims::new(4, 4, 4);
        let mut world = World::new(dims, 1).unwrap();
        let (coord, local) = cell.to_chunk_local(dims).unwrap();
        let mut chunk = crate::chunk::Chunk::new(dims).unwrap();
        chunk.set(local[0], local[1], local[2], 1).unwrap();
        world.insert(coord, chunk).unwrap();
        world
    }

    fn pick_params() -> HexPickParams {
        HexPickParams {
            max_distance: 20.0,
            max_steps: 100,
            min_layer: 0,
            max_layer: 3,
        }
    }

    #[test]
    fn vertex_ties_select_the_smallest_axial_coordinate() {
        for _ in 0..3 {
            assert_eq!(
                hex_cell_at_xz(1.0, 0.0, 1).unwrap(),
                HexCell::new(0, 0, 1).unwrap()
            );
            assert_eq!(
                hex_cell_at_xz(-1.0, 0.0, 1).unwrap(),
                HexCell::new(-1, 0, 1).unwrap()
            );
        }
    }

    #[test]
    fn points_in_out_of_range_cells_are_not_clamped_to_a_valid_neighbor() {
        for q in [crate::hex::HEX_COORD_MIN - 1, crate::hex::HEX_COORD_MAX + 1] {
            assert_eq!(
                hex_cell_at_xz(q as f64 * 1.5, q as f64 * APOTHEM, 1),
                Err(HexError::CoordinateOutOfRange),
            );
        }
    }

    #[test]
    fn points_inside_each_edge_select_the_cell_at_negative_and_large_coordinates() {
        for (q, r) in [(0, 0), (-3, -4), (65_534, -65_535)] {
            let cell = HexCell::new(q, r, 1).unwrap();
            let center = cell.center();
            for face in HexFace::SIDES {
                let normal = face.normal();
                for _ in 0..3 {
                    let picked = hex_cell_at_xz(
                        center[0] as f64 + (APOTHEM - 0.01) * normal[0] as f64,
                        center[2] as f64 + (APOTHEM - 0.01) * normal[2] as f64,
                        1,
                    )
                    .unwrap();
                    assert_eq!(picked, cell, "edge {face:?} at ({q}, {r})");
                }
            }
        }
    }

    #[test]
    fn horizontal_rays_hit_each_side_across_missing_and_negative_chunks() {
        for (q, r) in [(-1, -2), (3, 0)] {
            let cell = HexCell::new(q, r, 1).unwrap();
            let world = world_with_cell(cell);
            let center = cell.center();
            for face in HexFace::SIDES {
                let normal = face.normal();
                let outward = normalize3([normal[0] as f64, 0.0, normal[2] as f64]).unwrap();
                let ray = HexRay {
                    origin: add3(
                        [center[0] as f64, center[1] as f64, center[2] as f64],
                        scale3(outward, 2.0),
                    ),
                    dir: scale3(outward, -1.0),
                };
                for _ in 0..3 {
                    let hit = pick_hex(&world, &ray, &pick_params()).unwrap().unwrap();
                    assert_eq!(hit.cell, cell, "entry from {face:?} at ({q}, {r})");
                    assert_eq!(hit.face, Some(face));
                    assert!((hit.distance - (2.0 - APOTHEM)).abs() < 1e-6);
                }
            }
        }
    }

    #[test]
    fn a_vertex_crossing_uses_the_lowest_exit_face_index() {
        let cell = HexCell::new(1, 0, 1).unwrap();
        let world = world_with_cell(cell);
        let ray = HexRay {
            origin: [0.0, 1.5, 0.0],
            dir: [1.0, 0.0, 0.0],
        };
        for _ in 0..3 {
            let hit = pick_hex(&world, &ray, &pick_params()).unwrap().unwrap();
            assert_eq!(hit.cell, cell);
            assert_eq!(hit.face, Some(HexFace::NegQ));
            assert!((hit.distance - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn distance_and_step_bounds_stop_before_a_solid_neighbor() {
        let cell = HexCell::new(0, 1, 1).unwrap();
        let world = world_with_cell(cell);
        let ray = HexRay {
            origin: [0.0, 1.5, 0.0],
            dir: [0.0, 0.0, 1.0],
        };
        let limited_distance = HexPickParams {
            max_distance: 0.5,
            ..pick_params()
        };
        let limited_steps = HexPickParams {
            max_steps: 1,
            ..pick_params()
        };
        for _ in 0..3 {
            assert_eq!(pick_hex(&world, &ray, &limited_distance).unwrap(), None);
            assert_eq!(pick_hex(&world, &ray, &limited_steps).unwrap(), None);
            assert_eq!(
                pick_hex(&world, &ray, &pick_params())
                    .unwrap()
                    .unwrap()
                    .cell,
                cell
            );
        }
    }

    #[test]
    fn invalid_viewport_is_rejected() {
        let camera = OrbitCamera::new(crate::math::Vec3::ZERO, 10.0, 0.0, 0.3);
        assert_eq!(
            ray_from_pixel(&camera, [1.0, 1.0], [0.0, 1.0]).unwrap_err(),
            HexPickError::InvalidViewport
        );
        assert_eq!(
            ray_from_pixel(&camera, [1.0, 1.0], [f64::NAN, 1.0]).unwrap_err(),
            HexPickError::InvalidViewport
        );
        assert_eq!(
            ray_from_pixel(&camera, [1.0, 1.0], [HEX_PICK_MAX_VIEWPORT + 1.0, 1.0]).unwrap_err(),
            HexPickError::InvalidViewport
        );
    }

    #[test]
    fn invalid_pixel_is_rejected() {
        let camera = OrbitCamera::new(crate::math::Vec3::ZERO, 10.0, 0.0, 0.3);
        assert_eq!(
            ray_from_pixel(&camera, [-1.0, 1.0], [100.0, 100.0]).unwrap_err(),
            HexPickError::InvalidPixel
        );
        assert_eq!(
            ray_from_pixel(&camera, [200.0, 1.0], [100.0, 100.0]).unwrap_err(),
            HexPickError::InvalidPixel
        );
    }

    #[test]
    fn ray_from_pixel_is_unit_length_for_a_valid_input() {
        let camera = OrbitCamera::new(crate::math::Vec3::ZERO, 10.0, 0.4, 0.3);
        let ray = ray_from_pixel(&camera, [50.0, 50.0], [100.0, 100.0]).unwrap();
        let len =
            (ray.dir[0] * ray.dir[0] + ray.dir[1] * ray.dir[1] + ray.dir[2] * ray.dir[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ray_from_pixel_matches_at_dpr_1_and_2() {
        let camera = OrbitCamera::new(crate::math::Vec3::ZERO, 10.0, 0.4, 0.3);
        let a = ray_from_pixel(&camera, [50.0, 50.0], [100.0, 100.0]).unwrap();
        let b = ray_from_pixel(&camera, [100.0, 100.0], [200.0, 200.0]).unwrap();
        for i in 0..3 {
            assert!((a.dir[i] - b.dir[i]).abs() < 1e-9);
            assert!((a.origin[i] - b.origin[i]).abs() < 1e-9);
        }
    }

    #[test]
    fn ray_from_projected_pixel_passes_through_the_world_point() {
        let camera = OrbitCamera::new(crate::math::Vec3::new(0.0, 1.5, 0.0), 14.0, 0.6, 0.5);
        for viewport in [[640.0, 360.0], [1280.0, 720.0]] {
            let matrix = camera
                .projection_matrix((viewport[0] / viewport[1]) as f32)
                .mul(&camera.view_matrix());
            for point in [[0.0, 1.5, 0.0], [3.0, 4.0, 2.0], [-1.5, 4.0, 0.0]] {
                let clip: [f64; 4] = std::array::from_fn(|row| {
                    matrix.0[row] as f64 * point[0]
                        + matrix.0[4 + row] as f64 * point[1]
                        + matrix.0[8 + row] as f64 * point[2]
                        + matrix.0[12 + row] as f64
                });
                let pixel = [
                    (clip[0] / clip[3] + 1.0) * viewport[0] * 0.5,
                    (1.0 - clip[1] / clip[3]) * viewport[1] * 0.5,
                ];
                let ray = ray_from_pixel(&camera, pixel, viewport).unwrap();
                let offset = sub3(point, ray.origin);
                assert!(dot3(offset, ray.dir) > 0.0);
                assert!(length3(cross3(offset, ray.dir)) < 1e-4);
            }
        }
    }

    #[test]
    fn hex_cell_at_xz_picks_the_origin_cell_at_its_center() {
        let cell = hex_cell_at_xz(0.0, 0.0, 0).unwrap();
        assert_eq!((cell.q(), cell.r()), (0, 0));
    }

    #[test]
    fn hex_cell_at_xz_rejects_non_finite_input() {
        assert_eq!(
            hex_cell_at_xz(f64::NAN, 0.0, 0).unwrap_err(),
            HexError::CoordinateOutOfRange
        );
    }

    #[test]
    fn hex_cell_at_xz_rejects_extreme_finite_coordinates_without_panicking() {
        for (x, z) in [
            (f64::MAX, 0.0),
            (f64::MIN, 0.0),
            (0.0, f64::MAX),
            (0.0, f64::MIN),
        ] {
            assert_eq!(hex_cell_at_xz(x, z, 0), Err(HexError::CoordinateOutOfRange));
        }
    }

    #[test]
    fn vertical_ray_crosses_empty_layers_before_the_first_solid_cell() {
        let dims = crate::chunk::ChunkDims::new(4, 4, 4);
        let mut world = World::new(dims, 1).unwrap();
        let mut chunk = crate::chunk::Chunk::new(dims).unwrap();
        chunk.set(0, 1, 0, 1).unwrap();
        world
            .insert(crate::world::ChunkCoord::new(0, 0, 0), chunk)
            .unwrap();
        let params = HexPickParams {
            max_distance: 20.0,
            max_steps: 20,
            min_layer: 0,
            max_layer: 3,
        };
        for (origin_y, direction_y, distance, face) in [
            (10.0, -1.0, 8.0, HexFace::Top),
            (-10.0, 1.0, 11.0, HexFace::Bottom),
        ] {
            let hit = pick_hex(
                &world,
                &HexRay {
                    origin: [0.0, origin_y, 0.0],
                    dir: [0.0, direction_y, 0.0],
                },
                &params,
            )
            .unwrap()
            .expect("the ray must reach the solid layer");
            assert_eq!(hit.cell, HexCell::new(0, 0, 1).unwrap());
            assert_eq!(hit.face, Some(face));
            assert_eq!(hit.distance, distance);
        }
    }

    #[test]
    fn rays_leaving_the_layer_slab_do_not_hit_a_clamped_boundary_cell() {
        for (layer, origin_y, direction_y) in [(0, 0.0, -1.0), (3, 4.0, 1.0)] {
            let world = world_with_cell(HexCell::new(0, 0, layer).unwrap());
            let ray = HexRay {
                origin: [0.0, origin_y, 0.0],
                dir: [0.0, direction_y, 0.0],
            };
            assert_eq!(pick_hex(&world, &ray, &pick_params()).unwrap(), None);
            let inward = HexRay {
                dir: [0.0, -direction_y, 0.0],
                ..ray
            };
            let hit = pick_hex(&world, &inward, &pick_params()).unwrap().unwrap();
            assert_eq!(hit.cell, HexCell::new(0, 0, layer).unwrap());
            assert_eq!(hit.distance, 0.0);
        }
    }

    #[test]
    fn oblique_rays_enter_the_boundary_layer_after_slab_clipping() {
        let cell = HexCell::new(0, 0, 3).unwrap();
        let world = world_with_cell(cell);
        for direction in [[0.2, -1.0, 0.3], [0.7, -1.0, -0.4], [-0.3, -1.0, 0.8]] {
            let dir = normalize3(direction).unwrap();
            for distance in [1.0, 3.0, 7.0, 9.0, 12.0] {
                let ray = HexRay {
                    origin: sub3([0.0, 4.0, 0.0], scale3(dir, distance)),
                    dir,
                };
                let hit = pick_hex(&world, &ray, &pick_params())
                    .unwrap()
                    .unwrap_or_else(|| panic!("missed top at {direction:?}, distance {distance}"));
                assert_eq!(hit.cell, cell);
                assert_eq!(hit.face, Some(HexFace::Top));
                assert!((hit.distance - distance).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn invalid_pick_params_are_rejected() {
        let world = World::new(crate::chunk::ChunkDims::new(4, 4, 4), 4).unwrap();
        let ray = HexRay {
            origin: [0.0, 0.0, 0.0],
            dir: [0.0, -1.0, 0.0],
        };
        let bad = HexPickParams {
            max_distance: -1.0,
            max_steps: 10,
            min_layer: 0,
            max_layer: 3,
        };
        assert_eq!(
            pick_hex(&world, &ray, &bad).unwrap_err(),
            HexPickError::InvalidParams
        );
        let bad_steps = HexPickParams {
            max_distance: 10.0,
            max_steps: 0,
            min_layer: 0,
            max_layer: 3,
        };
        assert_eq!(
            pick_hex(&world, &ray, &bad_steps).unwrap_err(),
            HexPickError::InvalidParams
        );
        let non_unit_ray = HexRay {
            origin: [0.0, 0.0, 0.0],
            dir: [0.0, -2.0, 0.0],
        };
        let ok_params = HexPickParams {
            max_distance: 10.0,
            max_steps: 10,
            min_layer: 0,
            max_layer: 3,
        };
        assert_eq!(
            pick_hex(&world, &non_unit_ray, &ok_params).unwrap_err(),
            HexPickError::InvalidParams
        );
    }

    #[test]
    fn horizontal_ray_above_terrain_gives_no_hit() {
        let world = World::new(crate::chunk::ChunkDims::new(4, 4, 4), 4).unwrap();
        let ray = HexRay {
            origin: [0.0, 100.0, 0.0],
            dir: [1.0, 0.0, 0.0],
        };
        let params = HexPickParams {
            max_distance: 50.0,
            max_steps: 100,
            min_layer: 0,
            max_layer: 3,
        };
        assert_eq!(pick_hex(&world, &ray, &params).unwrap(), None);
    }

    #[test]
    fn missing_chunk_gives_no_hit() {
        let world = World::new(crate::chunk::ChunkDims::new(4, 4, 4), 4).unwrap();
        let ray = HexRay {
            origin: [0.0, 10.0, 0.0],
            dir: [0.0, -1.0, 0.0],
        };
        let params = HexPickParams {
            max_distance: 20.0,
            max_steps: 100,
            min_layer: 0,
            max_layer: 3,
        };
        assert_eq!(pick_hex(&world, &ray, &params).unwrap(), None);
    }

    #[test]
    fn a_valid_ray_outside_the_coordinate_bound_gives_no_hit() {
        let world = world_with_cell(HexCell::new(0, 0, 1).unwrap());
        for q in [crate::hex::HEX_COORD_MIN - 1, crate::hex::HEX_COORD_MAX + 1] {
            let [x, z] = column_center(q, 0);
            let ray = HexRay {
                origin: [x, 10.0, z],
                dir: [0.0, -1.0, 0.0],
            };
            assert_eq!(pick_hex(&world, &ray, &pick_params()), Ok(None));
        }
    }
}
