//! The bounded `VXP1` wire codec for mixed-mode (mode B). See
//! `docs/architecture/voxel-protocol.md` for the authoritative byte
//! layout; this module implements exactly that layout.
//!
//! No function in this module can panic. Every length is checked
//! before any read, slice, or allocation. Every decode function
//! returns a [`Result`].

use crate::sim::Command;

pub const MAGIC: [u8; 4] = *b"VXP1";
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 24;

/// Largest permitted client request body, per the protocol contract.
pub const MAX_CLIENT_BODY: usize = 1024;
/// Largest permitted server response body.
pub const MAX_SERVER_BODY: usize = 16384;
/// Largest permitted number of command records in `Inputs` or `Delta`.
pub const MAX_COMMANDS: usize = 64;
/// Largest permitted number of chunks in a `Snapshot`.
pub const MAX_SNAPSHOT_CHUNKS: usize = 4;
/// Encoded size, in bytes, of one command record (voxel or speed).
pub const COMMAND_RECORD_LEN: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Hello,
    Inputs,
    Snapshot,
    Delta,
    Error,
}

impl Kind {
    fn from_byte(b: u8) -> Option<Kind> {
        match b {
            1 => Some(Kind::Hello),
            2 => Some(Kind::Inputs),
            16 => Some(Kind::Snapshot),
            17 => Some(Kind::Delta),
            18 => Some(Kind::Error),
            _ => None,
        }
    }

    pub fn to_byte(self) -> u8 {
        match self {
            Kind::Hello => 1,
            Kind::Inputs => 2,
            Kind::Snapshot => 16,
            Kind::Delta => 17,
            Kind::Error => 18,
        }
    }
}

/// `Error` body `code` values. See `docs/architecture/voxel-protocol.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Version = 1,
    World = 2,
    Malformed = 3,
    TooLarge = 4,
    Stale = 5,
    Gap = 6,
    Rejected = 7,
}

impl ErrorCode {
    pub fn from_u16(v: u16) -> Option<ErrorCode> {
        match v {
            1 => Some(ErrorCode::Version),
            2 => Some(ErrorCode::World),
            3 => Some(ErrorCode::Malformed),
            4 => Some(ErrorCode::TooLarge),
            5 => Some(ErrorCode::Stale),
            6 => Some(ErrorCode::Gap),
            7 => Some(ErrorCode::Rejected),
            _ => None,
        }
    }
}

/// A decode or encode failure. Distinct from [`ErrorCode`], which is a
/// wire-level `Error` *frame* sent between peers; `CodecError` is a
/// local Rust `Result` failure (for example, a buffer too small to
/// hold the frame this function was asked to build).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecError {
    TooShort,
    BadMagic,
    UnsupportedVersion,
    UnknownKind,
    NonZeroFlags,
    BodyLenMismatch,
    BodyTooLarge,
    TooManyRecords,
    OddRleLength,
    DecodedLengthMismatch,
    Malformed,
    UnknownErrorCode,
    OutputTooSmall,
}

/// A decoded frame header plus a borrowed view of its body bytes.
#[derive(Clone, Copy, Debug)]
pub struct Header {
    pub kind: Kind,
    pub world_id: u32,
    pub seq: u32,
    pub rev: u32,
}

/// Splits `buf` into a validated [`Header`] and its body slice. Checks
/// magic, version, kind, flags, and that `body_len` exactly matches
/// the remaining bytes, before returning any body slice.
pub fn decode_header(buf: &[u8]) -> Result<(Header, &[u8]), CodecError> {
    if buf.len() < HEADER_LEN {
        return Err(CodecError::TooShort);
    }
    if buf[0..4] != MAGIC {
        return Err(CodecError::BadMagic);
    }
    let version = u16::from_le_bytes([buf[4], buf[5]]);
    if version != VERSION {
        return Err(CodecError::UnsupportedVersion);
    }
    let kind = Kind::from_byte(buf[6]).ok_or(CodecError::UnknownKind)?;
    if buf[7] != 0 {
        return Err(CodecError::NonZeroFlags);
    }
    let world_id = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    let seq = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    let rev = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let body_len = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]) as usize;
    let body = &buf[HEADER_LEN..];
    if body_len != body.len() {
        return Err(CodecError::BodyLenMismatch);
    }
    Ok((
        Header {
            kind,
            world_id,
            seq,
            rev,
        },
        body,
    ))
}

