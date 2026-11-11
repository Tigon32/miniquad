//! `vx-server`: the std-only, loopback-only authoritative server for
//! the `VXP1` mixed-mode protocol. See
//! `docs/architecture/voxel-protocol.md` ("HTTP limits (server)" and
//! "Sequence and revision rules") for the contract this binary
//! implements.
//!
//! This binary depends on nothing but `std`. It serves one connection
//! at a time, with `Connection: close`, 2-second read/write timeouts,
//! and bounded request-line/header/body limits. It binds
//! `127.0.0.1` only: it is a local loopback prototype, not an
//! Internet service, and has no TLS or authentication.

use miniquad_voxel::protocol::{self, CodecError, ErrorCode, Kind};
use miniquad_voxel::sim::{Command, Sim};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

/// Default loopback port. Chosen to avoid the browser-adoption
/// starter's generated default (4174/4173) and the drawing companion's
/// default (4280); see `docs/architecture/voxel-protocol.md`.
const DEFAULT_PORT: u16 = 4230;

const MAX_REQUEST_LINE: usize = 1024;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_HEADER_LINES: usize = 32;
const MAX_CONTENT_LENGTH: usize = 1048;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// Last-applied-command ring size. Mirrors `protocol::MAX_COMMANDS`:
/// the server can serve a `Delta` only if the client's `rev` is within
/// this many commands of the current `rev`.
const RING_CAPACITY: usize = protocol::MAX_COMMANDS;

struct AppliedCommand {
    rev_after: u32,
    command: Command,
}

struct ServerState {
    sim: Sim,
    world_id: u32,
    /// `None` after start or after a `Hello`; `Some(seq)` is the last
    /// successfully processed `Inputs` sequence number.
    last_seq: Option<u32>,
    last_response: Vec<u8>,
    ring: VecDeque<AppliedCommand>,
}

impl ServerState {
    fn new(world_id: u32) -> ServerState {
        ServerState {
            sim: Sim::new_scene(),
            world_id,
            last_seq: None,
            last_response: Vec::new(),
            ring: VecDeque::new(),
        }
    }

    fn push_ring(&mut self, rev_after: u32, command: Command) {
        if self.ring.len() >= RING_CAPACITY {
            self.ring.pop_front();
        }
        self.ring.push_back(AppliedCommand { rev_after, command });
    }
}

/// Chooses `Delta` when the ring holds an unbroken run of applied
/// commands from `client_rev` up to the current revision, else
/// `Snapshot`. A `client_rev` newer than the current revision (for
/// example after a server restart) is never delta-servable.
fn can_serve_delta(ring: &VecDeque<AppliedCommand>, current_rev: u32, client_rev: u32) -> bool {
    if client_rev > current_rev {
        return false;
    }
    if client_rev == current_rev {
        return true;
    }
    match ring.front() {
        Some(oldest) => oldest.rev_after.wrapping_sub(1) <= client_rev,
        None => false,
    }
}

fn encode_snapshot_response(state: &ServerState, seq: u32) -> Vec<u8> {
    let mut chunks_ref = Vec::new();
    for coord in miniquad_voxel::sim::SCENE_CHUNK_COORDS {
        if let Some(chunk) = state.sim.world().get(coord) {
            chunks_ref.push((coord.x as i16, coord.y as i16, coord.z as i16, chunk));
        }
    }
    let mut out = vec![0u8; protocol::HEADER_LEN + protocol::MAX_SERVER_BODY];
    let n = protocol::encode_snapshot(
        &mut out,
        state.world_id,
        seq,
        state.sim.rev(),
        state.sim.seed(),
        state.sim.speed_milli(),
        &chunks_ref,
    )
    .expect("the fixed scene always fits MAX_SERVER_BODY");
    out.truncate(n);
    out
}

fn encode_delta_response(state: &ServerState, seq: u32, client_rev: u32) -> Vec<u8> {
    let commands: Vec<Command> = state
        .ring
        .iter()
        .filter(|c| c.rev_after > client_rev)
        .map(|c| c.command)
        .collect();
    let mut out = vec![0u8; protocol::HEADER_LEN + 6 + commands.len() * protocol::COMMAND_RECORD_LEN];
    let n = protocol::encode_delta(
        &mut out,
        state.world_id,
        seq,
        state.sim.rev(),
        client_rev,
        &commands,
    )
    .expect("the ring never exceeds MAX_COMMANDS entries");
    out.truncate(n);
    out
}

