//! `ProofErrorCode` matches `docs/webgpu-proof-contract.md` section 5 exactly.
//! The string codes are the oracle. Do not rename a variant without a new
//! contract version.

// Some variants are never constructed by this crate: `wasm-load-failed` is
// host-authored before Rust exists, and this candidate does not need a
// `not-running` error path (`request_readback()` returns 0 instead). They
// stay in the enum because the contract defines the full oracle set.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofErrorCode {
    ApiUnavailable,
    InsecureContext,
    AdapterUnavailable,
    DeviceRequestFailed,
    CanvasContextUnavailable,
    ShaderCompilation,
    PipelineCreation,
    ReadbackFailed,
    DeviceLost,
    NotRunning,
    WasmLoadFailed,
    ContractMismatch,
    Internal,
}

impl ProofErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ProofErrorCode::ApiUnavailable => "api-unavailable",
            ProofErrorCode::InsecureContext => "insecure-context",
            ProofErrorCode::AdapterUnavailable => "adapter-unavailable",
            ProofErrorCode::DeviceRequestFailed => "device-request-failed",
            ProofErrorCode::CanvasContextUnavailable => "canvas-context-unavailable",
            ProofErrorCode::ShaderCompilation => "shader-compilation",
            ProofErrorCode::PipelineCreation => "pipeline-creation",
            ProofErrorCode::ReadbackFailed => "readback-failed",
            ProofErrorCode::DeviceLost => "device-lost",
            ProofErrorCode::NotRunning => "not-running",
            ProofErrorCode::WasmLoadFailed => "wasm-load-failed",
            ProofErrorCode::ContractMismatch => "contract-mismatch",
            ProofErrorCode::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProofError {
    pub code: ProofErrorCode,
    pub message: String,
    /// Only set for `device-lost`: `"destroyed"` or `"unknown"`.
    pub reason: Option<&'static str>,
}

impl ProofError {
    pub fn new(code: ProofErrorCode, message: impl Into<String>) -> Self {
        ProofError {
            code,
            message: message.into(),
            reason: None,
        }
    }

    pub fn with_reason(code: ProofErrorCode, message: impl Into<String>, reason: &'static str) -> Self {
        ProofError {
            code,
            message: message.into(),
            reason: Some(reason),
        }
    }
}