/// Writes a 24-byte header into `out[0..24]`. `out` must be at least
/// `HEADER_LEN + body_len` bytes; the caller writes the body starting
/// at `out[HEADER_LEN..]`.
fn encode_header(
    out: &mut [u8],
    kind: Kind,
    world_id: u32,
    seq: u32,
    rev: u32,
    body_len: u32,
) -> Result<(), CodecError> {
    if out.len() < HEADER_LEN {
        return Err(CodecError::OutputTooSmall);
    }
    out[0..4].copy_from_slice(&MAGIC);
    out[4..6].copy_from_slice(&VERSION.to_le_bytes());
    out[6] = kind.to_byte();
    out[7] = 0;
    out[8..12].copy_from_slice(&world_id.to_le_bytes());
    out[12..16].copy_from_slice(&seq.to_le_bytes());
    out[16..20].copy_from_slice(&rev.to_le_bytes());
    out[20..24].copy_from_slice(&body_len.to_le_bytes());
    Ok(())
}

/// Decodes one 8-byte command record. For `op == 2` (`SetSpeed`), `x`
/// holds the `milli` value as raw `u16` bits and `id`/`y`/`z` must be
/// zero so a future field cannot smuggle hidden state through them.
fn decode_command_record(b: &[u8]) -> Result<Command, CodecError> {
    if b.len() != COMMAND_RECORD_LEN {
        return Err(CodecError::TooShort);
    }
    let op = b[0];
    let id = b[1];
    let x = i16::from_le_bytes([b[2], b[3]]);
    let y = i16::from_le_bytes([b[4], b[5]]);
    let z = i16::from_le_bytes([b[6], b[7]]);
    match op {
        1 => Ok(Command::SetVoxel { x, y, z, id }),
        2 => {
            if id != 0 || y != 0 || z != 0 {
                return Err(CodecError::UnknownKind);
            }
            Ok(Command::SetSpeed { milli: x as u16 })
        }
        _ => Err(CodecError::UnknownKind),
    }
}

fn encode_command_record(out: &mut [u8], command: Command) -> Result<(), CodecError> {
    if out.len() < COMMAND_RECORD_LEN {
        return Err(CodecError::OutputTooSmall);
    }
    match command {
        Command::SetVoxel { x, y, z, id } => {
            out[0] = 1;
            out[1] = id;
            out[2..4].copy_from_slice(&x.to_le_bytes());
            out[4..6].copy_from_slice(&y.to_le_bytes());
            out[6..8].copy_from_slice(&z.to_le_bytes());
        }
        Command::SetSpeed { milli } => {
            out[0] = 2;
            out[1] = 0;
            out[2..4].copy_from_slice(&(milli as i16).to_le_bytes());
            out[4..8].fill(0);
        }
    }
    Ok(())
}

/// Decodes an `Inputs` body: `count: u16` then `count` 8-byte records.
/// `count` must be `<= MAX_COMMANDS` and the body must be exactly the
/// right length; a vector is only allocated once that is confirmed.
pub fn decode_inputs(body: &[u8]) -> Result<Vec<Command>, CodecError> {
    if body.len() < 2 {
        return Err(CodecError::TooShort);
    }
    let count = u16::from_le_bytes([body[0], body[1]]) as usize;
    if count > MAX_COMMANDS {
        return Err(CodecError::TooManyRecords);
    }
    let expected = 2 + count * COMMAND_RECORD_LEN;
    if body.len() != expected {
        return Err(CodecError::BodyLenMismatch);
    }
    let mut commands = Vec::with_capacity(count);
    for i in 0..count {
        let start = 2 + i * COMMAND_RECORD_LEN;
        commands.push(decode_command_record(
            &body[start..start + COMMAND_RECORD_LEN],
        )?);
    }
    Ok(commands)
}

