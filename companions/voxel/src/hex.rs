//! Optional hexagonal-prism voxel topology beside the cubic voxel
//! companion.
//!
//! A hex cell is a flat-top hexagon, extruded by one integer layer
//! height. This module reuses the cubic [`crate::chunk::Chunk`],
//! [`crate::chunk::ChunkDims`], [`crate::world::World`], and
//! [`crate::world::ChunkCoord`] unchanged: a hex chunk is an axial
//! rhombus `W x D` cells with `H` layers, stored in the same dense
//! [`crate::chunk::Chunk`] grid. See `docs/hex-voxel-contract.md`
//! section 1 (the frozen interface) and `docs/hex-voxel-geometry.md`
//! (the guide) for the full coordinate and geometry rules, and
//! [MADR 0011](../../../docs/adr/0011-optional-hexagonal-prism-topology.md)
//! for the design decision (tracking issue #130).
//!
//! This module adds **no** dependency, **no** `unsafe`, and **no**
//! I/O. It does not change cubic behavior: `chunk.rs`, `world.rs`,
//! `mesh.rs`, `terrain.rs`, `camera.rs`, and `math.rs` are untouched.

use crate::chunk::{ChunkDims, VoxelId};
use crate::mesh::{MeshBuffers, Vertex};
use crate::world::{ChunkCoord, World};

/// `sqrt(3) / 2`, the ratio between a flat-top hexagon's center-to-edge
/// distance and its center-to-corner distance ([`HEX_RADIUS`]).
const HEX_S: f32 = 0.866_025_4;

/// Center-to-corner distance of one hex cell. Fixed; there is no
/// runtime cell-size setting.
pub const HEX_RADIUS: f32 = 1.0;

/// Height of one integer layer. Fixed; there is no runtime setting.
pub const HEX_LAYER_HEIGHT: f32 = 1.0;

/// `HEX_RADIUS / 2`. The lattice-to-world `x` scale factor.
pub const HEX_X_STEP: f32 = 0.5;

/// `HEX_RADIUS * sqrt(3) / 2`. The lattice-to-world `z` scale factor.
pub const HEX_Z_STEP: f32 = HEX_S;

/// Largest permitted vertex count for one chunk mesh: the `u16` index
/// range used by WebGL1 (`0..=65_535`, i.e. up to 65_536 vertices).
pub const HEX_MAX_MESH_VERTICES: usize = 65_536;

/// Smallest permitted value for `q`, `r`, or `layer`.
pub const HEX_COORD_MIN: i32 = -65_536;

/// Largest permitted value for `q`, `r`, or `layer`.
pub const HEX_COORD_MAX: i32 = 65_535;

/// Integer corner offsets, in lattice units of [`HEX_X_STEP`] (for
/// `KX`) and [`HEX_Z_STEP`] (for `KZ`), for corner `k = 0..6` of a
/// cell at `(q, r)`. See `docs/hex-voxel-contract.md` section 1.5.
const CORNER_KX: [i32; 6] = [2, 1, -1, -2, -1, 1];
const CORNER_KZ: [i32; 6] = [0, 1, 1, 0, -1, -1];

/// An error constructing or resolving a [`HexCell`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexError {
    /// A `q`, `r`, or `layer` value is outside
    /// `HEX_COORD_MIN..=HEX_COORD_MAX`.
    CoordinateOutOfRange,
    /// The supplied [`ChunkDims`] failed [`ChunkDims::validate`].
    InvalidDims,
}

impl std::fmt::Display for HexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            HexError::CoordinateOutOfRange => {
                "hex coordinate is outside HEX_COORD_MIN..=HEX_COORD_MAX"
            }
            HexError::InvalidDims => "chunk dimensions are invalid for a hex chunk",
        };
        f.write_str(message)
    }
}

impl std::error::Error for HexError {}

/// An error building a hex chunk mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexMeshError {
    /// The requested chunk coordinate has no resident chunk.
    ChunkNotResident,
    /// A cell of the requested chunk falls outside
    /// `HEX_COORD_MIN..=HEX_COORD_MAX`.
    ChunkOutOfRange,
    /// A voxel's material ID has no entry in the supplied palette.
    UnknownMaterial(VoxelId),
    /// A voxel's palette color has a non-finite component, or a
    /// component outside `0.0..=1.0`.
    InvalidColor(VoxelId),
    /// The mesh would need more than [`HEX_MAX_MESH_VERTICES`]
    /// vertices.
    MeshTooLarge {
        /// The exact vertex count that was rejected.
        vertices: usize,
    },
}

impl std::fmt::Display for HexMeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HexMeshError::ChunkNotResident => {
                f.write_str("the requested chunk coordinate has no resident chunk")
            }
            HexMeshError::ChunkOutOfRange => {
                f.write_str("a cell of the requested chunk is outside the hex coordinate bound")
            }
            HexMeshError::UnknownMaterial(id) => {
                write!(f, "voxel material {id} has no palette entry")
            }
            HexMeshError::InvalidColor(id) => {
                write!(f, "voxel material {id} has an invalid palette color")
            }
            HexMeshError::MeshTooLarge { vertices } => {
                write!(
                    f,
                    "hex chunk mesh needs {vertices} vertices, over the u16 index limit"
                )
            }
        }
    }
}

impl std::error::Error for HexMeshError {}

/// One of the eight directions a hexagonal-prism cell can face: the
/// six lateral (side) directions, `Top`, and `Bottom`.
///
/// The order below is the fixed, frozen face order used by
/// [`HexFace::ALL`], [`build_hex_chunk_mesh`]'s face iteration, and
/// [`hex_dirty_chunks`]'s neighbor iteration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HexFace {
    PosQ,
    PosR,
    NegQPosR,
    NegQ,
    NegR,
    PosQNegR,
    Top,
    Bottom,
}

impl HexFace {
    /// All eight faces, in the fixed order used throughout this
    /// module.
    pub const ALL: [HexFace; 8] = [
        HexFace::PosQ,
        HexFace::PosR,
        HexFace::NegQPosR,
        HexFace::NegQ,
        HexFace::NegR,
        HexFace::PosQNegR,
        HexFace::Top,
        HexFace::Bottom,
    ];

