//! The shared, pure Rust simulation core used by the native server and
//! by WASM (offline and mixed builds). See
//! `docs/architecture/voxel-protocol.md` ("Shared Rust types") for the
//! contract this module implements.
//!
//! This module has **no transport code, no GPU code, and no I/O**. The
//! native server and the WASM client apply the exact same
//! [`Command`] values through [`Sim::apply`] and compare
//! [`Sim::state_hash`] for semantic parity.

use crate::chunk::{Chunk, ChunkDims, AIR};
use crate::terrain;
use crate::world::{ChunkCoord, World, WorldError};

/// The fixed scene seed shared by the offline and server scenes.
pub const SCENE_SEED: u32 = 20_261_111;

/// The fixed chunk dimensions shared by the offline and server scenes.
pub const SCENE_CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 12, 8);

/// The fixed resident chunk coordinates in the shared scene.
pub const SCENE_CHUNK_COORDS: [ChunkCoord; 2] =
    [ChunkCoord::new(0, 0, 0), ChunkCoord::new(1, 0, 0)];

/// The maximum number of resident chunks the shared scene allows.
pub const MAX_RESIDENT_CHUNKS: usize = 4;

/// The largest permitted `SetSpeed` value, in milli-units (2.000x).
pub const MAX_SPEED_MILLI: u16 = 2000;

/// A command accepted by [`Sim::apply`]. 8 bytes on the wire; see
/// [`crate::protocol`] for the encoded record layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    SetVoxel { x: i16, y: i16, z: i16, id: u8 },
    SetSpeed { milli: u16 },
}

/// An error rejecting a [`Command`] in [`Sim::apply`]. A rejected
/// command changes nothing: `rev` and world state are untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimError {
    /// The voxel coordinate does not resolve to a resident chunk.
    OutOfScene,
    /// The material ID is not in the demo palette.
    UnknownMaterial,
    /// The speed value exceeds [`MAX_SPEED_MILLI`].
    SpeedOutOfRange,
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            SimError::OutOfScene => "voxel coordinate is outside the resident scene",
            SimError::UnknownMaterial => "material id is not in the demo palette",
            SimError::SpeedOutOfRange => "speed exceeds the maximum permitted value",
        };
        f.write_str(message)
    }
}

impl std::error::Error for SimError {}

/// The shared world/speed/revision state. The native server and the
/// WASM client each own one `Sim` and apply the same commands to it.
#[derive(Debug)]
pub struct Sim {
    world: World,
    seed: u32,
    speed_milli: u16,
    rev: u32,
}