/// Encodes a full `Inputs` frame (header + body) into `out`. Returns
/// the number of bytes written.
pub fn encode_inputs(
    out: &mut [u8],
    world_id: u32,
    seq: u32,
    rev: u32,
    commands: &[Command],
) -> Result<usize, CodecError> {
    if commands.len() > MAX_COMMANDS {
        return Err(CodecError::TooManyRecords);
    }
    let body_len = 2 + commands.len() * COMMAND_RECORD_LEN;
    let total = HEADER_LEN + body_len;
    if total > out.len() {
        return Err(CodecError::OutputTooSmall);
    }
    if body_len > MAX_CLIENT_BODY {
        return Err(CodecError::BodyTooLarge);
    }
    encode_header(out, Kind::Inputs, world_id, seq, rev, body_len as u32)?;
    out[HEADER_LEN..HEADER_LEN + 2].copy_from_slice(&(commands.len() as u16).to_le_bytes());
    for (i, &command) in commands.iter().enumerate() {
        let start = HEADER_LEN + 2 + i * COMMAND_RECORD_LEN;
        encode_command_record(&mut out[start..start + COMMAND_RECORD_LEN], command)?;
    }
    Ok(total)
}

/// Encodes a `Hello` frame (empty body).
pub fn encode_hello(out: &mut [u8], seq: u32) -> Result<usize, CodecError> {
    if out.len() < HEADER_LEN {
        return Err(CodecError::OutputTooSmall);
    }
    encode_header(out, Kind::Hello, 0, seq, 0, 0)?;
    Ok(HEADER_LEN)
}

/// One decoded `Snapshot` chunk: dimensions and decoded (expanded)
/// voxel bytes in `(z, y, x)` order, matching [`crate::chunk::Chunk`].
#[derive(Clone, Debug)]
pub struct SnapshotChunk {
    pub cx: i16,
    pub cy: i16,
    pub cz: i16,
    pub dx: u8,
    pub dy: u8,
    pub dz: u8,
    pub voxels: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub seed: u32,
    pub speed_milli: u16,
    pub chunks: Vec<SnapshotChunk>,
}

/// Decodes a `Snapshot` body. Checks `chunk_count <= MAX_SNAPSHOT_CHUNKS`,
/// each `rle_len` is even, and the RLE-decoded length equals the
/// chunk's declared volume exactly, before returning.
pub fn decode_snapshot(body: &[u8]) -> Result<Snapshot, CodecError> {
    if body.len() < 8 {
        return Err(CodecError::TooShort);
    }
    let seed = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let speed_milli = u16::from_le_bytes([body[4], body[5]]);
    let chunk_count = u16::from_le_bytes([body[6], body[7]]) as usize;
    if chunk_count > MAX_SNAPSHOT_CHUNKS {
        return Err(CodecError::TooManyRecords);
    }
    let mut offset = 8;
    let mut chunks = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        if offset + 16 > body.len() {
            return Err(CodecError::TooShort);
        }
        let cx = i16::from_le_bytes([body[offset], body[offset + 1]]);
        let cy = i16::from_le_bytes([body[offset + 2], body[offset + 3]]);
        let cz = i16::from_le_bytes([body[offset + 4], body[offset + 5]]);
        let dx = body[offset + 6];
        let dy = body[offset + 7];
        let dz = body[offset + 8];
        let pad = body[offset + 9];
        if pad != 0 {
            return Err(CodecError::NonZeroFlags);
        }
        let rle_len = u32::from_le_bytes([
            body[offset + 10],
            body[offset + 11],
            body[offset + 12],
            body[offset + 13],
        ]) as usize;
        offset += 14;
        if rle_len % 2 != 0 {
            return Err(CodecError::OddRleLength);
        }
        if offset + rle_len > body.len() {
            return Err(CodecError::TooShort);
        }
        let rle = &body[offset..offset + rle_len];
        offset += rle_len;
        let volume = (dx as u64) * (dy as u64) * (dz as u64);
        // Bound the decode target before allocating, so a crafted
        // huge `dx`/`dy`/`dz` cannot request an unbounded Vec.
        if volume > crate::chunk::MAX_CHUNK_VOLUME {
            return Err(CodecError::BodyTooLarge);
        }
        let mut voxels = Vec::with_capacity(volume as usize);
        let mut pair = rle.chunks_exact(2);
        for p in &mut pair {
            let run = p[0];
            if run == 0 {
                return Err(CodecError::Malformed);
            }
            let id = p[1];
            voxels.resize(voxels.len() + run as usize, id);
        }
        if voxels.len() as u64 != volume {
            return Err(CodecError::DecodedLengthMismatch);
        }
        chunks.push(SnapshotChunk {
            cx,
            cy,
            cz,
            dx,
            dy,
            dz,
            voxels,
        });
    }
    if offset != body.len() {
        return Err(CodecError::BodyLenMismatch);
    }
    Ok(Snapshot {
        seed,
        speed_milli,
        chunks,
    })
}