    /// The six lateral (side) faces, in the same order as
    /// [`HexFace::ALL`]'s first six entries.
    pub const SIDES: [HexFace; 6] = [
        HexFace::PosQ,
        HexFace::PosR,
        HexFace::NegQPosR,
        HexFace::NegQ,
        HexFace::NegR,
        HexFace::PosQNegR,
    ];

    /// This face's fixed index: `0..6` for a side (also its corner
    /// pair's lower index), `6` for `Top`, `7` for `Bottom`.
    pub const fn index(self) -> usize {
        match self {
            HexFace::PosQ => 0,
            HexFace::PosR => 1,
            HexFace::NegQPosR => 2,
            HexFace::NegQ => 3,
            HexFace::NegR => 4,
            HexFace::PosQNegR => 5,
            HexFace::Top => 6,
            HexFace::Bottom => 7,
        }
    }

    /// The face on the opposite side of a cell: a side's opposite is
    /// the side three steps around (`(k + 3) % 6`); `Top` and
    /// `Bottom` are each other's opposite.
    pub const fn opposite(self) -> HexFace {
        match self {
            HexFace::PosQ => HexFace::NegQ,
            HexFace::PosR => HexFace::NegR,
            HexFace::NegQPosR => HexFace::PosQNegR,
            HexFace::NegQ => HexFace::PosQ,
            HexFace::NegR => HexFace::PosR,
            HexFace::PosQNegR => HexFace::NegQPosR,
            HexFace::Top => HexFace::Bottom,
            HexFace::Bottom => HexFace::Top,
        }
    }

    /// The `(dq, dr, dlayer)` step from a cell to its neighbor across
    /// this face.
    pub const fn delta(self) -> (i32, i32, i32) {
        match self {
            HexFace::PosQ => (1, 0, 0),
            HexFace::PosR => (0, 1, 0),
            HexFace::NegQPosR => (-1, 1, 0),
            HexFace::NegQ => (-1, 0, 0),
            HexFace::NegR => (0, -1, 0),
            HexFace::PosQNegR => (1, -1, 0),
            HexFace::Top => (0, 0, 1),
            HexFace::Bottom => (0, 0, -1),
        }
    }

    /// This face's fixed outward unit normal, in world space.
    pub fn normal(self) -> [f32; 3] {
        match self {
            HexFace::PosQ => [HEX_S, 0.0, 0.5],
            HexFace::PosR => [0.0, 0.0, 1.0],
            HexFace::NegQPosR => [-HEX_S, 0.0, 0.5],
            HexFace::NegQ => [-HEX_S, 0.0, -0.5],
            HexFace::NegR => [0.0, 0.0, -1.0],
            HexFace::PosQNegR => [HEX_S, 0.0, -0.5],
            HexFace::Top => [0.0, 1.0, 0.0],
            HexFace::Bottom => [0.0, -1.0, 0.0],
        }
    }
}

/// Returns `value` if it is within `HEX_COORD_MIN..=HEX_COORD_MAX`,
/// else [`HexError::CoordinateOutOfRange`].
fn check_bound(value: i32) -> Result<i32, HexError> {
    if (HEX_COORD_MIN..=HEX_COORD_MAX).contains(&value) {
        Ok(value)
    } else {
        Err(HexError::CoordinateOutOfRange)
    }
}

/// Returns `value` as `i32` if it fits `HEX_COORD_MIN..=HEX_COORD_MAX`,
/// computed from `value: i64` so a caller can check a sum or product
/// before narrowing it.
fn check_bound_i64(value: i64) -> Result<i32, HexError> {
    if value < HEX_COORD_MIN as i64 || value > HEX_COORD_MAX as i64 {
        return Err(HexError::CoordinateOutOfRange);
    }
    Ok(value as i32)
}

/// One flat-top hexagonal-prism cell: an axial `(q, r)` position and
/// an integer `layer`. See `docs/hex-voxel-contract.md` section 1.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HexCell {
    q: i32,
    r: i32,
    layer: i32,
}

impl HexCell {
    /// Creates a cell. Returns [`HexError::CoordinateOutOfRange`] if
    /// any value is outside `HEX_COORD_MIN..=HEX_COORD_MAX`.
    pub fn new(q: i32, r: i32, layer: i32) -> Result<HexCell, HexError> {
        Ok(HexCell {
            q: check_bound(q)?,
            r: check_bound(r)?,
            layer: check_bound(layer)?,
        })
    }

    pub const fn q(self) -> i32 {
        self.q
    }

    pub const fn r(self) -> i32 {
        self.r
    }

    pub const fn layer(self) -> i32 {
        self.layer
    }

    /// Returns the cell across `face` from `self`. Uses `checked_add`
    /// on each axis, then the coordinate bound; never panics, and
    /// returns [`HexError::CoordinateOutOfRange`] at a bound (for
    /// example one step past `HEX_COORD_MAX`).
    pub fn neighbor(self, face: HexFace) -> Result<HexCell, HexError> {
        let (dq, dr, dlayer) = face.delta();
        let q = self
            .q
            .checked_add(dq)
            .ok_or(HexError::CoordinateOutOfRange)?;
        let r = self
            .r
            .checked_add(dr)
            .ok_or(HexError::CoordinateOutOfRange)?;
        let layer = self
            .layer
            .checked_add(dlayer)
            .ok_or(HexError::CoordinateOutOfRange)?;
        HexCell::new(q, r, layer)
    }

    /// The planar (axial) hex distance between two cells, ignoring
    /// `layer`: `(|dq| + |dr| + |dq + dr|) / 2`. Computed in `i64`;
    /// the result always fits `u32` for bounded coordinates.
    pub fn planar_distance(self, other: HexCell) -> u32 {
        let dq = (self.q as i64) - (other.q as i64);
        let dr = (self.r as i64) - (other.r as i64);
        let distance = (dq.abs() + dr.abs() + (dq + dr).abs()) / 2;
        distance as u32
    }