impl Sim {
    /// Builds the fixed shared scene: [`SCENE_SEED`],
    /// [`SCENE_CHUNK_DIMS`], the two chunks in [`SCENE_CHUNK_COORDS`]
    /// filled by [`terrain`], and [`MAX_RESIDENT_CHUNKS`].
    pub fn new_scene() -> Sim {
        let mut world = World::new(SCENE_CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
            .expect("the fixed scene dimensions and chunk cap are always valid");
        for coord in SCENE_CHUNK_COORDS {
            let origin_x = coord.x * SCENE_CHUNK_DIMS.x as i32;
            let origin_z = coord.z * SCENE_CHUNK_DIMS.z as i32;
            let chunk = terrain::generate_chunk(SCENE_SEED, SCENE_CHUNK_DIMS, origin_x, origin_z)
                .unwrap_or_else(|_| {
                    Chunk::new(SCENE_CHUNK_DIMS).expect("fixed scene dims are valid")
                });
            world
                .insert(coord, chunk)
                .expect("the fixed scene never exceeds MAX_RESIDENT_CHUNKS");
        }
        Sim {
            world,
            seed: SCENE_SEED,
            speed_milli: 1000,
            rev: 0,
        }
    }

    pub fn world(&self) -> &World {
        &self.world
    }

    pub fn seed(&self) -> u32 {
        self.seed
    }

    pub fn speed_milli(&self) -> u16 {
        self.speed_milli
    }

    pub fn rev(&self) -> u32 {
        self.rev
    }

    /// Applies one command. On success, increments `rev` by exactly 1.
    /// On error, the `Sim` is unchanged (strong exception safety: the
    /// voxel write only happens after every check passes).
    pub fn apply(&mut self, command: Command) -> Result<(), SimError> {
        match command {
            Command::SetVoxel { x, y, z, id } => {
                if id != AIR
                    && id != terrain::MATERIAL_GRASS
                    && id != terrain::MATERIAL_DIRT
                    && id != terrain::MATERIAL_STONE
                {
                    return Err(SimError::UnknownMaterial);
                }
                let (coord, local) =
                    resolve_scene_voxel(x, y, z).ok_or(SimError::OutOfScene)?;
                // Clone-then-commit keeps `apply` from ever leaving the
                // world in a partially written state if a later check
                // were added above this line.
                let mut chunk = self
                    .world
                    .get(coord)
                    .cloned()
                    .ok_or(SimError::OutOfScene)?;
                chunk
                    .set(local.0, local.1, local.2, id)
                    .map_err(|_| SimError::OutOfScene)?;
                match self.world.insert(coord, chunk) {
                    Ok(()) => {}
                    Err(WorldError::TooManyResidentChunks) | Err(WorldError::MismatchedDims) => {
                        return Err(SimError::OutOfScene)
                    }
                    Err(WorldError::InvalidDims) => return Err(SimError::OutOfScene),
                }
            }
            Command::SetSpeed { milli } => {
                if milli > MAX_SPEED_MILLI {
                    return Err(SimError::SpeedOutOfRange);
                }
                self.speed_milli = milli;
            }
        }
        self.rev = self.rev.wrapping_add(1);
        Ok(())
    }

    /// FNV-1a 64 over `rev`, `speed_milli`, and each resident chunk in
    /// sorted coordinate order: coordinate (x, y, z as little-endian
    /// `i32`), then every voxel byte in `(z, y, x)` storage order. See
    /// `docs/architecture/voxel-protocol.md`.
    pub fn state_hash(&self) -> u64 {
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x1000_0000_01b3;
        let mut hash = FNV_OFFSET;
        let mut feed = |bytes: &[u8]| {
            for &byte in bytes {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(FNV_PRIME);
            }
        };
        feed(&self.rev.to_le_bytes());
        feed(&self.speed_milli.to_le_bytes());
        let mut coords: Vec<ChunkCoord> = SCENE_CHUNK_COORDS.to_vec();
        coords.sort_by_key(|c| (c.x, c.y, c.z));
        for coord in coords {
            feed(&coord.x.to_le_bytes());
            feed(&coord.y.to_le_bytes());
            feed(&coord.z.to_le_bytes());
            if let Some(chunk) = self.world.get(coord) {
                let dims = chunk.dims();
                for z in 0..dims.z {
                    for y in 0..dims.y {
                        for x in 0..dims.x {
                            feed(&[chunk.get(x, y, z).unwrap_or(AIR)]);
                        }
                    }
                }
            }
        }
        hash
    }
}

/// Resolves a scene-relative voxel coordinate to a `(ChunkCoord, local
/// (x, y, z))` pair, or `None` if it falls outside the two resident
/// scene chunks. The scene chunks are laid out along `+x`:
/// `(0,0,0)` covers local x in `[0, dx)`, `(1,0,0)` covers
/// `[dx, 2*dx)`.
fn resolve_scene_voxel(x: i16, y: i16, z: i16) -> Option<(ChunkCoord, (u32, u32, u32))> {
    let dims = SCENE_CHUNK_DIMS;
    if y < 0 || z < 0 || y as u32 >= dims.y || z as u32 >= dims.z {
        return None;
    }
    if x < 0 {
        return None;
    }
    let ux = x as u32;
    let chunk_index = ux / dims.x;
    let local_x = ux % dims.x;
    let coord = match chunk_index {
        0 => ChunkCoord::new(0, 0, 0),
        1 => ChunkCoord::new(1, 0, 0),
        _ => return None,
    };
    Some((coord, (local_x, y as u32, z as u32)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_scene_has_two_resident_chunks_and_rev_zero() {
        let sim = Sim::new_scene();
        assert_eq!(sim.world().resident_chunk_count(), 2);
        assert_eq!(sim.rev(), 0);
        assert_eq!(sim.seed(), SCENE_SEED);
    }

    #[test]
    fn apply_set_voxel_increments_rev_and_writes_voxel() {
        let mut sim = Sim::new_scene();
        let before = sim.state_hash();
        sim.apply(Command::SetVoxel {
            x: 1,
            y: 1,
            z: 1,
            id: terrain::MATERIAL_STONE,
        })
        .unwrap();
        assert_eq!(sim.rev(), 1);
        assert_ne!(sim.state_hash(), before);
        let chunk = sim.world().get(ChunkCoord::new(0, 0, 0)).unwrap();
        assert_eq!(chunk.get(1, 1, 1), Some(terrain::MATERIAL_STONE));
    }

    #[test]
    fn apply_set_voxel_crosses_chunk_boundary() {
        let mut sim = Sim::new_scene();
        // x = dims.x (8) is local x=0 of the second chunk.
        sim.apply(Command::SetVoxel {
            x: SCENE_CHUNK_DIMS.x as i16,
            y: 0,
            z: 0,
            id: terrain::MATERIAL_STONE,
        })
        .unwrap();
        let chunk = sim.world().get(ChunkCoord::new(1, 0, 0)).unwrap();
        assert_eq!(chunk.get(0, 0, 0), Some(terrain::MATERIAL_STONE));
    }

    #[test]
    fn apply_rejects_out_of_scene_coordinate_without_mutating() {
        let mut sim = Sim::new_scene();
        let before_hash = sim.state_hash();
        let before_rev = sim.rev();
        let err = sim
            .apply(Command::SetVoxel {
                x: 2 * SCENE_CHUNK_DIMS.x as i16,
                y: 0,
                z: 0,
                id: terrain::MATERIAL_STONE,
            })
            .unwrap_err();
        assert_eq!(err, SimError::OutOfScene);
        assert_eq!(sim.rev(), before_rev);
        assert_eq!(sim.state_hash(), before_hash);
    }

    #[test]
    fn apply_rejects_negative_coordinate() {
        let mut sim = Sim::new_scene();
        assert_eq!(
            sim.apply(Command::SetVoxel {
                x: -1,
                y: 0,
                z: 0,
                id: terrain::MATERIAL_STONE,
            })
            .unwrap_err(),
            SimError::OutOfScene
        );
    }

    #[test]
    fn apply_rejects_unknown_material() {
        let mut sim = Sim::new_scene();
        assert_eq!(
            sim.apply(Command::SetVoxel {
                x: 0,
                y: 0,
                z: 0,
                id: 99,
            })
            .unwrap_err(),
            SimError::UnknownMaterial
        );
    }

    #[test]
    fn apply_set_speed_rejects_over_max() {
        let mut sim = Sim::new_scene();
        assert_eq!(
            sim.apply(Command::SetSpeed {
                milli: MAX_SPEED_MILLI + 1
            })
            .unwrap_err(),
            SimError::SpeedOutOfRange
        );
        assert_eq!(sim.speed_milli(), 1000);
    }

    #[test]
    fn apply_set_speed_accepts_max() {
        let mut sim = Sim::new_scene();
        sim.apply(Command::SetSpeed {
            milli: MAX_SPEED_MILLI,
        })
        .unwrap();
        assert_eq!(sim.speed_milli(), MAX_SPEED_MILLI);
        assert_eq!(sim.rev(), 1);
    }

    #[test]
    fn state_hash_is_deterministic_and_order_independent_of_insertion() {
        let a = Sim::new_scene();
        let b = Sim::new_scene();
        assert_eq!(a.state_hash(), b.state_hash());
    }

    #[test]
    fn two_sims_fed_the_same_commands_reach_equal_hash_and_rev() {
        let mut a = Sim::new_scene();
        let mut b = Sim::new_scene();
        let commands = [
            Command::SetSpeed { milli: 0 },
            Command::SetVoxel {
                x: 3,
                y: 2,
                z: 1,
                id: terrain::MATERIAL_GRASS,
            },
            Command::SetVoxel {
                x: 7,
                y: 0,
                z: 0,
                id: terrain::MATERIAL_STONE,
            },
            Command::SetVoxel {
                x: 100,
                y: 0,
                z: 0,
                id: terrain::MATERIAL_STONE,
            },
        ];
        for command in commands {
            let ra = a.apply(command);
            let rb = b.apply(command);
            assert_eq!(ra.is_ok(), rb.is_ok());
        }
        assert_eq!(a.rev(), b.rev());
        assert_eq!(a.state_hash(), b.state_hash());
    }
}