/// Encodes a `Snapshot` frame using run-length encoding over each
/// chunk's voxel bytes in `(z, y, x)` order.
pub fn encode_snapshot(
    out: &mut [u8],
    world_id: u32,
    seq: u32,
    rev: u32,
    seed: u32,
    speed_milli: u16,
    chunks: &[(i16, i16, i16, &crate::chunk::Chunk)],
) -> Result<usize, CodecError> {
    if chunks.len() > MAX_SNAPSHOT_CHUNKS {
        return Err(CodecError::TooManyRecords);
    }
    let mut body = Vec::new();
    body.extend_from_slice(&seed.to_le_bytes());
    body.extend_from_slice(&speed_milli.to_le_bytes());
    body.extend_from_slice(&(chunks.len() as u16).to_le_bytes());
    for &(cx, cy, cz, chunk) in chunks {
        let dims = chunk.dims();
        body.extend_from_slice(&cx.to_le_bytes());
        body.extend_from_slice(&cy.to_le_bytes());
        body.extend_from_slice(&cz.to_le_bytes());
        body.push(dims.x as u8);
        body.push(dims.y as u8);
        body.push(dims.z as u8);
        body.push(0);
        let mut rle = Vec::new();
        let mut run_id: Option<u8> = None;
        let mut run_len: u32 = 0;
        let flush = |rle: &mut Vec<u8>, id: u8, len: u32| {
            let mut remaining = len;
            while remaining > 0 {
                let chunk_len = remaining.min(255) as u8;
                rle.push(chunk_len);
                rle.push(id);
                remaining -= chunk_len as u32;
            }
        };
        for z in 0..dims.z {
            for y in 0..dims.y {
                for x in 0..dims.x {
                    let id = chunk.get(x, y, z).unwrap_or(0);
                    match run_id {
                        Some(current) if current == id => run_len += 1,
                        Some(current) => {
                            flush(&mut rle, current, run_len);
                            run_id = Some(id);
                            run_len = 1;
                        }
                        None => {
                            run_id = Some(id);
                            run_len = 1;
                        }
                    }
                }
            }
        }
        if let Some(current) = run_id {
            flush(&mut rle, current, run_len);
        }
        body.extend_from_slice(&(rle.len() as u32).to_le_bytes());
        body.extend_from_slice(&rle);
    }
    let total = HEADER_LEN + body.len();
    if total > out.len() {
        return Err(CodecError::OutputTooSmall);
    }
    if body.len() > MAX_SERVER_BODY {
        return Err(CodecError::BodyTooLarge);
    }
    encode_header(out, Kind::Snapshot, world_id, seq, rev, body.len() as u32)?;
    out[HEADER_LEN..total].copy_from_slice(&body);
    Ok(total)
}

/// Decodes a `Delta` body: `base_rev: u32`, `count: u16`, then
/// `count` 8-byte command records.
pub fn decode_delta(body: &[u8]) -> Result<(u32, Vec<Command>), CodecError> {
    if body.len() < 6 {
        return Err(CodecError::TooShort);
    }
    let base_rev = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let count = u16::from_le_bytes([body[4], body[5]]) as usize;
    if count > MAX_COMMANDS {
        return Err(CodecError::TooManyRecords);
    }
    let expected = 6 + count * COMMAND_RECORD_LEN;
    if body.len() != expected {
        return Err(CodecError::BodyLenMismatch);
    }
    let mut commands = Vec::with_capacity(count);
    for i in 0..count {
        let start = 6 + i * COMMAND_RECORD_LEN;
        commands.push(decode_command_record(
            &body[start..start + COMMAND_RECORD_LEN],
        )?);
    }
    Ok((base_rev, commands))
}

pub fn encode_delta(
    out: &mut [u8],
    world_id: u32,
    seq: u32,
    rev: u32,
    base_rev: u32,
    commands: &[Command],
) -> Result<usize, CodecError> {
    if commands.len() > MAX_COMMANDS {
        return Err(CodecError::TooManyRecords);
    }
    let body_len = 6 + commands.len() * COMMAND_RECORD_LEN;
    let total = HEADER_LEN + body_len;
    if total > out.len() {
        return Err(CodecError::OutputTooSmall);
    }
    encode_header(out, Kind::Delta, world_id, seq, rev, body_len as u32)?;
    out[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&base_rev.to_le_bytes());
    out[HEADER_LEN + 4..HEADER_LEN + 6].copy_from_slice(&(commands.len() as u16).to_le_bytes());
    for (i, &command) in commands.iter().enumerate() {
        let start = HEADER_LEN + 6 + i * COMMAND_RECORD_LEN;
        encode_command_record(&mut out[start..start + COMMAND_RECORD_LEN], command)?;
    }
    Ok(total)
}