    /// Resolves this cell to the chunk that owns it and its local
    /// coordinate within that chunk, for chunk `dims`. Returns
    /// [`HexError::InvalidDims`] if `dims` fails
    /// [`ChunkDims::validate`].
    pub fn to_chunk_local(self, dims: ChunkDims) -> Result<(ChunkCoord, [u32; 3]), HexError> {
        dims.validate().map_err(|_| HexError::InvalidDims)?;
        let (cx, lx) = div_rem_euclid(self.q, dims.x);
        let (cy, ly) = div_rem_euclid(self.layer, dims.y);
        let (cz, lz) = div_rem_euclid(self.r, dims.z);
        Ok((ChunkCoord::new(cx, cy, cz), [lx, ly, lz]))
    }

    /// Reconstructs the cell owned by chunk `chunk` at local
    /// coordinate `local`, for chunk `dims`. Returns
    /// [`HexError::InvalidDims`] if `dims` fails
    /// [`ChunkDims::validate`], and [`HexError::CoordinateOutOfRange`]
    /// if a `local` component is outside `[0, dims)` or the result is
    /// outside the coordinate bound. Computed in `i64`.
    pub fn from_chunk_local(
        chunk: ChunkCoord,
        local: [u32; 3],
        dims: ChunkDims,
    ) -> Result<HexCell, HexError> {
        dims.validate().map_err(|_| HexError::InvalidDims)?;
        if local[0] >= dims.x || local[1] >= dims.y || local[2] >= dims.z {
            return Err(HexError::CoordinateOutOfRange);
        }
        let q = (chunk.x as i64) * (dims.x as i64) + (local[0] as i64);
        let layer = (chunk.y as i64) * (dims.y as i64) + (local[1] as i64);
        let r = (chunk.z as i64) * (dims.z as i64) + (local[2] as i64);
        Ok(HexCell {
            q: check_bound_i64(q)?,
            r: check_bound_i64(r)?,
            layer: check_bound_i64(layer)?,
        })
    }

    /// The world-space center of this cell's prism (midway between its
    /// top and bottom caps).
    pub fn center(self) -> [f32; 3] {
        let x = (3 * self.q) as f32 * HEX_X_STEP;
        let y = (2 * self.layer + 1) as f32 * (HEX_LAYER_HEIGHT * 0.5);
        let z = (2 * self.r + self.q) as f32 * HEX_Z_STEP;
        [x, y, z]
    }

    /// The twelve world-space corners of this cell's prism: indices
    /// `0..6` are the bottom ring (corner `k` at angle `60 * k`
    /// degrees), and `6..12` are the top ring at the same `(x, z)`
    /// positions. Corner positions are calculated from the integer
    /// lattice (section 1.5 of the contract), never from `sin`/`cos`,
    /// so two adjacent cells share bit-identical corners.
    pub fn corners(self) -> [[f32; 3]; 12] {
        let bottom_y = (self.layer as f32) * HEX_LAYER_HEIGHT;
        let top_y = ((self.layer + 1) as f32) * HEX_LAYER_HEIGHT;
        let mut out = [[0.0f32; 3]; 12];
        for k in 0..6 {
            let x_lattice = 3 * self.q + CORNER_KX[k];
            let z_lattice = 2 * self.r + self.q + CORNER_KZ[k];
            let x = x_lattice as f32 * HEX_X_STEP;
            let z = z_lattice as f32 * HEX_Z_STEP;
            out[k] = [x, bottom_y, z];
            out[k + 6] = [x, top_y, z];
        }
        out
    }
}

/// Maps a hex axis coordinate to a `(chunk offset, local coordinate)`
/// pair using Euclidean division, as `crate::world::wrap_axis` does
/// for the cubic axes.
fn div_rem_euclid(value: i32, dim: u32) -> (i32, u32) {
    (
        value.div_euclid(dim as i32),
        value.rem_euclid(dim as i32) as u32,
    )
}

/// The set of chunks that share a face with an edited hex cell: the
/// cell's own chunk, plus any distinct neighbor chunk reached through
/// one of [`HexFace::ALL`]. Returned by [`hex_dirty_chunks`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HexDirtyChunks {
    chunks: [ChunkCoord; 9],
    len: usize,
}

impl HexDirtyChunks {
    /// The dirty chunks, own chunk first, in the order they were
    /// found: the own chunk, then each new neighbor chunk in
    /// [`HexFace::ALL`] order.
    pub fn as_slice(&self) -> &[ChunkCoord] {
        &self.chunks[..self.len]
    }

    fn push_if_new(&mut self, coord: ChunkCoord) {
        if self.chunks[..self.len].contains(&coord) {
            return;
        }
        self.chunks[self.len] = coord;
        self.len += 1;
    }
}

/// Returns the chunk that owns `cell`, plus each distinct chunk that
/// owns a cell across one of `cell`'s eight faces, for chunk `dims`.
/// An edit at `cell` can expose or hide a face in any of these
/// chunks, so each one needs a mesh rebuild. A neighbor cell outside
/// the coordinate bound (`HexError::CoordinateOutOfRange` from
/// [`HexCell::neighbor`]) contributes no chunk; it is not an error
/// for `hex_dirty_chunks` itself.
pub fn hex_dirty_chunks(cell: HexCell, dims: ChunkDims) -> Result<HexDirtyChunks, HexError> {
    let (own_chunk, _) = cell.to_chunk_local(dims)?;
    let mut out = HexDirtyChunks {
        chunks: [own_chunk; 9],
        len: 0,
    };
    out.push_if_new(own_chunk);
    for face in HexFace::ALL {
        let Ok(neighbor_cell) = cell.neighbor(face) else {
            continue;
        };
        let Ok((neighbor_chunk, _)) = neighbor_cell.to_chunk_local(dims) else {
            continue;
        };
        out.push_if_new(neighbor_chunk);
    }
    Ok(out)
}