fn encode_error_response(state: &ServerState, seq: u32, code: ErrorCode) -> Vec<u8> {
    let mut out = vec![0u8; protocol::HEADER_LEN + 2];
    let n = protocol::encode_error(&mut out, state.world_id, seq, state.sim.rev(), code)
        .expect("fixed-size error frame always fits");
    out.truncate(n);
    out
}

/// Processes one decoded `VXP1` request frame and returns the response
/// frame bytes. Never panics: every failure path returns an `Error`
/// frame instead.
fn handle_frame(state: &mut ServerState, frame: &[u8]) -> Vec<u8> {
    let (header, body) = match protocol::decode_header(frame) {
        Ok(v) => v,
        Err(CodecError::UnsupportedVersion) => {
            return encode_error_response(state, 0, ErrorCode::Version)
        }
        Err(_) => return encode_error_response(state, 0, ErrorCode::Malformed),
    };

    match header.kind {
        Kind::Hello => {
            state.last_seq = None;
            encode_snapshot_response(state, header.seq)
        }
        Kind::Inputs => {
            if header.world_id != state.world_id {
                return encode_error_response(state, header.seq, ErrorCode::World);
            }
            let expected_next = state.last_seq.map_or(1, |s| s.wrapping_add(1));
            if Some(header.seq) == state.last_seq {
                return state.last_response.clone();
            }
            if header.seq < expected_next {
                return encode_error_response(state, header.seq, ErrorCode::Stale);
            }
            if header.seq > expected_next {
                return encode_error_response(state, header.seq, ErrorCode::Gap);
            }
            let commands = match protocol::decode_inputs(body) {
                Ok(c) => c,
                Err(_) => return encode_error_response(state, header.seq, ErrorCode::Malformed),
            };
            for command in commands {
                if state.sim.apply(command).is_err() {
                    let response = encode_error_response(state, header.seq, ErrorCode::Rejected);
                    state.last_seq = Some(header.seq);
                    state.last_response = response.clone();
                    return response;
                }
                state.push_ring(state.sim.rev(), command);
            }
            let response = if can_serve_delta(&state.ring, state.sim.rev(), header.rev) {
                encode_delta_response(state, header.seq, header.rev)
            } else {
                encode_snapshot_response(state, header.seq)
            };
            state.last_seq = Some(header.seq);
            state.last_response = response.clone();
            response
        }
        // The server never receives Snapshot/Delta/Error as a request kind.
        Kind::Snapshot | Kind::Delta | Kind::Error => {
            encode_error_response(state, header.seq, ErrorCode::Malformed)
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    content_length: Option<usize>,
    has_transfer_encoding: bool,
}

#[derive(Debug)]
#[allow(dead_code)] // Debug-only detail kept for a future structured 400 response body.
enum HttpError {
    RequestLineTooLong,
    HeadersTooLarge,
    TooManyHeaderLines,
    Malformed,
    Timeout,
}

/// Reads and parses the request line and headers from `stream`,
/// bounded by `MAX_REQUEST_LINE`, `MAX_HEADER_BYTES`, and
/// `MAX_HEADER_LINES`. Returns the parsed request and any body bytes
/// already read past the header terminator in the same TCP read
/// (`stream.read` can return more than exactly the header bytes).
fn read_request_head(stream: &mut TcpStream) -> Result<(HttpRequest, Vec<u8>), HttpError> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        if buf.len() > MAX_HEADER_BYTES {
            return Err(HttpError::HeadersTooLarge);
        }
        if let Some(pos) = find_header_end(&buf) {
            let head = buf[..pos].to_vec();
            let leftover = buf[pos + 4..].to_vec();
            let request = parse_head(&head)?;
            return Ok((request, leftover));
        }
        let n = stream.read(&mut chunk).map_err(|_| HttpError::Timeout)?;
        if n == 0 {
            return Err(HttpError::Malformed);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_head(head: &[u8]) -> Result<HttpRequest, HttpError> {
    let text = std::str::from_utf8(head).map_err(|_| HttpError::Malformed)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(HttpError::Malformed)?;
    if request_line.len() > MAX_REQUEST_LINE {
        return Err(HttpError::RequestLineTooLong);
    }
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(HttpError::Malformed)?.to_string();
    let path = parts.next().ok_or(HttpError::Malformed)?.to_string();
    let _version = parts.next().ok_or(HttpError::Malformed)?;

    let mut content_length = None;
    let mut has_transfer_encoding = false;
    let mut line_count = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        line_count += 1;
        if line_count > MAX_HEADER_LINES {
            return Err(HttpError::TooManyHeaderLines);
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpError::Malformed);
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            let parsed: usize = value.parse().map_err(|_| HttpError::Malformed)?;
            content_length = Some(parsed);
        } else if name == "transfer-encoding" {
            has_transfer_encoding = true;
        }
    }

    Ok(HttpRequest {
        method,
        path,
        content_length,
        has_transfer_encoding,
    })
}

fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    // Best-effort write: a slow or closed peer cannot crash the server.
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn handle_connection(mut stream: TcpStream, state: &mut ServerState) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let (request, leftover) = match read_request_head(&mut stream) {
        Ok(r) => r,
        Err(_) => {
            write_response(&mut stream, "400 Bad Request", "text/plain", b"");
            return;
        }
    };

    if request.method == "GET" && request.path == "/health" {
        write_response(&mut stream, "200 OK", "text/plain", b"ok");
        return;
    }

    if request.path != "/vx/v1/sync" {
        write_response(&mut stream, "404 Not Found", "text/plain", b"");
        return;
    }
    if request.method != "POST" {
        write_response(&mut stream, "405 Method Not Allowed", "text/plain", b"");
        return;
    }
    if request.has_transfer_encoding {
        write_response(&mut stream, "400 Bad Request", "text/plain", b"");
        return;
    }
    let Some(content_length) = request.content_length else {
        write_response(&mut stream, "400 Bad Request", "text/plain", b"");
        return;
    };
    if content_length > MAX_CONTENT_LENGTH {
        write_response(&mut stream, "400 Bad Request", "text/plain", b"");
        return;
    }
    if leftover.len() > content_length {
        // The client sent more bytes than its declared Content-Length;
        // that is malformed, not a frame this server should try to use.
        write_response(&mut stream, "400 Bad Request", "text/plain", b"");
        return;
    }

    let mut body = vec![0u8; content_length];
    body[..leftover.len()].copy_from_slice(&leftover);
    if stream.read_exact(&mut body[leftover.len()..]).is_err() {
        write_response(&mut stream, "400 Bad Request", "text/plain", b"");
        return;
    }

    let response = handle_frame(state, &body);
    write_response(&mut stream, "200 OK", "application/octet-stream", &response);
}