/// Decodes an `Error` body: `code: u16`.
pub fn decode_error(body: &[u8]) -> Result<ErrorCode, CodecError> {
    if body.len() != 2 {
        return Err(CodecError::BodyLenMismatch);
    }
    let code = u16::from_le_bytes([body[0], body[1]]);
    ErrorCode::from_u16(code).ok_or(CodecError::UnknownErrorCode)
}

pub fn encode_error(
    out: &mut [u8],
    world_id: u32,
    seq: u32,
    rev: u32,
    code: ErrorCode,
) -> Result<usize, CodecError> {
    let total = HEADER_LEN + 2;
    if total > out.len() {
        return Err(CodecError::OutputTooSmall);
    }
    encode_header(out, Kind::Error, world_id, seq, rev, 2)?;
    out[HEADER_LEN..total].copy_from_slice(&(code as u16).to_le_bytes());
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{Chunk, ChunkDims};

    #[test]
    fn decode_header_rejects_short_buffer() {
        assert_eq!(decode_header(&[0u8; 10]).unwrap_err(), CodecError::TooShort);
    }

    #[test]
    fn decode_header_rejects_bad_magic() {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(b"XXXX");
        assert_eq!(decode_header(&buf).unwrap_err(), CodecError::BadMagic);
    }

    #[test]
    fn decode_header_rejects_wrong_version() {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(&MAGIC);
        buf[4..6].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(
            decode_header(&buf).unwrap_err(),
            CodecError::UnsupportedVersion
        );
    }

    #[test]
    fn decode_header_rejects_unknown_kind() {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(&MAGIC);
        buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
        buf[6] = 99;
        assert_eq!(decode_header(&buf).unwrap_err(), CodecError::UnknownKind);
    }

    #[test]
    fn decode_header_rejects_nonzero_flags() {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(&MAGIC);
        buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
        buf[6] = 1;
        buf[7] = 1;
        assert_eq!(decode_header(&buf).unwrap_err(), CodecError::NonZeroFlags);
    }

    #[test]
    fn decode_header_rejects_body_len_mismatch() {
        let mut buf = vec![0u8; HEADER_LEN + 3];
        buf[0..4].copy_from_slice(&MAGIC);
        buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
        buf[6] = 1;
        buf[20..24].copy_from_slice(&99u32.to_le_bytes());
        assert_eq!(
            decode_header(&buf).unwrap_err(),
            CodecError::BodyLenMismatch
        );
    }

    #[test]
    fn hello_round_trips() {
        let mut buf = [0u8; HEADER_LEN];
        let n = encode_hello(&mut buf, 7).unwrap();
        assert_eq!(n, HEADER_LEN);
        let (header, body) = decode_header(&buf).unwrap();
        assert_eq!(header.kind, Kind::Hello);
        assert_eq!(header.seq, 7);
        assert!(body.is_empty());
    }

    #[test]
    fn inputs_round_trip_voxel_and_speed_commands() {
        let commands = vec![
            Command::SetVoxel {
                x: 1,
                y: -2,
                z: 3,
                id: 5,
            },
            Command::SetSpeed { milli: 1500 },
        ];
        let mut buf = [0u8; HEADER_LEN + 2 + 2 * COMMAND_RECORD_LEN];
        let n = encode_inputs(&mut buf, 42, 3, 9, &commands).unwrap();
        assert_eq!(n, buf.len());
        let (header, body) = decode_header(&buf[..n]).unwrap();
        assert_eq!(header.kind, Kind::Inputs);
        assert_eq!(header.world_id, 42);
        assert_eq!(header.seq, 3);
        assert_eq!(header.rev, 9);
        let decoded = decode_inputs(body).unwrap();
        assert_eq!(decoded, commands);
    }

    #[test]
    fn inputs_rejects_too_many_records() {
        assert_eq!(
            encode_inputs(
                &mut [0u8; 8192],
                0,
                0,
                0,
                &vec![Command::SetSpeed { milli: 0 }; MAX_COMMANDS + 1],
            )
            .unwrap_err(),
            CodecError::TooManyRecords
        );
        let mut body = vec![0u8; 2];
        body[0..2].copy_from_slice(&((MAX_COMMANDS + 1) as u16).to_le_bytes());
        assert_eq!(
            decode_inputs(&body).unwrap_err(),
            CodecError::TooManyRecords
        );
    }

    #[test]
    fn inputs_rejects_truncated_body() {
        let mut body = vec![0u8; 2 + COMMAND_RECORD_LEN - 1];
        body[0..2].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(
            decode_inputs(&body).unwrap_err(),
            CodecError::BodyLenMismatch
        );
    }

    #[test]
    fn snapshot_round_trips_two_chunks() {
        let dims = ChunkDims::new(2, 2, 2);
        let mut a = Chunk::new(dims).unwrap();
        a.set(0, 0, 0, 3).unwrap();
        let b = Chunk::new(dims).unwrap();
        let mut buf = vec![0u8; MAX_SERVER_BODY + HEADER_LEN];
        let n = encode_snapshot(
            &mut buf,
            1,
            2,
            3,
            20_261_111,
            1000,
            &[(0, 0, 0, &a), (1, 0, 0, &b)],
        )
        .unwrap();
        let (header, body) = decode_header(&buf[..n]).unwrap();
        assert_eq!(header.kind, Kind::Snapshot);
        let snapshot = decode_snapshot(body).unwrap();
        assert_eq!(snapshot.seed, 20_261_111);
        assert_eq!(snapshot.chunks.len(), 2);
        assert_eq!(snapshot.chunks[0].voxels[0], 3);
        assert_eq!(snapshot.chunks[1].voxels.iter().all(|&v| v == 0), true);
    }

    #[test]
    fn snapshot_rejects_odd_rle_length() {
        let mut body = vec![0u8; 8 + 16];
        body[6..8].copy_from_slice(&1u16.to_le_bytes());
        body[8 + 6] = 1;
        body[8 + 7] = 1;
        body[8 + 8] = 1;
        body[8 + 10..8 + 14].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            decode_snapshot(&body).unwrap_err(),
            CodecError::OddRleLength
        );
    }

    #[test]
    fn snapshot_rejects_decoded_length_mismatch() {
        let mut body = vec![0u8; 8 + 16 + 2];
        body[6..8].copy_from_slice(&1u16.to_le_bytes());
        body[8 + 6] = 1;
        body[8 + 7] = 1;
        body[8 + 8] = 1;
        body[8 + 10..8 + 14].copy_from_slice(&2u32.to_le_bytes());
        body[8 + 14] = 5; // run=5, but declared volume is 1
        body[8 + 15] = 9;
        assert_eq!(
            decode_snapshot(&body).unwrap_err(),
            CodecError::DecodedLengthMismatch
        );
    }

    #[test]
    fn snapshot_rejects_too_many_chunks() {
        let mut body = vec![0u8; 8];
        body[6..8].copy_from_slice(&((MAX_SNAPSHOT_CHUNKS + 1) as u16).to_le_bytes());
        assert_eq!(
            decode_snapshot(&body).unwrap_err(),
            CodecError::TooManyRecords
        );
    }

    #[test]
    fn delta_round_trips() {
        let commands = vec![Command::SetVoxel {
            x: 0,
            y: 0,
            z: 0,
            id: 1,
        }];
        let mut buf = [0u8; HEADER_LEN + 6 + COMMAND_RECORD_LEN];
        let n = encode_delta(&mut buf, 1, 5, 9, 8, &commands).unwrap();
        let (header, body) = decode_header(&buf[..n]).unwrap();
        assert_eq!(header.kind, Kind::Delta);
        let (base_rev, decoded) = decode_delta(body).unwrap();
        assert_eq!(base_rev, 8);
        assert_eq!(decoded, commands);
    }

    #[test]
    fn error_round_trips_and_rejects_unknown_code() {
        let mut buf = [0u8; HEADER_LEN + 2];
        let n = encode_error(&mut buf, 1, 2, 3, ErrorCode::Stale).unwrap();
        let (header, body) = decode_header(&buf[..n]).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(decode_error(body).unwrap(), ErrorCode::Stale);
        assert_eq!(
            decode_error(&[99, 0]).unwrap_err(),
            CodecError::UnknownErrorCode
        );
    }
}