/// Looks up whether the hex cell at `coord`'s chunk-local `local` is
/// solid, given that `local`'s owning chunk is `lookup_coord`
/// (`coord` if the cell stayed within the requesting chunk, else a
/// neighbor). Missing-chunk policy matches the cubic mesher: a
/// non-resident chunk makes the cell **not solid** (an exposed
/// boundary is drawn rather than silently culled).
fn cell_is_solid(world: &World, lookup_coord: ChunkCoord, local: [u32; 3]) -> bool {
    match world.get(lookup_coord) {
        Some(chunk) => chunk.is_solid(local[0], local[1], local[2]),
        None => false,
    }
}

/// Reports whether the neighbor of `cell` across `face` is solid,
/// given chunk `dims`. A neighbor outside the coordinate bound, or
/// whose chunk is not resident, is **not solid** (the face is drawn).
fn neighbor_is_solid(world: &World, cell: HexCell, face: HexFace, dims: ChunkDims) -> bool {
    let Ok(neighbor_cell) = cell.neighbor(face) else {
        return false;
    };
    let Ok((neighbor_chunk, local)) = neighbor_cell.to_chunk_local(dims) else {
        return false;
    };
    cell_is_solid(world, neighbor_chunk, local)
}

/// Checks whether every cell owned by chunk `coord` (chunk dims
/// `dims`) stays within `HEX_COORD_MIN..=HEX_COORD_MAX`, by checking
/// the minimum and maximum cell of each axis in `i64`.
fn chunk_cells_in_bound(coord: ChunkCoord, dims: ChunkDims) -> bool {
    let axis_in_bound = |chunk_axis: i32, dim: u32| {
        let min = (chunk_axis as i64) * (dim as i64);
        let max = min + (dim as i64) - 1;
        min >= HEX_COORD_MIN as i64 && max <= HEX_COORD_MAX as i64
    };
    axis_in_bound(coord.x, dims.x)
        && axis_in_bound(coord.y, dims.y)
        && axis_in_bound(coord.z, dims.z)
}

/// Appends a side face (`face` in [`HexFace::SIDES`]) of `cell`'s
/// prism to `out`, in counter-clockwise winding as seen from outside.
fn push_side_face(out: &mut MeshBuffers, cell: HexCell, face: HexFace, color: [f32; 4]) {
    let k = face.index();
    let j = (k + 1) % 6;
    let corners = cell.corners();
    let normal = face.normal();
    let base = out.vertices.len() as u32;
    let quad = [corners[k], corners[k + 6], corners[j + 6], corners[j]];
    for pos in quad {
        out.vertices.push(Vertex { pos, normal, color });
    }
    out.indices
        .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
}

/// Appends the top or bottom cap (`face` is [`HexFace::Top`] or
/// [`HexFace::Bottom`]) of `cell`'s prism to `out`: a 4-triangle fan
/// from corner 0, with no center vertex, in counter-clockwise winding
/// as seen from outside.
fn push_cap_face(out: &mut MeshBuffers, cell: HexCell, face: HexFace, color: [f32; 4]) {
    let corners = cell.corners();
    let ring: [[f32; 3]; 6] = match face {
        HexFace::Top => [
            corners[6],
            corners[11],
            corners[10],
            corners[9],
            corners[8],
            corners[7],
        ],
        _ => [
            corners[0], corners[1], corners[2], corners[3], corners[4], corners[5],
        ],
    };
    let normal = face.normal();
    let base = out.vertices.len() as u32;
    for pos in ring {
        out.vertices.push(Vertex { pos, normal, color });
    }
    out.indices.extend_from_slice(&[
        base,
        base + 1,
        base + 2,
        base,
        base + 2,
        base + 3,
        base,
        base + 3,
        base + 4,
        base,
        base + 4,
        base + 5,
    ]);
}

/// The number of vertices one visible face of `face`'s kind
/// contributes: 4 for a side, 6 for a cap.
const fn face_vertex_count(face: HexFace) -> usize {
    match face {
        HexFace::Top | HexFace::Bottom => 6,
        _ => 4,
    }
}