fn parse_args() -> (u16, u32) {
    let mut port = DEFAULT_PORT;
    let mut world_id = 1u32;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(v) = args.next() {
                    if let Ok(p) = v.parse() {
                        port = p;
                    }
                }
            }
            "--world" => {
                if let Some(v) = args.next() {
                    if let Ok(w) = v.parse() {
                        world_id = w;
                    }
                }
            }
            _ => {}
        }
    }
    (port, world_id)
}

fn main() {
    let (port, world_id) = parse_args();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
        eprintln!("vx-server: failed to bind 127.0.0.1:{port}: {e}");
        std::process::exit(1);
    });
    // Report the actual bound port (not the requested one), so a test
    // harness can request port 0 (OS-assigned) and still discover the
    // live port from stdout.
    let actual_port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(port);
    println!("vx-server: listening on 127.0.0.1:{actual_port} (world_id={world_id})");
    let mut state = ServerState::new(world_id);
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle_connection(stream, &mut state),
            Err(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_head_extracts_method_path_and_content_length() {
        let head = b"POST /vx/v1/sync HTTP/1.1\r\nHost: x\r\nContent-Length: 24\r\n";
        let req = parse_head(head).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/vx/v1/sync");
        assert_eq!(req.content_length, Some(24));
        assert!(!req.has_transfer_encoding);
    }

    #[test]
    fn parse_head_rejects_too_many_header_lines() {
        let mut head = String::from("GET / HTTP/1.1\r\n");
        for i in 0..40 {
            head.push_str(&format!("X-{i}: v\r\n"));
        }
        assert!(matches!(
            parse_head(head.as_bytes()),
            Err(HttpError::TooManyHeaderLines)
        ));
    }

    #[test]
    fn parse_head_detects_transfer_encoding() {
        let head = b"POST /vx/v1/sync HTTP/1.1\r\nTransfer-Encoding: chunked\r\n";
        assert!(parse_head(head).unwrap().has_transfer_encoding);
    }

    #[test]
    fn hello_always_returns_snapshot_and_resets_last_seq() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN];
        protocol::encode_hello(&mut req, 0).unwrap();
        let response = handle_frame(&mut state, &req);
        let (header, _) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Snapshot);
        assert!(state.last_seq.is_none());
    }

    #[test]
    fn inputs_rejects_wrong_world_id() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req, 99, 1, 0, &[]).unwrap();
        let response = handle_frame(&mut state, &req);
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::World);
    }

    #[test]
    fn duplicate_seq_returns_cached_response_without_reapplying() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN + 2 + protocol::COMMAND_RECORD_LEN];
        protocol::encode_inputs(
            &mut req,
            7,
            1,
            0,
            &[Command::SetSpeed { milli: 500 }],
        )
        .unwrap();
        let first = handle_frame(&mut state, &req);
        let rev_after_first = state.sim.rev();
        let second = handle_frame(&mut state, &req);
        assert_eq!(first, second);
        assert_eq!(state.sim.rev(), rev_after_first, "must not reapply");
    }

    #[test]
    fn stale_seq_is_rejected() {
        let mut state = ServerState::new(7);
        let mut req1 = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req1, 7, 1, 0, &[]).unwrap();
        handle_frame(&mut state, &req1);
        let mut req0 = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req0, 7, 1, 0, &[]).unwrap();
        // seq 1 was already applied; resending seq 1 is a duplicate, so
        // use a seq below that (impossible since seq started at 1); a
        // true stale case is seq 1 after last_seq has advanced to 2.
        let mut req2 = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req2, 7, 2, 0, &[]).unwrap();
        handle_frame(&mut state, &req2);
        let response = handle_frame(&mut state, &req1);
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::Stale);
    }

    #[test]
    fn gap_seq_is_rejected() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req, 7, 5, 0, &[]).unwrap();
        let response = handle_frame(&mut state, &req);
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::Gap);
    }

    #[test]
    fn rejected_command_returns_error_and_advances_seq() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN + 2 + protocol::COMMAND_RECORD_LEN];
        protocol::encode_inputs(
            &mut req,
            7,
            1,
            0,
            &[Command::SetVoxel {
                x: -1,
                y: 0,
                z: 0,
                id: 1,
            }],
        )
        .unwrap();
        let response = handle_frame(&mut state, &req);
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::Rejected);
        assert_eq!(state.last_seq, Some(1));
    }

    #[test]
    fn client_rev_newer_than_server_triggers_snapshot_not_delta() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN + 2];
        // header.rev (client's last applied rev) is far ahead, simulating
        // a server restart that lost history.
        protocol::encode_inputs(&mut req, 7, 1, 999, &[]).unwrap();
        let response = handle_frame(&mut state, &req);
        let (header, _) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Snapshot);
    }

    #[test]
    fn delta_served_when_ring_covers_client_rev() {
        let mut state = ServerState::new(7);
        let mut req1 = vec![0u8; protocol::HEADER_LEN + 2 + protocol::COMMAND_RECORD_LEN];
        protocol::encode_inputs(&mut req1, 7, 1, 0, &[Command::SetSpeed { milli: 10 }]).unwrap();
        handle_frame(&mut state, &req1);
        let rev_after_1 = state.sim.rev();
        let mut req2 = vec![0u8; protocol::HEADER_LEN + 2];
        protocol::encode_inputs(&mut req2, 7, 2, rev_after_1 - 1, &[]).unwrap();
        let response = handle_frame(&mut state, &req2);
        let (header, _) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Delta);
    }

    #[test]
    fn malformed_frame_yields_malformed_error() {
        let mut state = ServerState::new(7);
        let response = handle_frame(&mut state, b"not a frame at all");
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::Malformed);
    }

    #[test]
    fn wrong_version_yields_version_error() {
        let mut state = ServerState::new(7);
        let mut req = vec![0u8; protocol::HEADER_LEN];
        protocol::encode_hello(&mut req, 0).unwrap();
        req[4..6].copy_from_slice(&2u16.to_le_bytes());
        let response = handle_frame(&mut state, &req);
        let (header, body) = protocol::decode_header(&response).unwrap();
        assert_eq!(header.kind, Kind::Error);
        assert_eq!(protocol::decode_error(body).unwrap(), ErrorCode::Version);
    }
}
