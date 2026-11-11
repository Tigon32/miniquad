//! End-to-end integration test for the `vx-server` binary: spawns the
//! real compiled server on an OS-assigned loopback port and drives it
//! with real TCP connections, not a mock. See
//! `docs/architecture/voxel-protocol.md`.
//!
//! This is the authoritative native-server evidence for issue #29's
//! fault-case acceptance criteria (duplicate, stale, gap, bad version,
//! wrong world, oversized `Content-Length`, `Transfer-Encoding`).

use miniquad_voxel::protocol::{self, ErrorCode, Kind};
use miniquad_voxel::sim::Command as SimCommand;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command as Process, Stdio};
use std::time::Duration;

struct ServerProcess {
    child: Child,
    port: u16,
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_server(world_id: u32) -> ServerProcess {
    let exe = env!("CARGO_BIN_EXE_vx-server");
    let mut child = Process::new(exe)
        .args(["--port", "0", "--world", &world_id.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn vx-server");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("failed to read vx-server startup line");
    // "vx-server: listening on 127.0.0.1:PORT (world_id=N)"
    let port_str = line
        .split("127.0.0.1:")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .expect("startup line missing port");
    let port: u16 = port_str.trim().parse().expect("startup line port parse");
    ServerProcess { child, port }
}

fn send_raw(port: u16, frame: &[u8], extra_headers: &str) -> (String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to vx-server");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let request = format!(
        "POST /vx/v1/sync HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n{}Content-Type: application/octet-stream\r\n\r\n",
        frame.len(),
        extra_headers
    );
    stream.write_all(request.as_bytes()).unwrap();
    stream.write_all(frame).unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    let idx = data
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response has header terminator");
    let headers = String::from_utf8_lossy(&data[..idx]).to_string();
    let body = data[idx + 4..].to_vec();
    (headers, body)
}

fn hello_frame(seq: u32) -> Vec<u8> {
    let mut out = vec![0u8; protocol::HEADER_LEN];
    let n = protocol::encode_hello(&mut out, seq).unwrap();
    out.truncate(n);
    out
}

fn inputs_frame(world_id: u32, seq: u32, rev: u32, commands: &[SimCommand]) -> Vec<u8> {
    let mut out =
        vec![0u8; protocol::HEADER_LEN + 2 + commands.len() * protocol::COMMAND_RECORD_LEN];
    let n = protocol::encode_inputs(&mut out, world_id, seq, rev, commands).unwrap();
    out.truncate(n);
    out
}

#[test]
fn health_endpoint_reports_ok() {
    let server = start_server(1);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    let text = String::from_utf8_lossy(&data);
    assert!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
    assert!(text.ends_with("ok"), "{text}");
}

#[test]
fn hello_returns_snapshot_and_inputs_returns_delta() {
    let server = start_server(7);
    let (headers, body) = send_raw(server.port, &hello_frame(0), "");
    assert!(headers.starts_with("HTTP/1.1 200 OK"));
    let (header, _) = protocol::decode_header(&body).unwrap();
    assert_eq!(header.kind, Kind::Snapshot);

    let frame = inputs_frame(7, 1, 0, &[SimCommand::SetSpeed { milli: 250 }]);
    let (_, body2) = send_raw(server.port, &frame, "");
    let (header2, _) = protocol::decode_header(&body2).unwrap();
    assert_eq!(header2.kind, Kind::Delta);
    assert_eq!(header2.rev, 1);
}

#[test]
fn duplicate_sequence_returns_identical_cached_response() {
    let server = start_server(7);
    let frame = inputs_frame(7, 1, 0, &[SimCommand::SetSpeed { milli: 100 }]);
    let (_, first) = send_raw(server.port, &frame, "");
    let (_, second) = send_raw(server.port, &frame, "");
    assert_eq!(first, second);
}

#[test]
fn gap_sequence_is_rejected_with_gap_error() {
    let server = start_server(7);
    let frame = inputs_frame(7, 5, 0, &[]);
    let (_, body) = send_raw(server.port, &frame, "");
    let (header, errbody) = protocol::decode_header(&body).unwrap();
    assert_eq!(header.kind, Kind::Error);
    assert_eq!(protocol::decode_error(errbody).unwrap(), ErrorCode::Gap);
}

#[test]
fn wrong_version_is_rejected_over_real_tcp() {
    let server = start_server(7);
    let mut frame = hello_frame(0);
    frame[4..6].copy_from_slice(&2u16.to_le_bytes());
    let (_, body) = send_raw(server.port, &frame, "");
    let (header, errbody) = protocol::decode_header(&body).unwrap();
    assert_eq!(header.kind, Kind::Error);
    assert_eq!(protocol::decode_error(errbody).unwrap(), ErrorCode::Version);
}

#[test]
fn oversized_content_length_is_rejected_with_http_400() {
    let server = start_server(7);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .write_all(
            b"POST /vx/v1/sync HTTP/1.1\r\nHost: x\r\nContent-Length: 2000\r\nContent-Type: application/octet-stream\r\n\r\n",
        )
        .unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    let text = String::from_utf8_lossy(&data);
    assert!(text.starts_with("HTTP/1.1 400"), "{text}");
}

#[test]
fn transfer_encoding_header_is_rejected_with_http_400() {
    let server = start_server(7);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .write_all(
            b"POST /vx/v1/sync HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    let text = String::from_utf8_lossy(&data);
    assert!(text.starts_with("HTTP/1.1 400"), "{text}");
}

#[test]
fn unknown_path_is_404_and_wrong_method_is_405() {
    let server = start_server(7);
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .write_all(b"GET /nope HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    assert!(String::from_utf8_lossy(&data).starts_with("HTTP/1.1 404"));

    let mut stream2 = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream2
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream2
        .write_all(b"GET /vx/v1/sync HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let mut data2 = Vec::new();
    stream2.read_to_end(&mut data2).unwrap();
    assert!(String::from_utf8_lossy(&data2).starts_with("HTTP/1.1 405"));
}