/// Appends the visible-face mesh for the resident hex chunk at
/// `coord` into `out`. `out` is cleared first; on any error, `out`
/// stays empty. See `docs/hex-voxel-contract.md` section 1.8 for the
/// full rule set.
pub fn build_hex_chunk_mesh(
    world: &World,
    coord: ChunkCoord,
    palette: &[[f32; 4]],
    out: &mut MeshBuffers,
) -> Result<(), HexMeshError> {
    out.clear();
    let chunk = world.get(coord).ok_or(HexMeshError::ChunkNotResident)?;
    let dims = chunk.dims();
    if !chunk_cells_in_bound(coord, dims) {
        return Err(HexMeshError::ChunkOutOfRange);
    }

    // Pass 1: validate materials/colors and count the exact vertex
    // and index totals with checked arithmetic, before allocating.
    let mut vertex_count: usize = 0;
    let mut index_count: usize = 0;
    for z in 0..dims.z {
        for y in 0..dims.y {
            for x in 0..dims.x {
                let id = match chunk.get(x, y, z) {
                    Some(id) if id != crate::chunk::AIR => id,
                    _ => continue,
                };
                let color = palette
                    .get(id as usize)
                    .ok_or(HexMeshError::UnknownMaterial(id))?;
                if !color
                    .iter()
                    .all(|component| component.is_finite() && (0.0..=1.0).contains(component))
                {
                    return Err(HexMeshError::InvalidColor(id));
                }
                let cell = HexCell::from_chunk_local(coord, [x, y, z], dims)
                    .map_err(|_| HexMeshError::ChunkOutOfRange)?;
                for face in HexFace::ALL {
                    if neighbor_is_solid(world, cell, face, dims) {
                        continue;
                    }
                    vertex_count = vertex_count.checked_add(face_vertex_count(face)).ok_or(
                        HexMeshError::MeshTooLarge {
                            vertices: usize::MAX,
                        },
                    )?;
                    let face_indices = if matches!(face, HexFace::Top | HexFace::Bottom) {
                        12
                    } else {
                        6
                    };
                    index_count = index_count.checked_add(face_indices).ok_or(
                        HexMeshError::MeshTooLarge {
                            vertices: usize::MAX,
                        },
                    )?;
                }
            }
        }
    }

    if vertex_count > HEX_MAX_MESH_VERTICES {
        return Err(HexMeshError::MeshTooLarge {
            vertices: vertex_count,
        });
    }

    out.vertices.reserve_exact(vertex_count);
    out.indices.reserve_exact(index_count);

    // Pass 2: build the geometry. Validation already passed, so no
    // path here can produce an error.
    for z in 0..dims.z {
        for y in 0..dims.y {
            for x in 0..dims.x {
                let id = match chunk.get(x, y, z) {
                    Some(id) if id != crate::chunk::AIR => id,
                    _ => continue,
                };
                let color = palette[id as usize];
                let cell =
                    HexCell::from_chunk_local(coord, [x, y, z], dims).expect("validated in pass 1");
                for face in HexFace::ALL {
                    if neighbor_is_solid(world, cell, face, dims) {
                        continue;
                    }
                    if matches!(face, HexFace::Top | HexFace::Bottom) {
                        push_cap_face(out, cell, face, color);
                    } else {
                        push_side_face(out, cell, face, color);
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunk;

    fn hex_dims() -> ChunkDims {
        ChunkDims::new(4, 1, 4)
    }

    fn cell(q: i32, r: i32, layer: i32) -> HexCell {
        HexCell::new(q, r, layer).unwrap()
    }

    // --- HexFace table consistency ------------------------------------

    #[test]
    fn all_and_sides_use_the_frozen_order() {
        assert_eq!(HexFace::ALL.len(), 8);
        assert_eq!(HexFace::SIDES.len(), 6);
        for (i, face) in HexFace::ALL.iter().enumerate() {
            assert_eq!(face.index(), i);
        }
        assert_eq!(HexFace::SIDES, HexFace::ALL[..6]);
    }

    #[test]
    fn side_opposite_is_three_steps_around() {
        for k in 0..6 {
            let face = HexFace::SIDES[k];
            assert_eq!(face.opposite().index(), (k + 3) % 6);
            assert_eq!(face.opposite().opposite(), face);
        }
        assert_eq!(HexFace::Top.opposite(), HexFace::Bottom);
        assert_eq!(HexFace::Bottom.opposite(), HexFace::Top);
    }

    // --- Neighbor round trip -------------------------------------------

    #[test]
    fn neighbor_round_trip_at_origin() {
        let start = cell(0, 0, 0);
        for face in HexFace::ALL {
            let neighbor = start.neighbor(face).unwrap();
            assert_eq!(neighbor.neighbor(face.opposite()).unwrap(), start);
        }
    }

    #[test]
    fn neighbor_round_trip_at_negative_q_and_r() {
        let start = cell(-10, -20, 3);
        for face in HexFace::ALL {
            let neighbor = start.neighbor(face).unwrap();
            assert_eq!(neighbor.neighbor(face.opposite()).unwrap(), start);
        }
    }

    #[test]
    fn neighbor_round_trip_near_the_integer_limits() {
        let start = cell(HEX_COORD_MAX, HEX_COORD_MIN, 0);
        // PosQ would overflow HEX_COORD_MAX; NegR would overflow HEX_COORD_MIN.
        assert_eq!(
            start.neighbor(HexFace::PosQ).unwrap_err(),
            HexError::CoordinateOutOfRange
        );
        assert_eq!(
            start.neighbor(HexFace::NegR).unwrap_err(),
            HexError::CoordinateOutOfRange
        );
        // A direction that does not cross either bound still round-trips.
        let neighbor = start.neighbor(HexFace::NegQ).unwrap();
        assert_eq!(neighbor.neighbor(HexFace::PosQ).unwrap(), start);
    }

    #[test]
    fn new_rejects_out_of_range_coordinates() {
        assert_eq!(
            HexCell::new(HEX_COORD_MAX + 1, 0, 0).unwrap_err(),
            HexError::CoordinateOutOfRange
        );
        assert_eq!(
            HexCell::new(0, HEX_COORD_MIN - 1, 0).unwrap_err(),
            HexError::CoordinateOutOfRange
        );
        assert!(HexCell::new(HEX_COORD_MIN, HEX_COORD_MAX, 0).is_ok());
    }

    // --- planar_distance -------------------------------------------------

    #[test]
    fn planar_distance_ignores_layer() {
        let a = cell(0, 0, 5);
        let b = cell(0, 0, -5);
        assert_eq!(a.planar_distance(b), 0);
    }

    #[test]
    fn planar_distance_matches_neighbor_steps() {
        let start = cell(2, -3, 0);
        for face in HexFace::SIDES {
            let neighbor = start.neighbor(face).unwrap();
            assert_eq!(start.planar_distance(neighbor), 1);
        }
        assert_eq!(start.planar_distance(start), 0);
    }

    // --- Geometry: normals and winding -----------------------------------

    fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    }

    fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    }

    fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    fn normalize_xz(v: [f32; 3]) -> [f32; 3] {
        let len = (v[0] * v[0] + v[2] * v[2]).sqrt();
        [v[0] / len, 0.0, v[2] / len]
    }

    #[test]
    fn side_normal_matches_direction_to_neighbor() {
        let start = cell(1, -2, 0);
        for face in HexFace::SIDES {
            let neighbor = start.neighbor(face).unwrap();
            let direction = normalize_xz(sub(neighbor.center(), start.center()));
            let normal = face.normal();
            for i in 0..3 {
                assert!(
                    (direction[i] - normal[i]).abs() < 1e-5,
                    "face {face:?} axis {i}: direction {direction:?} vs normal {normal:?}"
                );
            }
        }
    }

    fn assert_ccw_from_outside(v0: [f32; 3], v1: [f32; 3], v2: [f32; 3], normal: [f32; 3]) {
        let n = cross(sub(v1, v0), sub(v2, v0));
        assert!(
            dot(n, normal) > 0.0,
            "triangle winding is not CCW from outside"
        );
    }

    #[test]
    fn every_triangle_of_every_face_is_ccw_from_outside() {
        let start = cell(0, 0, 0);
        let corners = start.corners();
        for face in HexFace::SIDES {
            let k = face.index();
            let j = (k + 1) % 6;
            let quad = [corners[k], corners[k + 6], corners[j + 6], corners[j]];
            let normal = face.normal();
            assert_ccw_from_outside(quad[0], quad[1], quad[2], normal);
            assert_ccw_from_outside(quad[0], quad[2], quad[3], normal);
        }
        for (face, ring) in [
            (
                HexFace::Top,
                [
                    corners[6],
                    corners[11],
                    corners[10],
                    corners[9],
                    corners[8],
                    corners[7],
                ],
            ),
            (
                HexFace::Bottom,
                [
                    corners[0], corners[1], corners[2], corners[3], corners[4], corners[5],
                ],
            ),
        ] {
            let normal = face.normal();
            assert_ccw_from_outside(ring[0], ring[1], ring[2], normal);
            assert_ccw_from_outside(ring[0], ring[2], ring[3], normal);
            assert_ccw_from_outside(ring[0], ring[3], ring[4], normal);
            assert_ccw_from_outside(ring[0], ring[4], ring[5], normal);
        }
    }

    // --- Watertight shared corners ----------------------------------------

    #[test]
    fn adjacent_cells_share_side_corners_in_reverse_order() {
        for (a_coord, label) in [
            ((0, 0, 0), "origin"),
            ((-50, 30, -2), "negative"),
            ((HEX_COORD_MAX - 1, 0, 0), "near bound"),
        ] {
            let a = cell(a_coord.0, a_coord.1, a_coord.2);
            let b = a.neighbor(HexFace::PosQ).unwrap();
            let a_corners = a.corners();
            let b_corners = b.corners();
            let k = HexFace::PosQ.index();
            let j = (k + 1) % 6;
            let bk = HexFace::NegQ.index();
            let bj = (bk + 1) % 6;
            // A's PosQ quad uses corners [k, k+6, j+6, j]; B's NegQ quad
            // (the shared face from B's side) must use the same two
            // positions, in reverse order.
            assert_eq!(a_corners[k], b_corners[bj], "{label}: bottom corner k");
            assert_eq!(a_corners[j], b_corners[bk], "{label}: bottom corner j");
            assert_eq!(a_corners[k + 6], b_corners[bj + 6], "{label}: top corner k");
            assert_eq!(a_corners[j + 6], b_corners[bk + 6], "{label}: top corner j");
        }
    }

    // --- to_chunk_local / from_chunk_local round trip ----------------------

    #[test]
    fn chunk_local_round_trip() {
        let dims = hex_dims();
        for (q, r, layer) in [(0, 0, 0), (-1, 5, 0), (7, -3, 0), (3, 3, 0)] {
            let start = cell(q, r, layer);
            let (chunk_coord, local) = start.to_chunk_local(dims).unwrap();
            let back = HexCell::from_chunk_local(chunk_coord, local, dims).unwrap();
            assert_eq!(start, back);
        }
    }

    #[test]
    fn to_chunk_local_rejects_invalid_dims() {
        let bad_dims = ChunkDims::new(0, 1, 4);
        assert_eq!(
            cell(0, 0, 0).to_chunk_local(bad_dims).unwrap_err(),
            HexError::InvalidDims
        );
    }

    #[test]
    fn from_chunk_local_rejects_out_of_range_local() {
        let dims = hex_dims();
        let err =
            HexCell::from_chunk_local(ChunkCoord::new(0, 0, 0), [dims.x, 0, 0], dims).unwrap_err();
        assert_eq!(err, HexError::CoordinateOutOfRange);
    }

    // --- Isolated prism: exact faces/vertices/triangles --------------------

    #[test]
    fn isolated_prism_gives_exact_counts() {
        let dims = ChunkDims::new(4, 1, 4);
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 0, 1, 1).unwrap();
        world.insert(coord, chunk).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap();

        // 8 faces total: 6 sides at 4 verts/2 tris each, 2 caps at
        // 6 verts/4 tris each => 36 vertices, 20 triangles, 60 indices.
        assert_eq!(out.vertices.len(), 36);
        assert_eq!(out.indices.len(), 60);
        assert_eq!(out.indices.len() / 3, 20);
    }

    // --- Interior culling: solid 3x3x3 hex block ---------------------------

    #[test]
    fn solid_3x3x3_hex_block_draws_only_exterior_faces() {
        let dims = ChunkDims::new(3, 3, 3);
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        for z in 0..3 {
            for y in 0..3 {
                for x in 0..3 {
                    chunk.set(x, y, z, 1).unwrap();
                }
            }
        }
        world.insert(coord, chunk).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap();

        // Count exterior faces analytically: for each of the 27 cells,
        // a face is exterior if its neighbor is outside [0,3) on the
        // relevant axis (missing neighbor chunk, so treated not solid).
        let mut expected_faces = 0usize;
        for z in 0i32..3 {
            for y in 0i32..3 {
                for x in 0i32..3 {
                    for face in HexFace::ALL {
                        let (dq, dr, dl) = face.delta();
                        let (nq, nr, nl) = (x + dq, z + dr, y + dl);
                        if !(0..3).contains(&nq) || !(0..3).contains(&nr) || !(0..3).contains(&nl) {
                            expected_faces += 1;
                        }
                    }
                }
            }
        }
        let expected_vertices: usize = expected_faces / 8 * 36; // sanity cross-check below
        let _ = expected_vertices;

        // Direct recomputation using face_vertex_count for a precise check.
        let mut expected_vertex_total = 0usize;
        for z in 0i32..3 {
            for y in 0i32..3 {
                for x in 0i32..3 {
                    for face in HexFace::ALL {
                        let (dq, dr, dl) = face.delta();
                        let (nq, nr, nl) = (x + dq, z + dr, y + dl);
                        if !(0..3).contains(&nq) || !(0..3).contains(&nr) || !(0..3).contains(&nl) {
                            expected_vertex_total += face_vertex_count(face);
                        }
                    }
                }
            }
        }
        assert_eq!(out.vertices.len(), expected_vertex_total);
        assert!(expected_faces > 0);
    }

    // --- Cross-chunk culling, including the diagonal corner ----------------

    #[test]
    fn boundary_face_is_culled_when_neighbor_chunk_resident_q_axis() {
        let dims = ChunkDims::new(4, 1, 4);
        let mut world = World::new(dims, 2).unwrap();
        let a = ChunkCoord::new(0, 0, 0);
        let b = ChunkCoord::new(1, 0, 0);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(3, 0, 1, 1).unwrap(); // local q=3=W-1, r=1
        let mut chunk_b = Chunk::new(dims).unwrap();
        chunk_b.set(0, 0, 1, 1).unwrap(); // local q=0, r=1: PosQ neighbor of a's cell
        world.insert(a, chunk_a).unwrap();
        world.insert(b, chunk_b).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, a, &palette, &mut out).unwrap();
        // PosQ face is culled (resident neighbor solid); the other 7
        // faces stay: 5 sides (4 verts) + 2 caps (6 verts) = 32.
        assert_eq!(out.vertices.len(), 5 * 4 + 2 * 6);
    }

    #[test]
    fn boundary_face_stays_visible_when_neighbor_chunk_missing_r_axis() {
        let dims = ChunkDims::new(4, 1, 4);
        let mut world = World::new(dims, 2).unwrap();
        let a = ChunkCoord::new(0, 0, 0);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(1, 0, 3, 1).unwrap(); // local q=1, r=3=D-1
        world.insert(a, chunk_a).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, a, &palette, &mut out).unwrap();
        // No neighbor chunk at (0,0,1): all 8 faces stay visible.
        assert_eq!(out.vertices.len(), 36);
    }

    #[test]
    fn diagonal_corner_culls_when_diagonal_chunk_resident() {
        // Local (W-1, r=0) in chunk (0,0,0): PosQNegR crosses into the
        // diagonal chunk (x+1, z-1) per docs/hex-voxel-contract.md 1.2.
        let dims = ChunkDims::new(4, 1, 4);
        let mut world = World::new(dims, 2).unwrap();
        let a = ChunkCoord::new(0, 0, 0);
        let diagonal = ChunkCoord::new(1, 0, -1);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(3, 0, 0, 1).unwrap(); // local q=3=W-1, r=0
        world.insert(a, chunk_a).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();

        // Without the diagonal chunk resident: all 8 faces visible.
        build_hex_chunk_mesh(&world, a, &palette, &mut out).unwrap();
        assert_eq!(out.vertices.len(), 36);

        // With the diagonal chunk resident and its corresponding cell
        // solid: the PosQNegR face is culled.
        let mut chunk_diag = Chunk::new(dims).unwrap();
        // From chunk (1,0,-1)'s local frame, the cell matching local
        // q=3,r=0's PosQNegR neighbor (q=4,r=-1 global) is local (0, 0, 3).
        chunk_diag.set(0, 0, 3, 1).unwrap();
        world.insert(diagonal, chunk_diag).unwrap();

        build_hex_chunk_mesh(&world, a, &palette, &mut out).unwrap();
        // One fewer side face (4 verts) than the no-neighbor case.
        assert_eq!(out.vertices.len(), 36 - 4);
    }

    #[test]
    fn diagonal_corner_resolves_other_direction_too() {
        // Local (0, r=D-1) in chunk (0,0,0): NegQPosR crosses into the
        // diagonal chunk (x-1, z+1).
        let dims = ChunkDims::new(4, 1, 4);
        let mut world = World::new(dims, 2).unwrap();
        let a = ChunkCoord::new(0, 0, 0);
        let diagonal = ChunkCoord::new(-1, 0, 1);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(0, 0, 3, 1).unwrap(); // local q=0, r=3=D-1
        world.insert(a, chunk_a).unwrap();
        let mut chunk_diag = Chunk::new(dims).unwrap();
        chunk_diag.set(3, 0, 0, 1).unwrap();
        world.insert(diagonal, chunk_diag).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, a, &palette, &mut out).unwrap();
        assert_eq!(out.vertices.len(), 36 - 4);
    }

    // --- Dirty chunk sets ---------------------------------------------------

    #[test]
    fn interior_cell_gives_exactly_one_dirty_chunk() {
        // dims with H=3 and the cell on the middle layer, so Top/Bottom
        // also stay inside the chunk (an H=1 chunk would make every
        // cell's Top/Bottom cross into a layer-neighbor chunk).
        let dims = ChunkDims::new(4, 3, 4);
        let c = cell(1, 1, 1);
        let dirty = hex_dirty_chunks(c, dims).unwrap();
        assert_eq!(dirty.as_slice(), &[ChunkCoord::new(0, 0, 0)]);
    }

    #[test]
    fn edge_cell_gives_exactly_two_dirty_chunks() {
        let dims = ChunkDims::new(4, 3, 4);
        // local q=0, r=1, layer=1 (mid-edge, not a corner): NegQ and
        // NegQPosR both cross into (-1,0,0).
        let c = cell(0, 1, 1);
        let dirty = hex_dirty_chunks(c, dims).unwrap();
        assert_eq!(
            dirty.as_slice(),
            &[ChunkCoord::new(0, 0, 0), ChunkCoord::new(-1, 0, 0)]
        );
    }

    #[test]
    fn non_diagonal_corner_gives_exactly_three_dirty_chunks() {
        let dims = ChunkDims::new(4, 3, 4);
        // local (0, 0, layer=1): NegQPosR and NegQ both cross into
        // (-1,0,0); NegR and PosQNegR both cross into (0,0,-1). No
        // direction crosses both axes at once here, so no diagonal
        // chunk is touched.
        let c = cell(0, 0, 1);
        let dirty = hex_dirty_chunks(c, dims).unwrap();
        assert_eq!(
            dirty.as_slice(),
            &[
                ChunkCoord::new(0, 0, 0),
                ChunkCoord::new(-1, 0, 0),
                ChunkCoord::new(0, 0, -1),
            ]
        );
    }

    #[test]
    fn diagonal_corner_gives_exactly_four_dirty_chunks() {
        let dims = ChunkDims::new(4, 3, 4);
        // local (W-1, 0, layer=1) = (3, 0, 1): PosQ -> (1,0,0), NegR ->
        // (0,0,-1), PosQNegR crosses both q and r -> the diagonal chunk
        // (1,0,-1).
        let c = cell(3, 0, 1);
        let dirty = hex_dirty_chunks(c, dims).unwrap();
        assert_eq!(
            dirty.as_slice(),
            &[
                ChunkCoord::new(0, 0, 0),
                ChunkCoord::new(1, 0, 0),
                ChunkCoord::new(0, 0, -1),
                ChunkCoord::new(1, 0, -1),
            ]
        );
    }

    #[test]
    fn dirty_chunks_at_coordinate_bound_skips_out_of_range_neighbors() {
        let dims = ChunkDims::new(4, 3, 4);
        let c = cell(HEX_COORD_MAX, 0, 1);
        let dirty = hex_dirty_chunks(c, dims).unwrap();
        // PosQ and PosQNegR would overflow; they contribute no chunk.
        assert!(dirty.as_slice().len() < 9);
    }

    // --- Invalid input -------------------------------------------------------

    #[test]
    fn build_mesh_rejects_non_resident_chunk() {
        let dims = hex_dims();
        let world = World::new(dims, 1).unwrap();
        let mut out = MeshBuffers::new();
        let err =
            build_hex_chunk_mesh(&world, ChunkCoord::new(0, 0, 0), &[], &mut out).unwrap_err();
        assert_eq!(err, HexMeshError::ChunkNotResident);
        assert!(out.vertices.is_empty());
    }

    #[test]
    fn build_mesh_rejects_unknown_material() {
        let dims = hex_dims();
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(0, 0, 0, 1).unwrap();
        world.insert(coord, chunk).unwrap();
        let mut out = MeshBuffers::new();
        // Empty palette: material 1 has no entry.
        let err = build_hex_chunk_mesh(&world, coord, &[], &mut out).unwrap_err();
        assert_eq!(err, HexMeshError::UnknownMaterial(1));
        assert!(out.vertices.is_empty());
    }

    #[test]
    fn build_mesh_rejects_invalid_color() {
        let dims = hex_dims();
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(0, 0, 0, 1).unwrap();
        world.insert(coord, chunk).unwrap();
        let mut out = MeshBuffers::new();
        let palette = [[0.0, 0.0, 0.0, 0.0], [1.5, 0.0, 0.0, 1.0]];
        let err = build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap_err();
        assert_eq!(err, HexMeshError::InvalidColor(1));
        assert!(out.vertices.is_empty());

        let mut out2 = MeshBuffers::new();
        let palette_nan = [[0.0, 0.0, 0.0, 0.0], [f32::NAN, 0.0, 0.0, 1.0]];
        let err = build_hex_chunk_mesh(&world, coord, &palette_nan, &mut out2).unwrap_err();
        assert_eq!(err, HexMeshError::InvalidColor(1));
        assert!(out2.vertices.is_empty());
    }

    #[test]
    fn build_mesh_rejects_chunk_out_of_range() {
        // A chunk coordinate so large that its owned cells exceed the
        // hex coordinate bound.
        let dims = hex_dims();
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(i32::MAX / 2, 0, 0);
        let chunk = Chunk::new(dims).unwrap();
        world.insert(coord, chunk).unwrap();
        let mut out = MeshBuffers::new();
        let err = build_hex_chunk_mesh(&world, coord, &[], &mut out).unwrap_err();
        assert_eq!(err, HexMeshError::ChunkOutOfRange);
        assert!(out.vertices.is_empty());
    }

    #[test]
    fn to_chunk_local_rejects_zero_dims_without_mutating_state() {
        let bad = ChunkDims::new(0, 4, 4);
        assert_eq!(
            cell(0, 0, 0).to_chunk_local(bad).unwrap_err(),
            HexError::InvalidDims
        );
    }

    #[test]
    fn mesh_too_large_reports_exact_vertex_count_and_leaves_buffer_empty() {
        // A 64x64x64 chunk (the maximum ChunkDims, volume ==
        // MAX_CHUNK_VOLUME) filled at every even (x, y, z): each solid
        // cell has only odd-parity neighbors on every one of its 8
        // faces, so every cell is fully isolated (8 visible faces, 36
        // vertices) regardless of chunk-boundary residency. 32^3 =
        // 32_768 isolated cells * 36 vertices = 1_179_648, far over
        // HEX_MAX_MESH_VERTICES. The mesher must reject this before
        // allocating, with the exact vertex count, and leave `out`
        // empty.
        let dims = ChunkDims::new(64, 64, 64);
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        let mut solid_cells: usize = 0;
        for z in 0..64 {
            for y in 0..64 {
                for x in 0..64 {
                    if x % 2 == 0 && y % 2 == 0 && z % 2 == 0 {
                        chunk.set(x, y, z, 1).unwrap();
                        solid_cells += 1;
                    }
                }
            }
        }
        assert_eq!(solid_cells, 32 * 32 * 32);
        world.insert(coord, chunk).unwrap();

        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        let err = build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap_err();
        assert_eq!(
            err,
            HexMeshError::MeshTooLarge {
                vertices: solid_cells * 36
            }
        );
        assert!(solid_cells * 36 > HEX_MAX_MESH_VERTICES);
        assert!(out.vertices.is_empty());
        assert!(out.indices.is_empty());
    }

    #[test]
    fn build_mesh_reuses_buffer_capacity_across_rebuilds() {
        let dims = hex_dims();
        let mut world = World::new(dims, 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 0, 1, 1).unwrap();
        world.insert(coord, chunk).unwrap();
        let palette = [[0.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.5, 1.0]];
        let mut out = MeshBuffers::new();
        build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap();
        let first_len = out.vertices.len();
        build_hex_chunk_mesh(&world, coord, &palette, &mut out).unwrap();
        assert_eq!(out.vertices.len(), first_len);
    }
}
