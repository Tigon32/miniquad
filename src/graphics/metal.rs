#![allow(non_snake_case)]

use crate::native::apple::{
    apple_util::{self, msg_send_},
    frameworks::*,
};
use crate::ResourceManager;
use std::convert::TryFrom;

use super::*;

// https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf
const MAX_UNIFORM_BUFFER_SIZE: u64 = 4 * 1024 * 1024;
const NUM_INFLIGHT_FRAMES: usize = 3;
// iOS simulator on Apple Silicon Macs (`target_abi = "sim"`) runs
// iOS arm64 code but issues Metal commands against the host Mac's
// GPU — which validates with the 256-byte rule, not iOS arm64's
// 16-byte. Without breaking the simulator out of the iOS-arm64
// branch below, the first draw fails Metal validation on
// uniform-buffer offset alignment.
#[cfg(any(
    target_os = "macos",
    all(
        any(target_os = "ios", target_os = "tvos"),
        any(target_arch = "x86_64", target_abi = "sim"),
    ),
))]
const UNIFORM_BUFFER_ALIGN: u64 = 256;
#[cfg(all(
    any(target_os = "ios", target_os = "tvos"),
    target_arch = "aarch64",
    not(target_abi = "sim"),
))]
const UNIFORM_BUFFER_ALIGN: u64 = 16;

impl From<VertexFormat> for MTLVertexFormat {
    fn from(vf: VertexFormat) -> Self {
        match vf {
            VertexFormat::Float1 => MTLVertexFormat::Float,
            VertexFormat::Float2 => MTLVertexFormat::Float2,
            VertexFormat::Float3 => MTLVertexFormat::Float3,
            VertexFormat::Float4 => MTLVertexFormat::Float4,
            VertexFormat::Byte1 => MTLVertexFormat::UChar,
            VertexFormat::Byte2 => MTLVertexFormat::UChar2,
            VertexFormat::Byte3 => MTLVertexFormat::UChar3,
            VertexFormat::Byte4 => MTLVertexFormat::UChar4,
            VertexFormat::Short1 => MTLVertexFormat::Short,
            VertexFormat::Short2 => MTLVertexFormat::Short2,
            VertexFormat::Short3 => MTLVertexFormat::Short3,
            VertexFormat::Short4 => MTLVertexFormat::Short4,
            VertexFormat::Int1 => MTLVertexFormat::Int,
            VertexFormat::Int2 => MTLVertexFormat::Int2,
            VertexFormat::Int3 => MTLVertexFormat::Int3,
            VertexFormat::Int4 => MTLVertexFormat::Int4,
            VertexFormat::Mat4 => MTLVertexFormat::Float4,
        }
    }
}

impl From<UniformType> for MTLVertexFormat {
    fn from(ut: UniformType) -> Self {
        match ut {
            UniformType::Float1 => MTLVertexFormat::Float,
            UniformType::Float2 => MTLVertexFormat::Float2,
            UniformType::Float3 => MTLVertexFormat::Float3,
            UniformType::Float4 => MTLVertexFormat::Float4,
            UniformType::Int1 => MTLVertexFormat::Int,
            UniformType::Int2 => MTLVertexFormat::Int2,
            UniformType::Int3 => MTLVertexFormat::Int3,
            UniformType::Int4 => MTLVertexFormat::Int4,
            UniformType::Mat4 => MTLVertexFormat::Float4,
        }
    }
}

impl From<Comparison> for MTLCompareFunction {
    fn from(cmp: Comparison) -> Self {
        match cmp {
            Comparison::Never => MTLCompareFunction::Never,
            Comparison::Less => MTLCompareFunction::Less,
            Comparison::LessOrEqual => MTLCompareFunction::LessEqual,
            Comparison::Greater => MTLCompareFunction::Greater,
            Comparison::GreaterOrEqual => MTLCompareFunction::GreaterEqual,
            Comparison::Equal => MTLCompareFunction::Equal,
            Comparison::NotEqual => MTLCompareFunction::NotEqual,
            Comparison::Always => MTLCompareFunction::Always,
        }
    }
}

impl From<BlendFactor> for MTLBlendFactor {
    fn from(factor: BlendFactor) -> Self {
        match factor {
            BlendFactor::Zero => MTLBlendFactor::Zero,
            BlendFactor::One => MTLBlendFactor::One,
            BlendFactor::Value(BlendValue::SourceColor) => MTLBlendFactor::SourceColor,
            BlendFactor::Value(BlendValue::SourceAlpha) => MTLBlendFactor::SourceAlpha,
            BlendFactor::Value(BlendValue::DestinationColor) => MTLBlendFactor::DestinationColor,
            BlendFactor::Value(BlendValue::DestinationAlpha) => MTLBlendFactor::DestinationAlpha,
            BlendFactor::OneMinusValue(BlendValue::SourceColor) => {
                MTLBlendFactor::OneMinusSourceColor
            }
            BlendFactor::OneMinusValue(BlendValue::SourceAlpha) => {
                MTLBlendFactor::OneMinusSourceAlpha
            }
            BlendFactor::OneMinusValue(BlendValue::DestinationColor) => {
                MTLBlendFactor::OneMinusDestinationColor
            }
            BlendFactor::OneMinusValue(BlendValue::DestinationAlpha) => {
                MTLBlendFactor::OneMinusDestinationAlpha
            }
            BlendFactor::SourceAlphaSaturate => MTLBlendFactor::SourceAlphaSaturated,
        }
    }
}

// impl From<StencilOp> for MTLStencilOperation {
//     fn from(op: StencilOp) -> Self {
//         match op {
//             StencilOp::Keep => MTLStencilOperation::Keep,
//             StencilOp::Zero => MTLStencilOperation::Zero,
//             StencilOp::Replace => MTLStencilOperation::Replace,
//             StencilOp::IncrementClamp => MTLStencilOperation::IncrementClamp,
//             StencilOp::DecrementClamp => MTLStencilOperation::DecrementClamp,
//             StencilOp::Invert => MTLStencilOperation::Invert,
//             StencilOp::IncrementWrap => MTLStencilOperation::IncrementWrap,
//             StencilOp::DecrementWrap => MTLStencilOperation::DecrementWrap,
//         }
//     }
// }

impl From<Equation> for MTLBlendOperation {
    fn from(cf: Equation) -> Self {
        match cf {
            Equation::Add => MTLBlendOperation::Add,
            Equation::Subtract => MTLBlendOperation::Subtract,
            Equation::ReverseSubtract => MTLBlendOperation::ReverseSubtract,
        }
    }
}

impl From<CompareFunc> for MTLCompareFunction {
    fn from(cf: CompareFunc) -> Self {
        match cf {
            CompareFunc::Always => MTLCompareFunction::Always,
            CompareFunc::Never => MTLCompareFunction::Never,
            CompareFunc::Less => MTLCompareFunction::Less,
            CompareFunc::Equal => MTLCompareFunction::Equal,
            CompareFunc::LessOrEqual => MTLCompareFunction::LessEqual,
            CompareFunc::Greater => MTLCompareFunction::Greater,
            CompareFunc::NotEqual => MTLCompareFunction::NotEqual,
            CompareFunc::GreaterOrEqual => MTLCompareFunction::GreaterEqual,
        }
    }
}

impl From<VertexStep> for MTLVertexStepFunction {
    fn from(vs: VertexStep) -> Self {
        match vs {
            VertexStep::PerVertex => MTLVertexStepFunction::PerVertex,
            VertexStep::PerInstance => MTLVertexStepFunction::PerInstance,
        }
    }
}

impl From<PrimitiveType> for MTLPrimitiveType {
    fn from(primitive_type: PrimitiveType) -> Self {
        match primitive_type {
            PrimitiveType::Triangles => MTLPrimitiveType::Triangle,
            PrimitiveType::Lines => MTLPrimitiveType::Line,
            PrimitiveType::Points => MTLPrimitiveType::Point,
        }
    }
}

impl From<TextureFormat> for MTLPixelFormat {
    fn from(format: TextureFormat) -> Self {
        match format {
            // Metal has no 24-bit-per-pixel texture format. RGB8
            // storage uses RGBA8Unorm instead; `rgb8_to_rgba8` /
            // `rgba8_to_rgb8` convert at the upload / read-back
            // boundary so the public byte contract (3 bytes/pixel,
            // see `TextureFormat::size`) stays exact.
            TextureFormat::RGB8 => MTLPixelFormat::RGBA8Unorm,
            TextureFormat::RGBA8 => MTLPixelFormat::RGBA8Unorm,
            // Equal to the macOS view depthStencilPixelFormat; pipelines copy that format.
            TextureFormat::Depth => MTLPixelFormat::Depth32Float_Stencil8,
            TextureFormat::Depth32 => MTLPixelFormat::Depth32Float,
            TextureFormat::RGBA16F => MTLPixelFormat::RGBA16Float,
            TextureFormat::Alpha => MTLPixelFormat::A8Unorm,
        }
    }
}

/// Bytes-per-pixel of the Metal storage format actually allocated
/// for `format`. This matches `TextureFormat::size`'s public
/// per-pixel byte count for every format except `RGB8`, where Metal
/// has no native 24-bit format and the texture is allocated as
/// `RGBA8Unorm` (4 bytes/pixel) instead; callers still see the
/// documented 3-byte-per-pixel contract via conversion at the
/// upload/read-back boundary.
///
/// `TextureFormat::Depth` is not covered: its combined
/// `Depth32Float_Stencil8` storage is render-target-only and is not
/// addressable with `replaceRegion`/`getBytes` in a way that matches
/// `TextureFormat::size`'s 2-bytes-per-pixel contract. CPU upload or
/// read-back of that format stays a documented unsupported state;
/// see `new_texture`, `texture_resize`, and `texture_read_pixels`.
fn mtl_storage_bytes_per_pixel(format: TextureFormat) -> u32 {
    match format {
        TextureFormat::RGB8 => 4,
        TextureFormat::RGBA8 => 4,
        TextureFormat::RGBA16F => 8,
        TextureFormat::Alpha => 1,
        TextureFormat::Depth32 => 4,
        TextureFormat::Depth => 5,
    }
}

/// Expands tightly-packed RGB8 (3 bytes/pixel) into RGBA8 (4
/// bytes/pixel, alpha opaque) for Metal's RGBA8Unorm-backed RGB8
/// storage.
fn rgb8_to_rgba8(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 3 * 4);
    for pixel in src.chunks_exact(3) {
        out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
    }
    out
}

/// Drops the alpha channel from RGBA8 (4 bytes/pixel) to produce
/// RGB8 (3 bytes/pixel), the inverse of `rgb8_to_rgba8`.
fn rgba8_to_rgb8(src: &[u8], dst: &mut [u8]) {
    assert_eq!(src.len() / 4 * 3, dst.len(), "rgba8_to_rgb8: size mismatch");
    for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)) {
        d.copy_from_slice(&s[..3]);
    }
}

/// Converts `bytes` (in `format`'s public per-pixel layout) into the byte buffer Metal's
/// storage format for `format` expects. Borrows `bytes` unchanged for every format except
/// `RGB8`, which needs the RGBA8 conversion described on `mtl_storage_bytes_per_pixel`.
fn prepare_upload_bytes(format: TextureFormat, bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    match format {
        TextureFormat::RGB8 => std::borrow::Cow::Owned(rgb8_to_rgba8(bytes)),
        _ => std::borrow::Cow::Borrowed(bytes),
    }
}

// impl From<CullFace> for MTLCullMode {
//     fn from(cull_face: CullFace) -> Self {
//         match cull_face {
//             CullFace::Back => MTLCullMode::Back,
//             CullFace::Front => MTLCullMode::Front,
//             CullFace::Nothing => MTLCullMode::None,
//         }
//     }
// }

// impl From<FrontFaceOrder> for MTLWinding {
//     fn from(order: FrontFaceOrder) -> Self {
//         match order {
//             FrontFaceOrder::Clockwise => MTLWinding::Clockwise,
//             FrontFaceOrder::CounterClockwise => MTLWinding::CounterClockwise,
//         }
//     }
// }

#[inline]
fn roundup_ub_buffer(current_buffer: u64) -> u64 {
    ((current_buffer) + ((UNIFORM_BUFFER_ALIGN) - 1)) & !((UNIFORM_BUFFER_ALIGN) - 1)
}

// Per-buffer rotation pool for the within-frame update-draw-update-draw
// pattern. Metal's `update` doesn't synchronously claim ownership, so
// each within-frame update needs its own backing `MTLBuffer` to keep
// the previous update's data alive until the draw consumes it. `raw`
// grows on demand, so memory tracks actual per-frame usage rather
// than a fixed worst-case ceiling.
#[derive(Clone, Debug)]
pub struct Buffer {
    raw: Vec<ObjcId>,
    //buffer_type: BufferType,
    size: usize,
    /// Cached `MTLResourceOptions` for grow-on-demand allocations.
    options: u64,
    /// Set for index buffers from the source element size; `draw`
    /// uses it to pick `MTLIndexType` and the index byte offset.
    index_type: Option<MTLIndexType>,
    value: usize,
    next_value: usize,
}

#[derive(Debug)]
struct ShaderInternal {
    vertex_function: ObjcId,
    fragment_function: ObjcId,
    //uniforms: Vec<ShaderUniform>,
    // the distance, in bytes, between two uniforms in uniforms buffer
    //stride: u64,
}

struct RenderPassInternal {
    render_pass_desc: ObjcId,
    texture: Vec<TextureId>,
    _depth_texture: Option<TextureId>,
}

#[derive(Clone, Debug)]
struct PipelineInternal {
    pipeline_state: ObjcId,
    depth_stencil_state: ObjcId,
    //layout: Vec<BufferLayout>,
    //attributes: Vec<VertexAttributeInternal>,
    _shader: ShaderId,
    primitive_type: MTLPrimitiveType,
}

#[derive(Clone, Copy)]
struct Texture {
    texture: ObjcId,
    sampler: ObjcId,
    sampler_descriptor: ObjcId,
    params: TextureParams,
    /// `TextureAccess` at creation time. Needed by `texture_resize` to rebuild a managed
    /// texture with the same storage mode/usage/pixel-format handling as `new_texture`; a raw
    /// texture (see `Textures::synthesize_raw_entry`) always reports `Static` since it is never
    /// resized by miniquad.
    access: TextureAccess,
    // A tombstone prevents messages to released Objective-C objects.
    freed: bool,
}

impl Texture {
    fn update_sampler(&mut self, device: ObjcId) {
        unsafe {
            let sampler =
                msg_send_![device, newSamplerStateWithDescriptor: self.sampler_descriptor];
            assert!(!sampler.is_null(), "Metal: sampler creation failed");
            let previous = std::mem::replace(&mut self.sampler, sampler);
            msg_send_![previous, release];
        }
    }
}

/// Best-effort reverse of `From<TextureFormat> for MTLPixelFormat`, used only to describe a
/// caller-owned raw texture (see `Textures::synthesize_raw_entry`). A caller's `MTLTexture` may
/// use a pixel format miniquad never produces (for example `BGRA8Unorm`, the default view
/// color format); such formats fall back to `RGBA8` so the stored byte size stays a safe 4
/// bytes/pixel, even if the channel order miniquad assumes does not match the real layout.
impl TryFrom<MTLPixelFormat> for TextureFormat {
    type Error = ();
    fn try_from(format: MTLPixelFormat) -> Result<Self, ()> {
        match format {
            MTLPixelFormat::RGBA8Unorm => Ok(TextureFormat::RGBA8),
            MTLPixelFormat::RGBA16Float => Ok(TextureFormat::RGBA16F),
            MTLPixelFormat::A8Unorm => Ok(TextureFormat::Alpha),
            MTLPixelFormat::Depth32Float => Ok(TextureFormat::Depth32),
            MTLPixelFormat::Depth32Float_Stencil8 => Ok(TextureFormat::Depth),
            _ => Err(()),
        }
    }
}

struct Textures {
    managed: Vec<Texture>,
    /// Lazily synthesized entries for externally-owned Metal textures wrapped through
    /// `TextureId::from_raw_id(RawId::Metal(..))`, keyed by the caller's texture pointer.
    /// `RefCell` lets read-only `RenderingBackend` methods (`texture_params`,
    /// `texture_raw_id`) populate the cache on first use without `&mut self`.
    ///
    /// Ownership contract (see docs/adr/0021-metal-texture-format-and-raw-texture-contract.md): miniquad creates
    /// and owns the sampler/sampler_descriptor in each entry; it never retains or releases the
    /// caller's `texture` object. `delete_texture` on a raw id releases only the synthesized
    /// sampler/descriptor and stops tracking the entry.
    raw: std::cell::RefCell<std::collections::HashMap<usize, Texture>>,
    device: ObjcId,
}

impl Textures {
    fn new(device: ObjcId) -> Textures {
        Textures {
            managed: Vec::new(),
            raw: std::cell::RefCell::new(std::collections::HashMap::new()),
            device,
        }
    }

    fn push_managed(&mut self, texture: Texture) -> TextureId {
        self.managed.push(texture);
        TextureId(TextureIdInner::Managed(self.managed.len() - 1))
    }

    /// Reads real metadata (dimensions, pixel format, mipmap count) off the caller's
    /// `MTLTexture` and builds a fresh sampler from `TextureParams::default()` filters, since a
    /// caller-provided texture never arrives with a miniquad sampler.
    unsafe fn synthesize_raw_entry(device: ObjcId, texture: ObjcId) -> Texture {
        let width: u64 = msg_send![texture, width];
        let height: u64 = msg_send![texture, height];
        let mipmap_level_count: u64 = msg_send![texture, mipmapLevelCount];
        let pixel_format: MTLPixelFormat = msg_send![texture, pixelFormat];
        let format = TextureFormat::try_from(pixel_format).unwrap_or(TextureFormat::RGBA8);

        let params = TextureParams {
            format,
            width: width as u32,
            height: height as u32,
            allocate_mipmaps: mipmap_level_count > 1,
            ..TextureParams::default()
        };

        let sampler_descriptor = msg_send_![class!(MTLSamplerDescriptor), new];
        assert!(
            !sampler_descriptor.is_null(),
            "Metal: sampler descriptor creation failed"
        );
        msg_send_![sampler_descriptor, setMinFilter: MTLSamplerMinMagFilter::Linear];
        msg_send_![sampler_descriptor, setMagFilter: MTLSamplerMinMagFilter::Linear];
        msg_send_![sampler_descriptor, setMipFilter: MTLSamplerMipFilter::NotMipmapped];
        let sampler = msg_send_![device, newSamplerStateWithDescriptor: sampler_descriptor];
        assert!(!sampler.is_null(), "Metal: sampler creation failed");

        Texture {
            texture,
            sampler,
            sampler_descriptor,
            params,
            access: TextureAccess::Static,
            freed: false,
        }
    }

    fn ensure_raw(&self, ptr: ObjcId) {
        let key = ptr as usize;
        if self.raw.borrow().contains_key(&key) {
            return;
        }
        let entry = unsafe { Self::synthesize_raw_entry(self.device, ptr) };
        self.raw.borrow_mut().insert(key, entry);
    }

    fn resolve(&self, texture: TextureId) -> Texture {
        match texture.0 {
            TextureIdInner::Raw(RawId::Metal(ptr)) => {
                assert!(!ptr.is_null(), "Metal: from_raw_id given a null texture");
                self.ensure_raw(ptr);
                self.raw.borrow()[&(ptr as usize)]
            }
            TextureIdInner::Raw(RawId::OpenGl(_)) => panic!("Gl texture in Metal context!"),
            TextureIdInner::Managed(texture) => self.managed[texture],
        }
    }

    fn get(&self, texture: TextureId) -> Texture {
        let resolved = self.resolve(texture);
        assert!(!resolved.freed, "Metal: texture used after delete_texture");
        resolved
    }

    fn get_mut(&mut self, texture: TextureId) -> &mut Texture {
        match texture.0 {
            TextureIdInner::Raw(RawId::Metal(ptr)) => {
                assert!(!ptr.is_null(), "Metal: from_raw_id given a null texture");
                self.ensure_raw(ptr);
                let entry = self.raw.get_mut().get_mut(&(ptr as usize)).unwrap();
                assert!(!entry.freed, "Metal: texture used after delete_texture");
                entry
            }
            TextureIdInner::Raw(RawId::OpenGl(_)) => panic!("Gl texture in Metal context!"),
            TextureIdInner::Managed(texture) => {
                let entry = &mut self.managed[texture];
                assert!(!entry.freed, "Metal: texture used after delete_texture");
                entry
            }
        }
    }

    fn delete(&mut self, texture: TextureId) {
        match texture.0 {
            TextureIdInner::Raw(RawId::Metal(ptr)) => {
                let key = ptr as usize;
                let entry = self.raw.get_mut().get_mut(&key).expect(
                    "Metal: delete_texture on a raw texture TextureId that was never used \
                     (nothing to delete; call a binding/read/param method on it first)",
                );
                assert!(
                    !entry.freed,
                    "Metal: double delete_texture (already deleted)"
                );
                unsafe {
                    // The caller owns `texture`; miniquad owns only the sampler and
                    // descriptor it synthesized, so only those are released here.
                    msg_send_![entry.sampler, release];
                    msg_send_![entry.sampler_descriptor, release];
                }
                entry.freed = true;
            }
            TextureIdInner::Raw(RawId::OpenGl(_)) => panic!("Gl texture in Metal context!"),
            TextureIdInner::Managed(index) => {
                let entry = &mut self.managed[index];
                assert!(
                    !entry.freed,
                    "Metal: double delete_texture (already deleted)"
                );
                unsafe {
                    msg_send_![entry.texture, release];
                    msg_send_![entry.sampler, release];
                    msg_send_![entry.sampler_descriptor, release];
                }
                entry.freed = true;
            }
        }
    }
}
pub struct MetalContext {
    buffers: ResourceManager<Buffer>,
    shaders: ResourceManager<ShaderInternal>,
    pipelines: ResourceManager<PipelineInternal>,
    textures: Textures,
    passes: ResourceManager<RenderPassInternal>,
    command_queue: ObjcId,
    command_buffer: Option<ObjcId>,
    render_encoder: Option<ObjcId>,
    /// Active pass's color-attachment dimensions in pixels — pivot
    /// for `apply_scissor_rect`'s Y-flip + clamp.
    current_pass_width: u32,
    current_pass_height: u32,
    // Bookkeeping for the deferred-end pass-merge in `begin_pass`
    // / `end_render_pass`.
    current_pass_target: Option<Option<RenderPass>>,
    pending_end_encoder: bool,
    view: ObjcId,
    device: ObjcId,
    current_frame_index: usize,
    uniform_buffers: [ObjcId; 3],
    // cached index_buffer from apply_bindings
    index_buffer: Option<ObjcId>,
    // cached index element type from apply_bindings, for `draw`
    index_type: MTLIndexType,
    // cached pipeline from apply_pipeline
    current_pipeline: Option<Pipeline>,
    current_ub_offset: u64,
}

impl Default for MetalContext {
    fn default() -> Self {
        Self::new()
    }
}

impl MetalContext {
    /// Builds a fresh `MTLTexture` (no sampler) per `access`/`params`. Shared by `new_texture`
    /// (initial allocation) and `texture_resize` (reallocation on a dimension change) so both
    /// paths stay in lock-step for pixel format, storage mode, and usage flags.
    unsafe fn new_mtl_texture(&self, access: TextureAccess, params: TextureParams) -> ObjcId {
        let descriptor = msg_send_![class!(MTLTextureDescriptor),
                   texture2DDescriptorWithPixelFormat:MTLPixelFormat::from(params.format)
                   width: params.width as u64
                   height: params.height as u64
                   mipmapped: params.allocate_mipmaps as BOOL];
        // This convenience constructor returns an autoreleased descriptor.
        assert!(
            !descriptor.is_null(),
            "Metal: texture descriptor creation failed"
        );

        msg_send_![descriptor, setCpuCacheMode: MTLCPUCacheMode::DefaultCache];

        if access == TextureAccess::RenderTarget {
            // `Depth` and `Depth32` are depth attachment formats — keep their own
            // pixel format. Every other format is a color attachment: match the
            // view's `colorPixelFormat` — pipelines bake it and reject mismatched
            // attachments, and MTKView's presentable formats are all `BGRA*` /
            // `RGBA16Float` so honoring `RGBA8` literally would break every
            // offscreen color target.
            if params.format != TextureFormat::Depth && params.format != TextureFormat::Depth32 {
                let view_pixel_format: MTLPixelFormat = msg_send![self.view, colorPixelFormat];
                msg_send_![descriptor, setPixelFormat: view_pixel_format];
            }
            msg_send_![descriptor, setStorageMode: MTLStorageMode::Private];
            if params.sample_count > 1 {
                // MSAA target — render-only, no mipmaps, no
                // shader-sample (the resolve texture is sampled
                // instead).
                msg_send_![
                    descriptor,
                    setTextureType: MTLTextureType::D2Multisample
                ];
                msg_send_![descriptor, setSampleCount: params.sample_count as u64];
                msg_send_![descriptor, setMipmapLevelCount: 1u64];
                msg_send_![
                    descriptor,
                    setUsage: MTLTextureUsage::RenderTarget as u64
                ];
            } else {
                msg_send_![
                    descriptor,
                    setUsage: MTLTextureUsage::RenderTarget as u64
                        | MTLTextureUsage::ShaderRead as u64
                        | MTLTextureUsage::ShaderWrite as u64
                ];
            }
        } else {
            #[cfg(target_os = "macos")]
            {
                msg_send_![descriptor, setUsage: MTLTextureUsage::ShaderRead];
                msg_send_![descriptor, setStorageMode: MTLStorageMode::Managed];
                msg_send_![
                    descriptor,
                    setResourceOptions: MTLResourceOptions::StorageModeManaged
                ];
            }
            #[cfg(any(target_os = "ios", target_os = "tvos"))]
            {
                msg_send_![descriptor, setStorageMode: MTLStorageMode::Shared];
                msg_send_![
                    descriptor,
                    setResourceOptions: MTLResourceOptions::StorageModeShared
                ];
            }
        }

        match params.kind {
            TextureKind::Texture2D => {
                // on metal textureType2D is the default, nothing to do here
            }
            TextureKind::CubeMap => {
                msg_send_![descriptor, setTextureType: MTLTextureType::CubeArray];
            }
        }

        let raw_texture = msg_send_![self.device, newTextureWithDescriptor: descriptor];
        assert!(!raw_texture.is_null(), "Metal: texture creation failed");
        raw_texture
    }
    pub fn new() -> MetalContext {
        unsafe {
            let view = crate::window::apple_view();
            assert!(!view.is_null());
            let device: ObjcId = msg_send![view, device];
            assert!(!device.is_null());
            let command_queue: ObjcId = msg_send![device, newCommandQueue];

            if false {
                let capture_manager = msg_send_![class![MTLCaptureManager], sharedCaptureManager];
                assert!(!capture_manager.is_null());

                let MTLCaptureDestinationGPUTraceDocument = 2u64;
                if !msg_send![
                    capture_manager,
                    supportsDestination: MTLCaptureDestinationGPUTraceDocument
                ] {
                    // put this into Info.plist near the binary (in target/debug/whatever/whatever, not in the working directory)
                    /*
                    <?xml version="1.0" encoding="UTF-8"?>
                    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
                    <plist version="1.0">
                    <dict>
                        <key>MetalCaptureEnabled</key>
                        <true/>
                    </dict>
                    </plist>
                    */
                    panic!("capture failed (probably missing Info.plist, read the comment near this panic)");
                }

                let capture_descriptor =
                    msg_send_![msg_send_![class![MTLCaptureDescriptor], alloc], init];
                msg_send_![capture_descriptor, setCaptureObject: device];
                msg_send_![
                    capture_descriptor,
                    setDestination: MTLCaptureDestinationGPUTraceDocument
                ];
                let path = apple_util::str_to_nsstring("/Users/fedor/wtf1.gputrace");
                let url = msg_send_![class!(NSURL), fileURLWithPath: path];
                msg_send_![capture_descriptor, setOutputURL: url];

                let mut error: ObjcId = nil;
                if !msg_send![capture_manager, startCaptureWithDescriptor:capture_descriptor
                              error:&mut error]
                {
                    let description: ObjcId = msg_send![error, localizedDescription];
                    let string = apple_util::nsstring_to_string(description);
                    panic!("Capture error: {}", string);
                }
            }

            #[cfg(target_os = "macos")]
            let options = {
                MTLResourceOptions::CPUCacheModeWriteCombined
                    | MTLResourceOptions::StorageModeManaged
            };
            #[cfg(any(target_os = "ios", target_os = "tvos"))]
            let options = { MTLResourceOptions::CPUCacheModeWriteCombined };

            let uniform_buffers = [
                msg_send![device, newBufferWithLength:MAX_UNIFORM_BUFFER_SIZE
                          options:options],
                msg_send![device, newBufferWithLength:MAX_UNIFORM_BUFFER_SIZE
                          options:options],
                msg_send![device, newBufferWithLength:MAX_UNIFORM_BUFFER_SIZE
                          options:options],
            ];

            MetalContext {
                command_queue,
                command_buffer: None,
                render_encoder: None,
                current_pass_width: 0,
                current_pass_height: 0,
                current_pass_target: None,
                pending_end_encoder: false,
                view,
                device,
                buffers: ResourceManager::default(),
                shaders: ResourceManager::default(),
                pipelines: ResourceManager::default(),
                textures: Textures::new(device),
                passes: ResourceManager::default(),
                index_buffer: None,
                index_type: MTLIndexType::UInt16,
                current_pipeline: None,
                uniform_buffers,
                current_frame_index: 1,
                current_ub_offset: 0,
            }
        }
    }

    /// Actually call `endEncoding` and clear deferred-end state.
    /// `end_render_pass` defers this so consecutive same-target
    /// begin/end pairs can collapse into one Metal pass.
    fn really_end_encoder(&mut self) {
        if let Some(render_encoder) = self.render_encoder.take() {
            unsafe { msg_send_!(render_encoder, endEncoding) };
        }
        self.current_pass_target = None;
        self.pending_end_encoder = false;
    }

    fn buffer(&self, buffer: BufferId) -> &Buffer {
        &self.buffers[buffer.0]
    }

    fn buffer_mut(&mut self, buffer: BufferId) -> &mut Buffer {
        &mut self.buffers[buffer.0]
    }

    fn shader(&self, shader: ShaderId) -> &ShaderInternal {
        &self.shaders[shader.0]
    }

    fn pipeline(&self, pipeline: Pipeline) -> &PipelineInternal {
        &self.pipelines[pipeline.0]
    }

    fn pass(&self, render_pass: RenderPass) -> &RenderPassInternal {
        &self.passes[render_pass.0]
    }
}

#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
mod tests {
    use super::*;
    use objc::rc::{autoreleasepool, WeakPtr};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::OnceLock;

    const PROGRAM: &str = r#"
            #include <metal_stdlib>
            using namespace metal;
            vertex float4 vertexShader(uint id [[vertex_id]]) {
                return float4(float(id == 1), float(id == 2), 0.0, 1.0);
            }
            fragment float4 fragmentShader() { return float4(1.0); }
        "#;

    struct Harness {
        context: MetalContext,
        _queue: RcObjcId,
        _view: RcObjcId,
        _device: RcObjcId,
    }

    // A panicking test can leave a real `MTLRenderCommandEncoder`
    // without `endEncoding`; Metal validates that at the encoder's
    // dealloc and aborts the whole process, not just the test. End
    // it here so a caught panic reports as a normal test failure.
    impl Drop for Harness {
        fn drop(&mut self) {
            self.context.really_end_encoder();
        }
    }

    extern "C" fn color_format(_: &Object, _: Sel) -> u64 {
        MTLPixelFormat::BGRA8Unorm as u64
    }

    extern "C" fn depth_format(_: &Object, _: Sel) -> u64 {
        MTLPixelFormat::Invalid as u64
    }

    extern "C" fn sample_count(_: &Object, _: Sel) -> u64 {
        1
    }

    extern "C" fn ignore_draw(
        _: &Object,
        _: Sel,
        _: u64,
        _: u64,
        _: u64,
        _: ObjcId,
        _: u64,
        _: u64,
        _: i64,
        _: u64,
    ) {
    }

    extern "C" fn ignore_end(_: &Object, _: Sel) {}

    fn owned(pointer: ObjcId) -> RcObjcId {
        RcObjcId::from_owned(
            NonNull::new(pointer).expect("Metal test needs a real device and resources"),
        )
    }

    // Replace only view metadata. Resource calls use the real Metal device.
    fn harness() -> Harness {
        static VIEW_CLASS: OnceLock<&'static Class> = OnceLock::new();
        let view_class = VIEW_CLASS.get_or_init(|| {
                let mut declaration =
                    ClassDecl::new("MQMetalResourceTestView", class!(NSObject)).unwrap();
                unsafe {
                    declaration.add_method(sel!(colorPixelFormat), color_format as extern "C" fn(&Object, Sel) -> u64);
                    declaration.add_method(sel!(depthStencilPixelFormat), depth_format as extern "C" fn(&Object, Sel) -> u64);
                    declaration.add_method(sel!(sampleCount), sample_count as extern "C" fn(&Object, Sel) -> u64);
                    declaration.add_method(sel!(endEncoding), ignore_end as extern "C" fn(&Object, Sel));
                    declaration.add_method(
                        sel!(drawIndexedPrimitives:indexCount:indexType:indexBuffer:indexBufferOffset:instanceCount:baseVertex:baseInstance:),
                        ignore_draw as extern "C" fn(&Object, Sel, u64, u64, u64, ObjcId, u64, u64, i64, u64),
                    );
                }
                declaration.register()
            });
        unsafe {
            let device = owned(MTLCreateSystemDefaultDevice());
            let view = owned(msg_send![*view_class, new]);
            let queue = owned(msg_send![device.as_id(), newCommandQueue]);
            Harness {
                context: MetalContext {
                    buffers: Default::default(),
                    shaders: Default::default(),
                    pipelines: Default::default(),
                    textures: Textures::new(device.as_id()),
                    passes: Default::default(),
                    command_queue: queue.as_id(),
                    command_buffer: None,
                    render_encoder: None,
                    current_pass_width: 0,
                    current_pass_height: 0,
                    current_pass_target: None,
                    pending_end_encoder: false,
                    view: view.as_id(),
                    device: device.as_id(),
                    current_frame_index: 1,
                    uniform_buffers: [nil; 3],
                    index_buffer: None,
                    index_type: MTLIndexType::UInt16,
                    current_pipeline: None,
                    current_ub_offset: 0,
                },
                _queue: queue,
                _view: view,
                _device: device,
            }
        }
    }

    fn shader_meta() -> ShaderMeta {
        ShaderMeta {
            images: Vec::new(),
            uniforms: UniformBlockLayout {
                uniforms: Vec::new(),
            },
        }
    }

    fn reference_state(pointer: &WeakPtr) -> (usize, Option<u64>) {
        let object = pointer.load();
        if object.is_null() {
            (0, None)
        } else {
            let count = unsafe { msg_send![*object, retainCount] };
            (*object as usize, Some(count))
        }
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn resource_loop_releases_objects_after_each_pool_drains() {
        let mut harness = harness();
        let context = &mut harness.context;
        // Compare Metal's cached default depth state with a direct-API control.
        let cached_depth = autoreleasepool(|| unsafe {
            let descriptor = owned(msg_send![class!(MTLDepthStencilDescriptor), new]);
            msg_send_![descriptor.as_id(), setDepthWriteEnabled: NO];
            msg_send_![descriptor.as_id(), setDepthCompareFunction: MTLCompareFunction::Always];
            let state = owned(
                msg_send![context.device, newDepthStencilStateWithDescriptor: descriptor.as_id()],
            );
            WeakPtr::new(state.as_id())
        });
        let cache_before = reference_state(&cached_depth);
        let mut observed = Vec::new();
        for _ in 0..8 {
            autoreleasepool(|| unsafe {
                let buffer = context.new_buffer(
                    BufferType::IndexBuffer,
                    BufferUsage::Immutable,
                    BufferSource::slice(&[0_u16, 1, 2]),
                );
                let shader = context
                    .new_shader(ShaderSource::Msl { program: PROGRAM }, shader_meta())
                    .unwrap();
                let pipeline = context.new_pipeline(&[], &[], shader, PipelineParams::default());
                let texture = context.new_texture(
                    TextureAccess::Static,
                    TextureSource::Empty,
                    TextureParams {
                        width: 2,
                        height: 2,
                        ..TextureParams::default()
                    },
                );
                let pass = context.new_render_pass_mrt(&[texture], None, None);
                let internal = context.textures.get(texture);
                for (kind, pointer) in [
                    ("buffer", context.buffers[buffer.0].raw[0]),
                    ("vertex function", context.shaders[shader.0].vertex_function),
                    (
                        "fragment function",
                        context.shaders[shader.0].fragment_function,
                    ),
                    ("pipeline", context.pipelines[pipeline.0].pipeline_state),
                    (
                        "depth state",
                        context.pipelines[pipeline.0].depth_stencil_state,
                    ),
                    ("texture", internal.texture),
                    ("sampler descriptor", internal.sampler_descriptor),
                    ("sampler", internal.sampler),
                    ("pass descriptor", context.passes[pass.0].render_pass_desc),
                ] {
                    observed.push((kind, WeakPtr::new(pointer)));
                }
                context.texture_set_min_filter(texture, FilterMode::Linear, MipmapFilterMode::None);
                observed.push((
                    "min sampler",
                    WeakPtr::new(context.textures.get(texture).sampler),
                ));
                context.texture_set_mag_filter(texture, FilterMode::Linear);
                observed.push((
                    "mag sampler",
                    WeakPtr::new(context.textures.get(texture).sampler),
                ));
                context.texture_set_wrap(texture, TextureWrap::Repeat, TextureWrap::Mirror);
                observed.push((
                    "wrap sampler",
                    WeakPtr::new(context.textures.get(texture).sampler),
                ));
                context.delete_render_pass(pass);
                context.delete_pipeline(pipeline);
                context.delete_shader(shader);
                context.delete_texture(texture);
                context.delete_buffer(buffer);
            });
        }
        let alive: Vec<_> = observed
            .iter()
            .filter_map(|(kind, pointer)| {
                let object = pointer.load();
                if object.is_null()
                    || (*kind == "depth state" && *object as usize == cache_before.0)
                {
                    None
                } else {
                    Some((*kind, *object as usize))
                }
            })
            .collect();
        let unique: std::collections::HashSet<_> =
            alive.iter().map(|(_, pointer)| *pointer).collect();
        eprintln!("Metal resource loop: {} weak observations, {} unexpected live references, {} unique unexpected objects; depth cache {:?}",
                observed.len(), alive.len(), unique.len(), cache_before);
        assert_eq!(
            reference_state(&cached_depth),
            cache_before,
            "cached depth-state ownership changed"
        );
        assert!(
            alive.is_empty(),
            "objects still alive after deletion and pool drain: {:?}",
            alive
        );
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn sampler_changes_preserve_previous_settings() {
        autoreleasepool(|| unsafe {
            let mut harness = harness();
            let context = &mut harness.context;
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 2,
                    ..TextureParams::default()
                },
            );
            context.texture_set_min_filter(texture, FilterMode::Linear, MipmapFilterMode::Linear);
            context.texture_set_mag_filter(texture, FilterMode::Linear);
            context.texture_set_wrap(texture, TextureWrap::Repeat, TextureWrap::Mirror);
            let descriptor = context.textures.get(texture).sampler_descriptor;
            let min: u64 = msg_send![descriptor, minFilter];
            let mip: u64 = msg_send![descriptor, mipFilter];
            let mag: u64 = msg_send![descriptor, magFilter];
            let wrap_s: u64 = msg_send![descriptor, sAddressMode];
            let wrap_t: u64 = msg_send![descriptor, tAddressMode];
            context.delete_texture(texture);
            assert_eq!(min, MTLSamplerMinMagFilter::Linear as u64);
            assert_eq!(mip, MTLSamplerMipFilter::Linear as u64);
            assert_eq!(mag, MTLSamplerMinMagFilter::Linear as u64);
            assert_eq!(wrap_s, MTLSamplerAddressMode::Repeat as u64);
            assert_eq!(wrap_t, MTLSamplerAddressMode::MirrorRepeat as u64);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn deleting_a_bound_index_buffer_prevents_draw_and_double_delete() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2]),
            );
            context.render_encoder = Some(context.view);
            context.apply_bindings_from_slice(&[], buffer, &[]);
            context.delete_buffer(buffer);
            assert!(catch_unwind(AssertUnwindSafe(|| context.draw(0, 3, 1))).is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_buffer(buffer))).is_err());
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn draw_rejects_negative_base_element_num_elements_and_num_instances() {
        // Negative values are cast to `u64`; reject them before that
        // wraps into a huge offset/count. Needs `render_harness` (a
        // real encoder), since `apply_pipeline` calls
        // `setRenderPipelineState:`, which the stub view can't answer.
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, None);
            let shader = context
                .new_shader(ShaderSource::Msl { program: PROGRAM }, shader_meta())
                .unwrap();
            let pipeline = context.new_pipeline(&[], &[], shader, PipelineParams::default());
            let buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2]),
            );
            context.begin_pass(Some(pass), PassAction::clear_color(0., 0., 0., 1.));
            context.apply_pipeline(&pipeline);
            context.apply_bindings_from_slice(&[], buffer, &[]);
            assert!(catch_unwind(AssertUnwindSafe(|| context.draw(-1, 3, 1))).is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| context.draw(0, -3, 1))).is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| context.draw(0, 3, -1))).is_err());
            // A valid call on the same (still-open) encoder must still run.
            context.draw(0, 3, 1);
            context.end_render_pass();
            context.really_end_encoder();
            let command_buffer = context.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            context.delete_buffer(buffer);
            context.delete_pipeline(pipeline);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn invalid_shaders_return_errors_instead_of_panicking() {
        autoreleasepool(|| {
            let mut harness = harness();
            let missing_vertex = PROGRAM.replace("vertexShader", "missingVertex");
            let missing_fragment = PROGRAM.replace("fragmentShader", "missingFragment");
            for program in ["not valid MSL", &missing_vertex, &missing_fragment] {
                assert!(harness
                    .context
                    .new_shader(ShaderSource::Msl { program }, shader_meta())
                    .is_err());
            }
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn pass_deletion_rejects_active_use_and_ends_deferred_encoding() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 2,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[texture], None, None);
            context.render_encoder = Some(context.view);
            context.current_pass_target = Some(Some(pass));
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_render_pass(pass))).is_err());
            context.pending_end_encoder = true;
            context.delete_render_pass(pass);
            assert!(context.current_pass_target.is_none());
            assert!(context.render_encoder.is_none());
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_render_pass(pass))).is_err());
            context.delete_texture(texture);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn deleted_shader_and_pipeline_ids_cannot_be_reused_or_deleted_twice() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let shader = context
                .new_shader(ShaderSource::Msl { program: PROGRAM }, shader_meta())
                .unwrap();
            let pipeline = context.new_pipeline(&[], &[], shader, PipelineParams::default());

            context.delete_pipeline(pipeline);
            context.render_encoder = Some(context.view);
            assert!(
                catch_unwind(AssertUnwindSafe(|| { context.apply_pipeline(&pipeline) })).is_err()
            );
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_pipeline(pipeline))).is_err());

            context.delete_shader(shader);
            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.new_pipeline(&[], &[], shader, PipelineParams::default())
            }))
            .is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_shader(shader))).is_err());
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn deleted_texture_id_cannot_be_used_or_deleted_twice() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 2,
                    ..TextureParams::default()
                },
            );

            context.delete_texture(texture);
            assert!(catch_unwind(AssertUnwindSafe(|| context.textures.get(texture))).is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.texture_set_mag_filter(texture, FilterMode::Linear)
            }))
            .is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| context.delete_texture(texture))).is_err());
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn mismatched_texture_bytes_panic_before_any_object_is_published() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let textures_before = context.textures.managed.len();
            let params = TextureParams {
                width: 2,
                height: 2,
                ..TextureParams::default()
            };
            let short_bytes = vec![0_u8; params.format.size(2, 2) as usize - 1];
            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.new_texture(
                    TextureAccess::Static,
                    TextureSource::Bytes(&short_bytes),
                    params,
                )
            }))
            .is_err());
            assert_eq!(
                context.textures.managed.len(),
                textures_before,
                "a rejected texture must not publish a retained sampler/texture slot"
            );
        });
    }

    const LINE_PROGRAM: &str = r#"
            #include <metal_stdlib>
            using namespace metal;
            struct VertexIn { float2 position [[attribute(0)]]; };
            vertex float4 vertexShader(VertexIn in [[stage_in]]) {
                return float4(in.position, 0.0, 1.0);
            }
            fragment float4 fragmentShader() { return float4(1.0, 1.0, 1.0, 1.0); }
        "#;

    // Carries a per-vertex clip-space z so a test can place a
    // full-screen probe triangle at a known depth and read, from the
    // red fragment it writes (or doesn't), whether the depth test
    // passed.
    const DEPTH_PROBE_PROGRAM: &str = r#"
            #include <metal_stdlib>
            using namespace metal;
            struct VertexIn { float3 position [[attribute(0)]]; };
            vertex float4 vertexShader(VertexIn in [[stage_in]]) {
                return float4(in.position, 1.0);
            }
            fragment float4 fragmentShader() { return float4(1.0, 0.0, 0.0, 1.0); }
        "#;

    extern "C" fn render_color_format(_: &Object, _: Sel) -> u64 {
        MTLPixelFormat::RGBA8Unorm as u64
    }

    extern "C" fn render_depth_format(_: &Object, _: Sel) -> u64 {
        MTLPixelFormat::Depth32Float_Stencil8 as u64
    }

    extern "C" fn sample_count_4(_: &Object, _: Sel) -> u64 {
        4
    }

    // A real-rendering view stub: unlike `harness()`'s opaque
    // BGRA8Unorm, this reports a pixel format the test can decode
    // byte-for-byte, and a real depth/stencil format so pipelines
    // match an attached depth texture.
    fn render_harness() -> Harness {
        static VIEW_CLASS: OnceLock<&'static Class> = OnceLock::new();
        let view_class = VIEW_CLASS.get_or_init(|| {
            let mut declaration =
                ClassDecl::new("MQMetalRenderTestView", class!(NSObject)).unwrap();
            unsafe {
                declaration.add_method(
                    sel!(colorPixelFormat),
                    render_color_format as extern "C" fn(&Object, Sel) -> u64,
                );
                declaration.add_method(
                    sel!(depthStencilPixelFormat),
                    render_depth_format as extern "C" fn(&Object, Sel) -> u64,
                );
                declaration.add_method(
                    sel!(sampleCount),
                    sample_count as extern "C" fn(&Object, Sel) -> u64,
                );
            }
            declaration.register()
        });
        unsafe {
            let device = owned(MTLCreateSystemDefaultDevice());
            let view = owned(msg_send![*view_class, new]);
            let queue = owned(msg_send![device.as_id(), newCommandQueue]);
            Harness {
                context: MetalContext {
                    buffers: Default::default(),
                    shaders: Default::default(),
                    pipelines: Default::default(),
                    textures: Textures::new(device.as_id()),
                    passes: Default::default(),
                    command_queue: queue.as_id(),
                    command_buffer: None,
                    render_encoder: None,
                    current_pass_width: 0,
                    current_pass_height: 0,
                    current_pass_target: None,
                    pending_end_encoder: false,
                    view: view.as_id(),
                    device: device.as_id(),
                    current_frame_index: 1,
                    uniform_buffers: [nil; 3],
                    index_buffer: None,
                    index_type: MTLIndexType::UInt16,
                    current_pipeline: None,
                    current_ub_offset: 0,
                },
                _queue: queue,
                _view: view,
                _device: device,
            }
        }
    }

    // `new_pipeline` requires every pipeline's sample count to match
    // `self.view.sampleCount()`, so an MSAA offscreen pass needs a
    // view reporting that same count, not `render_harness`'s 1.
    fn render_harness_msaa() -> Harness {
        static VIEW_CLASS: OnceLock<&'static Class> = OnceLock::new();
        let view_class = VIEW_CLASS.get_or_init(|| {
            let mut declaration =
                ClassDecl::new("MQMetalRenderTestViewMsaa", class!(NSObject)).unwrap();
            unsafe {
                declaration.add_method(
                    sel!(colorPixelFormat),
                    render_color_format as extern "C" fn(&Object, Sel) -> u64,
                );
                declaration.add_method(
                    sel!(depthStencilPixelFormat),
                    render_depth_format as extern "C" fn(&Object, Sel) -> u64,
                );
                declaration.add_method(
                    sel!(sampleCount),
                    sample_count_4 as extern "C" fn(&Object, Sel) -> u64,
                );
            }
            declaration.register()
        });
        unsafe {
            let device = owned(MTLCreateSystemDefaultDevice());
            let view = owned(msg_send![*view_class, new]);
            let queue = owned(msg_send![device.as_id(), newCommandQueue]);
            Harness {
                context: MetalContext {
                    buffers: Default::default(),
                    shaders: Default::default(),
                    pipelines: Default::default(),
                    textures: Textures::new(device.as_id()),
                    passes: Default::default(),
                    command_queue: queue.as_id(),
                    command_buffer: None,
                    render_encoder: None,
                    current_pass_width: 0,
                    current_pass_height: 0,
                    current_pass_target: None,
                    pending_end_encoder: false,
                    view: view.as_id(),
                    device: device.as_id(),
                    current_frame_index: 1,
                    uniform_buffers: [nil; 3],
                    index_buffer: None,
                    index_type: MTLIndexType::UInt16,
                    current_pipeline: None,
                    current_ub_offset: 0,
                },
                _queue: queue,
                _view: view,
                _device: device,
            }
        }
    }

    // Read an `RGBA8Unorm` `RenderTarget` texture's pixels through a
    // blit to a CPU-visible buffer. Production `new_texture`
    // allocates render targets with `StorageModePrivate`, so
    // `getBytes` on the texture itself is unavailable; this mirrors
    // the standard Metal readback path instead.
    fn read_rgba8_texture(
        context: &MetalContext,
        texture: ObjcId,
        width: u64,
        height: u64,
    ) -> Vec<u8> {
        unsafe {
            let bytes_per_row = width * 4;
            let total_bytes = bytes_per_row * height;
            let readback: ObjcId = msg_send![context.device,
                newBufferWithLength: total_bytes
                options: MTLResourceOptions::StorageModeShared];
            assert!(
                !readback.is_null(),
                "Metal: readback buffer creation failed"
            );
            let blit_cmd: ObjcId = msg_send![context.command_queue, commandBuffer];
            let blit_encoder = msg_send_![blit_cmd, blitCommandEncoder];
            msg_send_![blit_encoder, copyFromTexture: texture
                       sourceSlice: 0u64
                       sourceLevel: 0u64
                       sourceOrigin: MTLOrigin { x: 0, y: 0, z: 0 }
                       sourceSize: MTLSize { width, height, depth: 1 }
                       toBuffer: readback
                       destinationOffset: 0u64
                       destinationBytesPerRow: bytes_per_row
                       destinationBytesPerImage: total_bytes];
            msg_send_![blit_encoder, endEncoding];
            msg_send_![blit_cmd, commit];
            msg_send_![blit_cmd, waitUntilCompleted];
            let ptr: *const u8 = msg_send![readback, contents];
            let bytes = std::slice::from_raw_parts(ptr, total_bytes as usize).to_vec();
            msg_send_![readback, release];
            bytes
        }
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn draw_honors_base_element_offset_lines_primitive_and_u32_indices() {
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;

            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 4,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let depth = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 4,
                    height: 1,
                    format: TextureFormat::Depth,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, Some(depth));

            let shader = context
                .new_shader(
                    ShaderSource::Msl {
                        program: LINE_PROGRAM,
                    },
                    shader_meta(),
                )
                .unwrap();
            let pipeline = context.new_pipeline(
                &[BufferLayout::default()],
                &[VertexAttribute::new("position", VertexFormat::Float2)],
                shader,
                PipelineParams {
                    primitive_type: PrimitiveType::Lines,
                    ..Default::default()
                },
            );

            // Vertices 0,1 are an off-screen, zero-length sentinel
            // line. Vertices 2,3 are a full-width horizontal line
            // through the texture's single row. A correct
            // `base_element` of 2 draws indices [2, 3]; an
            // implementation that ignores `base_element` draws
            // indices [0, 1] instead and leaves the texture cleared.
            let vertex_buffer = context.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[10.0_f32, 10.0, 10.0, 10.0, -1.0, 0.0, 1.0, 0.0]),
            );
            let index_buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u32, 1, 2, 3]),
            );

            context.begin_pass(
                Some(pass),
                PassAction::Clear {
                    color: Some((0., 0., 0., 1.)),
                    depth: Some(1.),
                    stencil: None,
                },
            );
            context.apply_pipeline(&pipeline);
            context.apply_bindings_from_slice(&[vertex_buffer], index_buffer, &[]);
            context.draw(2, 2, 1);
            context.end_render_pass();
            context.really_end_encoder();
            let command_buffer = context.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            let color_texture = context.textures.get(color).texture;
            let pixels = read_rgba8_texture(context, color_texture, 4, 1);
            assert_eq!(
                pixels,
                vec![255_u8; 16],
                "a correct base_element draws the real line across every column: {:?}",
                pixels
            );

            context.delete_buffer(vertex_buffer);
            context.delete_buffer(index_buffer);
            context.delete_pipeline(pipeline);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(depth);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn clear_during_an_active_pass_targets_the_current_pass_and_requires_rebind() {
        // Covers Tigon32/miniquad#143 and MADR 0020: the public
        // `clear()` must clear the pass already being recorded, not
        // switch to the default framebuffer, even though Metal can
        // only honor it by ending and reopening the encoder.
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, None);
            let shader = context
                .new_shader(
                    ShaderSource::Msl {
                        program: LINE_PROGRAM,
                    },
                    shader_meta(),
                )
                .unwrap();
            let pipeline = context.new_pipeline(
                &[BufferLayout::default()],
                &[VertexAttribute::new("position", VertexFormat::Float2)],
                shader,
                PipelineParams::default(),
            );
            // A quad covering only the left texel (x in [-1, -0.1]);
            // the right texel is left untouched so the readback can
            // tell `clear`'s color from a draw's color.
            let vertex_buffer = context.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[-1.0_f32, -1.0, -0.1, -1.0, -0.1, 1.0, -1.0, 1.0]),
            );
            let index_buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2, 0, 2, 3]),
            );

            context.begin_pass(Some(pass), PassAction::clear_color(0., 0., 0., 1.));
            let first_encoder = context.render_encoder.unwrap();

            // The pass above is still open (no `end_render_pass`):
            // this is the real public API, not a `begin_pass` proxy.
            context.clear(Some((0., 1., 0., 1.)), None, None);
            assert_eq!(
                context.current_pass_target,
                Some(Some(pass)),
                "clear() mid-pass must keep targeting the active offscreen pass"
            );
            assert_ne!(
                context.render_encoder.unwrap(),
                first_encoder,
                "Metal has no mid-encoder clear; clear() must open a fresh encoder on the same target"
            );

            // Per MADR 0020, the fresh encoder has no pipeline or
            // bindings bound; reapply both before the next draw.
            context.apply_pipeline(&pipeline);
            context.apply_bindings_from_slice(&[vertex_buffer], index_buffer, &[]);
            context.draw(0, 6, 1);
            context.end_render_pass();
            context.really_end_encoder();
            let command_buffer = context.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            let color_texture = context.textures.get(color).texture;
            let pixels = read_rgba8_texture(context, color_texture, 2, 1);
            assert_eq!(
                pixels,
                vec![255, 255, 255, 255, 0, 255, 0, 255],
                "left texel: the rebound draw; right texel: clear()'s green reached the real target: {:?}",
                pixels
            );

            context.delete_buffer(vertex_buffer);
            context.delete_buffer(index_buffer);
            context.delete_pipeline(pipeline);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn clear_preserves_color_and_depth_when_requested_components_are_none() {
        // Covers Tigon32/miniquad#143: `PassAction::Clear { depth:
        // None, .. }` (and `color: None`) must preserve the existing
        // attachment contents (`Load`), matching the GL backend, not
        // clear it to a hardcoded default. Proven by real rendering
        // behavior (a depth-test probe draw), not descriptor
        // inspection: a stale GL-only inspection could pass while
        // still clearing to the wrong value.
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let depth = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::Depth,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, Some(depth));
            let shader = context
                .new_shader(
                    ShaderSource::Msl {
                        program: DEPTH_PROBE_PROGRAM,
                    },
                    shader_meta(),
                )
                .unwrap();
            // depth_write: false keeps every probe draw from
            // disturbing the depth value the test is inspecting.
            let probe = context.new_pipeline(
                &[BufferLayout::default()],
                &[VertexAttribute::new("position", VertexFormat::Float3)],
                shader,
                PipelineParams {
                    depth_test: Comparison::Less,
                    depth_write: false,
                    ..Default::default()
                },
            );
            // A full-screen triangle at clip-space z = 0.5.
            let vertex_buffer = context.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[-1.0_f32, -1.0, 0.5, 3.0, -1.0, 0.5, -1.0, 3.0, 0.5]),
            );
            let index_buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2]),
            );
            let run_pass = |context: &mut MetalContext, action, draw: bool| {
                context.begin_pass(Some(pass), action);
                if draw {
                    context.apply_pipeline(&probe);
                    context.apply_bindings_from_slice(&[vertex_buffer], index_buffer, &[]);
                    context.draw(0, 3, 1);
                }
                context.end_render_pass();
                context.really_end_encoder();
                let command_buffer = context.command_buffer.take().unwrap();
                msg_send_![command_buffer, commit];
                msg_send_![command_buffer, waitUntilCompleted];
            };
            let color_texture = context.textures.get(color).texture;

            // Baseline: depth = 0.0, color = black.
            run_pass(
                context,
                PassAction::Clear {
                    color: Some((0., 0., 0., 1.)),
                    depth: Some(0.),
                    stencil: None,
                },
                false,
            );

            // depth: None must preserve 0.0: the probe (z = 0.5)
            // fails `Less` against it and is culled, so the fresh
            // white clear survives untouched.
            run_pass(
                context,
                PassAction::Clear {
                    color: Some((1., 1., 1., 1.)),
                    depth: None,
                    stencil: None,
                },
                true,
            );
            assert_eq!(
                read_rgba8_texture(context, color_texture, 1, 1),
                vec![255, 255, 255, 255],
                "depth: None must preserve the prior depth value, culling the probe"
            );

            // An explicit depth clear to 1.0 must still work: the
            // probe now passes `Less` and overwrites the clear.
            run_pass(
                context,
                PassAction::Clear {
                    color: Some((0., 1., 0., 1.)),
                    depth: Some(1.),
                    stencil: None,
                },
                true,
            );
            assert_eq!(
                read_rgba8_texture(context, color_texture, 1, 1),
                vec![255, 0, 0, 255],
                "an explicit depth clear must still let the probe pass"
            );

            // color: None must preserve the probe's red, not clear
            // to a default.
            run_pass(
                context,
                PassAction::Clear {
                    color: None,
                    depth: Some(1.),
                    stencil: None,
                },
                false,
            );
            assert_eq!(
                read_rgba8_texture(context, color_texture, 1, 1),
                vec![255, 0, 0, 255],
                "color: None must preserve the prior color contents"
            );

            context.delete_buffer(vertex_buffer);
            context.delete_buffer(index_buffer);
            context.delete_pipeline(probe);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(depth);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn resolve_attachments_feature_renders_and_resolves_a_multisampled_pass() {
        // Covers Tigon32/miniquad#143: a prior version of this test
        // only created and deleted a resolve-capable pass descriptor
        // without ever rendering through it. This renders into a
        // real multisample target, lets Metal resolve it, and reads
        // the resolve texture's actual pixels.
        autoreleasepool(|| unsafe {
            let mut harness = render_harness_msaa();
            let context = &mut harness.context;
            assert!(context.info().features.resolve_attachments);
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 2,
                    format: TextureFormat::RGBA8,
                    sample_count: 4,
                    ..TextureParams::default()
                },
            );
            let resolve = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 2,
                    height: 2,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], Some(&[resolve]), None);
            let shader = context
                .new_shader(
                    ShaderSource::Msl {
                        program: LINE_PROGRAM,
                    },
                    shader_meta(),
                )
                .unwrap();
            let pipeline = context.new_pipeline(
                &[BufferLayout::default()],
                &[VertexAttribute::new("position", VertexFormat::Float2)],
                shader,
                PipelineParams::default(),
            );
            let vertex_buffer = context.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[-3.0_f32, -3.0, 3.0, -3.0, 3.0, 3.0, -3.0, 3.0]),
            );
            let index_buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2, 0, 2, 3]),
            );

            context.begin_pass(Some(pass), PassAction::clear_color(0., 0., 0., 1.));
            context.apply_pipeline(&pipeline);
            context.apply_bindings_from_slice(&[vertex_buffer], index_buffer, &[]);
            context.draw(0, 6, 1);
            context.end_render_pass();
            context.really_end_encoder();
            let command_buffer = context.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            let status: u64 = msg_send![command_buffer, status];
            let error: ObjcId = msg_send_![command_buffer, error];
            assert_eq!(status, 4 /* MTLCommandBufferStatusCompleted */);
            assert!(error.is_null());

            let resolve_texture = context.textures.get(resolve).texture;
            let pixels = read_rgba8_texture(context, resolve_texture, 2, 2);
            assert_eq!(
                pixels,
                vec![255_u8; 16],
                "the resolved texture must show the real rendered color, not just exist: {:?}",
                pixels
            );

            context.delete_buffer(vertex_buffer);
            context.delete_buffer(index_buffer);
            context.delete_pipeline(pipeline);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(resolve);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn clear_applies_and_preserves_stencil_values() {
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let depth = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::Depth,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, Some(depth));
            let shader = context
                .new_shader(
                    ShaderSource::Msl {
                        program: DEPTH_PROBE_PROGRAM,
                    },
                    shader_meta(),
                )
                .unwrap();
            let pipeline = context.new_pipeline(
                &[BufferLayout::default()],
                &[VertexAttribute::new("position", VertexFormat::Float3)],
                shader,
                PipelineParams {
                    depth_test: Comparison::Less,
                    depth_write: false,
                    ..Default::default()
                },
            );
            let vertex_buffer = context.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[-1.0_f32, -1.0, 0.5, 3.0, -1.0, 0.5, -1.0, 3.0, 0.5]),
            );
            let index_buffer = context.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2]),
            );

            let stencil_descriptor = owned(msg_send![class!(MTLStencilDescriptor), new]);
            msg_send_![stencil_descriptor.as_id(), setStencilCompareFunction: MTLCompareFunction::Equal];
            msg_send_![stencil_descriptor.as_id(), setReadMask: u32::MAX];
            msg_send_![stencil_descriptor.as_id(), setWriteMask: 0u32];
            let depth_stencil_descriptor = owned(msg_send![class!(MTLDepthStencilDescriptor), new]);
            msg_send_![depth_stencil_descriptor.as_id(), setDepthCompareFunction: MTLCompareFunction::Less];
            msg_send_![depth_stencil_descriptor.as_id(), setDepthWriteEnabled: BOOL::from(false)];
            msg_send_![depth_stencil_descriptor.as_id(), setFrontFaceStencil: stencil_descriptor.as_id()];
            msg_send_![depth_stencil_descriptor.as_id(), setBackFaceStencil: stencil_descriptor.as_id()];
            let stencil_state = owned(msg_send![
                context.device,
                newDepthStencilStateWithDescriptor: depth_stencil_descriptor.as_id()
            ]);

            let run_pass = |context: &mut MetalContext, action, draw: bool| {
                context.begin_pass(Some(pass), action);
                if draw {
                    context.apply_pipeline(&pipeline);
                    context.apply_bindings_from_slice(&[vertex_buffer], index_buffer, &[]);
                    let encoder = context.render_encoder.unwrap();
                    msg_send_![encoder, setDepthStencilState: stencil_state.as_id()];
                    msg_send_![encoder, setStencilReferenceValue: 5u32];
                    context.draw(0, 3, 1);
                }
                context.end_render_pass();
                context.really_end_encoder();
                let command_buffer = context.command_buffer.take().unwrap();
                msg_send_![command_buffer, commit];
                msg_send_![command_buffer, waitUntilCompleted];
            };
            let color_texture = context.textures.get(color).texture;

            run_pass(
                context,
                PassAction::Clear {
                    color: Some((0., 0., 0., 1.)),
                    depth: Some(1.),
                    stencil: Some(5),
                },
                false,
            );
            run_pass(
                context,
                PassAction::Clear {
                    color: Some((0., 0., 0., 1.)),
                    depth: None,
                    stencil: None,
                },
                true,
            );
            assert_eq!(
                read_rgba8_texture(context, color_texture, 1, 1),
                vec![255, 0, 0, 255],
                "stencil: None must preserve the prior value of 5"
            );

            run_pass(
                context,
                PassAction::Clear {
                    color: Some((0., 1., 0., 1.)),
                    depth: None,
                    stencil: Some(0),
                },
                true,
            );
            assert_eq!(
                read_rgba8_texture(context, color_texture, 1, 1),
                vec![0, 255, 0, 255],
                "an explicit stencil clear to 0 must reject the probe with reference 5"
            );

            context.delete_buffer(vertex_buffer);
            context.delete_buffer(index_buffer);
            context.delete_pipeline(pipeline);
            context.delete_shader(shader);
            context.delete_render_pass(pass);
            context.delete_texture(depth);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn rgb8_upload_and_read_pixels_round_trip_through_rgba8_conversion() {
        // Regression for Tigon32/miniquad#142: `TextureFormat::RGB8` has no native Metal pixel
        // format. It must upload/read back exactly `format.size(width, height)` == 3
        // bytes/pixel at the public API, converting through Metal's `RGBA8Unorm` storage
        // internally, with no silent channel/byte-count drift.
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let params = TextureParams {
                width: 2,
                height: 1,
                format: TextureFormat::RGB8,
                ..TextureParams::default()
            };
            let rgb_bytes = [10_u8, 20, 30, 200, 210, 220];
            assert_eq!(params.format.size(2, 1) as usize, rgb_bytes.len());
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Bytes(&rgb_bytes),
                params,
            );
            let mut read_back = vec![0_u8; rgb_bytes.len()];
            context.texture_read_pixels(texture, &mut read_back);
            assert_eq!(
                read_back, rgb_bytes,
                "RGB8 read-back must match the uploaded 3 bytes/pixel exactly"
            );
            context.delete_texture(texture);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn alpha_upload_and_read_pixels_round_trip() {
        // Regression for Tigon32/miniquad#142: `TextureFormat::Alpha` maps to Metal's native
        // `MTLPixelFormatA8Unorm` (1 byte/pixel), unlike RGB8's conversion path.
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let params = TextureParams {
                width: 3,
                height: 1,
                format: TextureFormat::Alpha,
                ..TextureParams::default()
            };
            let alpha_bytes = [5_u8, 128, 250];
            assert_eq!(params.format.size(3, 1) as usize, alpha_bytes.len());
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Bytes(&alpha_bytes),
                params,
            );
            let mut read_back = vec![0_u8; alpha_bytes.len()];
            context.texture_read_pixels(texture, &mut read_back);
            assert_eq!(read_back, alpha_bytes);
            context.delete_texture(texture);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn depth32_render_target_supports_creation_clear_and_pixel_readback() {
        // Regression for Tigon32/miniquad#142: `TextureFormat::Depth32` previously hit
        // `todo!()` in `From<TextureFormat> for MTLPixelFormat`. It must behave like a normal
        // color render target for creation/clear/read-back, at the documented 4 bytes/pixel.
        autoreleasepool(|| unsafe {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let color = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let depth = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::Depth32,
                    ..TextureParams::default()
                },
            );
            let pass = context.new_render_pass_mrt(&[color], None, Some(depth));
            context.begin_pass(
                Some(pass),
                PassAction::Clear {
                    color: Some((0., 0., 0., 1.)),
                    depth: Some(0.25),
                    stencil: None,
                },
            );
            context.end_render_pass();
            context.really_end_encoder();
            let command_buffer = context.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            let mut bytes = [0_u8; 4];
            context.texture_read_pixels(depth, &mut bytes);
            let value = f32::from_ne_bytes(bytes);
            assert!(
                (value - 0.25).abs() < 1e-4,
                "Depth32 clear-to-0.25 must read back as ~0.25, got {}",
                value
            );

            context.delete_render_pass(pass);
            context.delete_texture(depth);
            context.delete_texture(color);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn texture_resize_reallocates_storage_and_reuploads_bytes() {
        autoreleasepool(|| {
            let mut harness = harness();
            let context = &mut harness.context;
            let texture = context.new_texture(
                TextureAccess::Static,
                TextureSource::Bytes(&[1_u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
                TextureParams {
                    width: 2,
                    height: 2,
                    format: TextureFormat::RGBA8,
                    ..TextureParams::default()
                },
            );
            let new_bytes: Vec<u8> = (0..(3 * 3 * 4)).map(|i| i as u8).collect();
            context.texture_resize(texture, 3, 3, Some(&new_bytes));
            let params = context.texture_params(texture);
            assert_eq!((params.width, params.height), (3, 3));
            let mut read_back = vec![0_u8; new_bytes.len()];
            context.texture_read_pixels(texture, &mut read_back);
            assert_eq!(
                read_back, new_bytes,
                "texture_resize must reallocate storage at the new size and apply the given bytes"
            );
            context.delete_texture(texture);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn texture_resize_is_rejected_for_a_raw_texture() {
        autoreleasepool(|| unsafe {
            let mut harness = harness();
            let context = &mut harness.context;
            let descriptor = msg_send_![class!(MTLTextureDescriptor),
                       texture2DDescriptorWithPixelFormat:MTLPixelFormat::RGBA8Unorm
                       width: 2u64
                       height: 2u64
                       mipmapped: NO];
            msg_send_![descriptor, setStorageMode: MTLStorageMode::Shared];
            let raw_texture =
                owned(msg_send![context.device, newTextureWithDescriptor: descriptor]);
            let texture = TextureId::from_raw_id(RawId::Metal(raw_texture.as_id()));

            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.texture_resize(texture, 4, 4, None)
            }))
            .is_err());
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn depth_format_cpu_upload_resize_and_read_pixels_are_rejected_with_clear_panics() {
        // Regression for Tigon32/miniquad#142: `TextureFormat::Depth` (Metal's combined
        // depth/stencil storage) cannot support `TextureFormat::size`'s documented 2
        // bytes/pixel for any CPU-visible path. Each operation must panic instead of silently
        // reading/writing the wrong number of bytes.
        autoreleasepool(|| {
            let mut harness = render_harness();
            let context = &mut harness.context;
            let depth = context.new_texture(
                TextureAccess::RenderTarget,
                TextureSource::Empty,
                TextureParams {
                    width: 1,
                    height: 1,
                    format: TextureFormat::Depth,
                    ..TextureParams::default()
                },
            );
            let mut bytes = [0_u8; 2];
            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.texture_read_pixels(depth, &mut bytes)
            }))
            .is_err());
            assert!(catch_unwind(AssertUnwindSafe(|| {
                context.texture_resize(depth, 2, 2, None)
            }))
            .is_err());
            context.delete_texture(depth);
        });
    }

    #[test]
    #[ignore = "requires a real macOS arm64 Metal device"]
    fn raw_metal_texture_is_introspected_and_its_ownership_is_not_taken() {
        // Regression for Tigon32/miniquad#142: wrapping a caller-owned `MTLTexture` through
        // `TextureId::from_raw_id` must synthesize real metadata (dimensions/format) and its
        // own sampler, and `delete_texture` must release only that synthesized sampler, never
        // the caller's texture.
        autoreleasepool(|| unsafe {
            let mut harness = harness();
            let context = &mut harness.context;
            let descriptor = msg_send_![class!(MTLTextureDescriptor),
                       texture2DDescriptorWithPixelFormat:MTLPixelFormat::RGBA8Unorm
                       width: 4u64
                       height: 2u64
                       mipmapped: NO];
            msg_send_![descriptor, setStorageMode: MTLStorageMode::Shared];
            let raw_texture =
                owned(msg_send![context.device, newTextureWithDescriptor: descriptor]);
            let retain_count_before: u64 = msg_send![raw_texture.as_id(), retainCount];

            let texture = TextureId::from_raw_id(RawId::Metal(raw_texture.as_id()));
            let params = context.texture_params(texture);
            assert_eq!((params.width, params.height), (4, 2));
            assert_eq!(params.format, TextureFormat::RGBA8);
            assert_eq!(
                context.texture_raw_id(texture),
                RawId::Metal(raw_texture.as_id()),
                "texture_raw_id must return the caller's own texture pointer unchanged"
            );

            context.delete_texture(texture);

            let retain_count_after: u64 = msg_send![raw_texture.as_id(), retainCount];
            assert_eq!(
                retain_count_before, retain_count_after,
                "delete_texture on a raw TextureId must not release the caller's texture"
            );
        });
    }
}
impl RenderingBackend for MetalContext {
    fn info(&self) -> ContextInfo {
        ContextInfo {
            backend: Backend::Metal,
            gl_version_string: Default::default(),
            glsl_support: Default::default(),
            features: Features {
                instancing: true,
                resolve_attachments: true,
            },
        }
    }

    fn buffer_size(&mut self, buffer: BufferId) -> usize {
        self.buffer(buffer).size
    }
    fn delete_buffer(&mut self, buffer_id: BufferId) {
        let buffer = self.buffers.remove(buffer_id.0);
        if self
            .index_buffer
            .is_some_and(|raw| buffer.raw.contains(&raw))
        {
            self.index_buffer = None;
        }
        unsafe {
            for raw in &buffer.raw {
                msg_send_![*raw, release];
            }
        }
    }
    fn delete_texture(&mut self, texture: TextureId) {
        self.textures.delete(texture);
    }
    fn apply_viewport(&mut self, _x: i32, _y: i32, _w: i32, _h: i32) {}
    fn apply_scissor_rect(&mut self, x: i32, y: i32, w: i32, h: i32) {
        assert!(self.render_encoder.is_some());

        // Flip against the active pass height, not the screen —
        // they diverge for off-screen targets at high DPI. Then
        // clamp into `[0, pass_size]` on both axes: callers
        // (macroquad) can briefly request a scissor sized against
        // a stale screen cache (e.g. mid-rotation, where the
        // caller's `screen_size()` lags MTKView's drawable
        // dimensions by a frame), and an unclamped scissor would
        // trip Metal validation.
        let pass_width = self.current_pass_width as i32;
        let pass_height = self.current_pass_height as i32;
        let x_clamped = x.clamp(0, pass_width);
        let y_metal = (pass_height - (y + h)).clamp(0, pass_height);
        let w_clamped = (pass_width - x_clamped).clamp(0, w.max(0));
        let h_clamped = (pass_height - y_metal).clamp(0, h.max(0));
        let r = MTLScissorRect {
            x: x_clamped as u64,
            y: y_metal as u64,
            width: w_clamped as u64,
            height: h_clamped as u64,
        };
        unsafe { msg_send_![self.render_encoder.unwrap(), setScissorRect: r] };
    }
    fn texture_set_min_filter(
        &mut self,
        texture: TextureId,
        filter: FilterMode,
        mipmap_filter: MipmapFilterMode,
    ) {
        let texture = self.textures.get_mut(texture);

        let filter = match filter {
            FilterMode::Nearest => MTLSamplerMinMagFilter::Nearest,
            FilterMode::Linear => MTLSamplerMinMagFilter::Linear,
        };

        let mipmap_filter = match mipmap_filter {
            MipmapFilterMode::None => MTLSamplerMipFilter::NotMipmapped,
            MipmapFilterMode::Nearest => MTLSamplerMipFilter::Nearest,
            MipmapFilterMode::Linear => MTLSamplerMipFilter::Linear,
        };

        unsafe {
            msg_send_![texture.sampler_descriptor, setMinFilter: filter];
            msg_send_![texture.sampler_descriptor, setMipFilter: mipmap_filter];
        }
        texture.update_sampler(self.device);
    }
    fn texture_set_mag_filter(&mut self, texture: TextureId, filter: FilterMode) {
        let texture = self.textures.get_mut(texture);

        let filter = match filter {
            FilterMode::Nearest => MTLSamplerMinMagFilter::Nearest,
            FilterMode::Linear => MTLSamplerMinMagFilter::Linear,
        };

        unsafe {
            msg_send_![texture.sampler_descriptor, setMagFilter: filter];
        }
        texture.update_sampler(self.device);
    }
    fn texture_set_wrap(&mut self, texture: TextureId, wrap_x: TextureWrap, wrap_y: TextureWrap) {
        let texture = self.textures.get_mut(texture);

        let wrap_s = match wrap_x {
            TextureWrap::Repeat => MTLSamplerAddressMode::Repeat,
            TextureWrap::Mirror => MTLSamplerAddressMode::MirrorRepeat,
            TextureWrap::Clamp => MTLSamplerAddressMode::ClampToEdge,
        };

        let wrap_t = match wrap_y {
            TextureWrap::Repeat => MTLSamplerAddressMode::Repeat,
            TextureWrap::Mirror => MTLSamplerAddressMode::MirrorRepeat,
            TextureWrap::Clamp => MTLSamplerAddressMode::ClampToEdge,
        };

        unsafe {
            msg_send_![texture.sampler_descriptor, setSAddressMode: wrap_s];
            msg_send_![texture.sampler_descriptor, setTAddressMode: wrap_t];
        }
        texture.update_sampler(self.device);
    }
    /// Reallocates a managed texture's backing `MTLTexture` at the new dimensions, keeping its
    /// sampler. `bytes`, when given, must be `format.size(width, height)` bytes — the same
    /// public per-pixel contract as `new_texture`/`texture_update_part`.
    ///
    /// Unsupported for a texture wrapped with `TextureId::from_raw_id`: miniquad does not own
    /// the caller's `MTLTexture` and cannot reallocate it (see
    /// docs/adr/0021-metal-texture-format-and-raw-texture-contract.md). Also unsupported for
    /// `TextureFormat::Depth`, for the same combined depth/stencil reason documented on
    /// `mtl_storage_bytes_per_pixel`.
    fn texture_resize(
        &mut self,
        texture: TextureId,
        width: u32,
        height: u32,
        bytes: Option<&[u8]>,
    ) {
        assert!(
            matches!(texture.0, TextureIdInner::Managed(_)),
            "Metal: texture_resize is not supported for a texture wrapped with \
             TextureId::from_raw_id; miniquad does not own the caller's texture and cannot \
             reallocate it. Resize the caller's texture and wrap a fresh TextureId instead."
        );
        let old = self.textures.get(texture);
        let mut new_params = old.params;
        new_params.width = width;
        new_params.height = height;
        assert_ne!(
            new_params.format,
            TextureFormat::Depth,
            "Metal: texture_resize of TextureFormat::Depth is not supported; \
             use TextureFormat::Depth32 instead"
        );

        let raw_texture = unsafe { self.new_mtl_texture(old.access, new_params) };
        let entry = self.textures.get_mut(texture);
        unsafe {
            msg_send_![entry.texture, release];
        }
        entry.texture = raw_texture;
        entry.params = new_params;

        if let Some(bytes) = bytes {
            assert_eq!(new_params.format.size(width, height) as usize, bytes.len());
            self.texture_update_part(texture, 0, 0, width as _, height as _, bytes);
        }
    }
    /// Reads the texture's pixels back through a blit to a CPU-visible buffer: `new_texture`
    /// allocates render targets with `StorageModePrivate`, so `getBytes` on the texture itself
    /// is unavailable. `bytes` must be exactly `format.size(width, height)` bytes — the public
    /// per-pixel contract — even though `TextureFormat::RGB8` is stored as Metal `RGBA8Unorm`
    /// internally (see `mtl_storage_bytes_per_pixel`); the alpha channel is dropped on the way
    /// out.
    ///
    /// Unsupported for `TextureFormat::Depth`: see `mtl_storage_bytes_per_pixel`.
    fn texture_read_pixels(&mut self, texture: TextureId, bytes: &mut [u8]) {
        let t = self.textures.get(texture);
        let format = t.params.format;
        assert_ne!(
            format,
            TextureFormat::Depth,
            "Metal: texture_read_pixels of TextureFormat::Depth is not supported; \
             its storage size does not match TextureFormat::size's documented 2 bytes/pixel. \
             Use TextureFormat::Depth32 for a depth texture that supports read-back."
        );
        let width = t.params.width as u64;
        let height = t.params.height as u64;
        assert_eq!(
            format.size(width as u32, height as u32) as usize,
            bytes.len(),
            "texture_read_pixels: bytes length must match TextureFormat::size(width, height)"
        );

        // Close any deferred render encoder before opening a blit
        // encoder on the same command buffer — Metal asserts
        // "encoding in progress" otherwise.
        self.really_end_encoder();

        let storage_bytes_per_pixel = mtl_storage_bytes_per_pixel(format) as u64;
        let bytes_per_row = width * storage_bytes_per_pixel;
        let total_bytes = bytes_per_row * height;

        unsafe {
            let readback: ObjcId = msg_send![
                self.device,
                newBufferWithLength: total_bytes
                options: MTLResourceOptions::StorageModeShared
            ];
            assert!(
                !readback.is_null(),
                "Metal: readback buffer creation failed"
            );

            if self.command_buffer.is_none() {
                self.command_buffer = Some(msg_send![self.command_queue, commandBuffer]);
            }
            let command_buffer = self.command_buffer.unwrap();
            let blit_encoder = msg_send_![command_buffer, blitCommandEncoder];
            msg_send_![blit_encoder, copyFromTexture: t.texture
                       sourceSlice: 0u64
                       sourceLevel: 0u64
                       sourceOrigin: MTLOrigin { x: 0, y: 0, z: 0 }
                       sourceSize: MTLSize { width, height, depth: 1 }
                       toBuffer: readback
                       destinationOffset: 0u64
                       destinationBytesPerRow: bytes_per_row
                       destinationBytesPerImage: total_bytes];
            msg_send_![blit_encoder, endEncoding];

            let command_buffer = self.command_buffer.take().unwrap();
            msg_send_![command_buffer, commit];
            msg_send_![command_buffer, waitUntilCompleted];

            let ptr: *const u8 = msg_send![readback, contents];
            let storage_bytes = std::slice::from_raw_parts(ptr, total_bytes as usize);
            if format == TextureFormat::RGB8 {
                rgba8_to_rgb8(storage_bytes, bytes);
            } else {
                bytes.copy_from_slice(storage_bytes);
            }
            msg_send_![readback, release];
        }
    }
    fn texture_generate_mipmaps(&mut self, texture: TextureId) {
        let texture = self.textures.get(texture);
        // Catch the bug at the call site instead of letting Metal
        // assert on `mipmapLevelCount > 1` deep inside the blit
        // encoder. Set `TextureParams::allocate_mipmaps = true` at
        // creation to use this entry point.
        assert!(
            texture.params.allocate_mipmaps,
            "texture_generate_mipmaps called on a texture allocated without mipmaps",
        );
        // Close any deferred render encoder before opening a blit
        // encoder on the same command buffer — Metal asserts
        // "encoding in progress" otherwise.
        self.really_end_encoder();
        unsafe {
            if self.command_buffer.is_none() {
                self.command_buffer = Some(msg_send![self.command_queue, commandBuffer]);
            }
            let command_buffer = self.command_buffer.unwrap();
            let encoder = msg_send_![command_buffer, blitCommandEncoder];
            msg_send_![encoder, generateMipmapsForTexture: texture.texture];
            msg_send_![encoder, endEncoding];
        }
    }
    fn texture_params(&self, texture: TextureId) -> TextureParams {
        let texture = self.textures.get(texture);
        texture.params
    }
    unsafe fn texture_raw_id(&self, texture: TextureId) -> RawId {
        let texture = self.textures.get(texture);
        RawId::Metal(texture.texture)
    }

    fn clear(
        &mut self,
        color: Option<(f32, f32, f32, f32)>,
        depth: Option<f32>,
        stencil: Option<i32>,
    ) {
        let action = PassAction::Clear {
            color,
            depth,
            stencil,
        };
        // Clear the pass already being recorded, not the default
        // framebuffer: see MADR 0020. `begin_pass` ends and reopens
        // its encoder, so a caller that draws again afterward must
        // reapply its pipeline/bindings/uniforms.
        match self.current_pass_target {
            Some(pass) => self.begin_pass(pass, action),
            None => {
                self.begin_default_pass(action);
                self.end_render_pass();
            }
        }
    }

    fn new_render_pass_mrt(
        &mut self,
        color_img: &[TextureId],
        resolve_img: Option<&[TextureId]>,
        depth_img: Option<TextureId>,
    ) -> RenderPass {
        if let Some(resolve_img) = resolve_img {
            assert_eq!(
                resolve_img.len(),
                color_img.len(),
                "resolve_img must have one entry per color attachment"
            );
        }
        unsafe {
            let render_pass_desc =
                msg_send_![class!(MTLRenderPassDescriptor), renderPassDescriptor];
            let descriptor_owner = RcObjcId::from_unowned(
                NonNull::new(render_pass_desc)
                    .expect("Metal: render pass descriptor creation failed"),
            );
            for (i, color_img) in color_img.iter().enumerate() {
                let color_texture = self.textures.get(*color_img).texture;
                let color_attachment = msg_send_![msg_send_![render_pass_desc, colorAttachments], objectAtIndexedSubscript:i];
                msg_send_![color_attachment, setTexture: color_texture];
                msg_send_![color_attachment, setLoadAction: MTLLoadAction::Clear];
                // Multisample resolve: when the caller passes a resolve
                // texture for this attachment, downsample into it on
                // store. Required for any MSAA render target.
                if let Some(resolve_img) = resolve_img {
                    let resolve_texture = self.textures.get(resolve_img[i]).texture;
                    msg_send_![color_attachment, setResolveTexture: resolve_texture];
                    msg_send_![
                        color_attachment,
                        setStoreAction: MTLStoreAction::MultisampleResolve
                    ];
                } else {
                    msg_send_![color_attachment, setStoreAction: MTLStoreAction::Store];
                }
            }
            if let Some(depth_img) = depth_img {
                let depth_texture = self.textures.get(depth_img).texture;

                // `begin_pass` sets loadAction/storeAction/clearDepth
                // per call from the requested `PassAction`.
                let depth_attachment = msg_send_![render_pass_desc, depthAttachment];
                msg_send_![depth_attachment, setTexture: depth_texture];

                let stencil_attachment = msg_send_![render_pass_desc, stencilAttachment];
                msg_send_![stencil_attachment, setTexture: depth_texture];
            }
            let pass = RenderPassInternal {
                render_pass_desc: descriptor_owner.forget().as_ptr(),
                texture: color_img.to_vec(),
                _depth_texture: depth_img,
            };

            RenderPass(self.passes.add(pass))
        }
    }

    fn delete_render_pass(&mut self, render_pass: RenderPass) {
        if self.current_pass_target == Some(Some(render_pass)) {
            assert!(
                self.pending_end_encoder,
                "Metal: cannot delete an active render pass"
            );
            self.really_end_encoder();
        }
        let render_pass = self.passes.remove(render_pass.0);
        unsafe {
            msg_send_![render_pass.render_pass_desc, release];
        }
    }

    fn render_pass_color_attachments(&self, render_pass: RenderPass) -> &[TextureId] {
        &self.pass(render_pass).texture
    }

    fn new_buffer(
        &mut self,
        buffer_type: BufferType,
        _usage: BufferUsage,
        data: BufferSource,
    ) -> BufferId {
        let (size, element_size) = match &data {
            BufferSource::Slice(data) => (data.size, data.element_size),
            BufferSource::Empty { size, element_size } => (*size, *element_size),
        };
        let index_type = match buffer_type {
            BufferType::IndexBuffer => Some(match element_size {
                2 => MTLIndexType::UInt16,
                4 => MTLIndexType::UInt32,
                other => panic!(
                    "Metal: index buffer element size must be 2 (u16) or 4 (u32), got {}",
                    other
                ),
            }),
            BufferType::VertexBuffer => None,
        };
        // Cached on the `Buffer` so grow-on-demand allocations in
        // `buffer_update` match the original storage mode.
        let options = if matches!(data, BufferSource::Slice(_)) {
            MTLResourceOptions::StorageModeShared
        } else {
            #[cfg(target_os = "macos")]
            {
                MTLResourceOptions::CPUCacheModeWriteCombined
                    | MTLResourceOptions::StorageModeManaged
            }
            #[cfg(any(target_os = "ios", target_os = "tvos"))]
            {
                MTLResourceOptions::CPUCacheModeWriteCombined
            }
        };
        let buffer: ObjcId = if let BufferSource::Slice(data) = &data {
            debug_assert!(data.is_slice);
            let size = data.size as u64;
            unsafe {
                msg_send![self.device,
                          newBufferWithBytes:data.ptr
                          length:size
                          options:options]
            }
        } else {
            unsafe {
                msg_send![self.device,
                          newBufferWithLength:size
                          options:options]
            }
        };
        assert!(!buffer.is_null(), "Metal: buffer creation failed");
        let buffer = Buffer {
            raw: vec![buffer],
            size,
            options,
            index_type,
            value: 0,
            next_value: 0,
        };
        BufferId(self.buffers.add(buffer))
    }

    fn buffer_update(&mut self, buffer: BufferId, data: BufferSource) {
        let data = match data {
            BufferSource::Slice(data) => data,
            _ => panic!("buffer_update expects BufferSource::slice"),
        };
        let device = self.device;
        let buffer = self.buffer_mut(buffer);
        assert!(data.size <= buffer.size);

        // Grow `raw` lazily on first hit of a new per-frame max.
        if buffer.next_value >= buffer.raw.len() {
            let new_slot: ObjcId = unsafe {
                msg_send![device,
                          newBufferWithLength:buffer.size
                          options:buffer.options]
            };
            assert!(!new_slot.is_null(), "Metal: backing buffer creation failed");
            buffer.raw.push(new_slot);
        }

        if data.size != 0 {
            unsafe {
                let dest: *mut std::ffi::c_void =
                    msg_send![buffer.raw[buffer.next_value], contents];
                assert!(!dest.is_null(), "Metal: buffer contents are unavailable");
                std::ptr::copy(data.ptr, dest, data.size);

                #[cfg(target_os = "macos")]
                msg_send_![buffer.raw[buffer.next_value], didModifyRange:NSRange::new(0, data.size as u64)];
            }
        }
        buffer.value = buffer.next_value;
    }

    fn new_shader(
        &mut self,
        shader: ShaderSource,
        _meta: ShaderMeta,
    ) -> Result<ShaderId, ShaderError> {
        unsafe {
            let program = match shader {
                ShaderSource::Msl { program } => program,
                _ => panic!("OpenGl source on Metal context"),
            };
            let shader = apple_util::str_to_nsstring(program);
            let mut error: ObjcId = nil;
            let library: ObjcId = msg_send![
                self.device,
                newLibraryWithSource: shader
                options:nil
                error: &mut error
            ];
            if library.is_null() {
                let message = if error.is_null() {
                    "Metal shader compilation failed without a diagnostic".to_owned()
                } else {
                    let description: ObjcId = msg_send![error, localizedDescription];
                    apple_util::nsstring_to_string(description)
                };
                return Err(ShaderError::LinkError(message));
            }
            let library_owner = RcObjcId::from_owned(
                NonNull::new(library).expect("Metal: shader library is unavailable"),
            );

            let vertex_function: ObjcId = msg_send![library, newFunctionWithName: apple_util::str_to_nsstring("vertexShader")];
            let vertex_owner =
                RcObjcId::from_owned(NonNull::new(vertex_function).ok_or_else(|| {
                    ShaderError::LinkError("Metal: vertexShader entry point is missing".to_owned())
                })?);
            let fragment_function: ObjcId = msg_send![library, newFunctionWithName: apple_util::str_to_nsstring("fragmentShader")];
            let fragment_owner =
                RcObjcId::from_owned(NonNull::new(fragment_function).ok_or_else(|| {
                    ShaderError::LinkError(
                        "Metal: fragmentShader entry point is missing".to_owned(),
                    )
                })?);
            drop(library_owner);
            let shader = ShaderInternal {
                vertex_function: vertex_owner.forget().as_ptr(),
                fragment_function: fragment_owner.forget().as_ptr(),
            };
            Ok(ShaderId(self.shaders.add(shader)))
        }
    }

    fn new_texture(
        &mut self,
        access: TextureAccess,
        bytes: TextureSource,
        params: TextureParams,
    ) -> TextureId {
        // Reject invalid bytes before publishing objects with no caller-owned id.
        //
        // Depth32Float_Stencil8 (TextureFormat::Depth)'s combined depth/stencil storage is not
        // addressable with `replaceRegion` in a way that matches `TextureFormat::size`'s
        // documented 2-bytes-per-pixel contract (see `mtl_storage_bytes_per_pixel`), so CPU
        // upload of that format stays a documented unsupported state. Use
        // `TextureFormat::Depth32` for a depth texture that needs CPU-supplied bytes.
        match &bytes {
            TextureSource::Empty => {}
            TextureSource::Bytes(bytes) => {
                assert_ne!(
                    params.format,
                    TextureFormat::Depth,
                    "Metal: CPU upload of TextureFormat::Depth is not supported; \
                     use TextureFormat::Depth32 instead"
                );
                assert_eq!(
                    params.format.size(params.width, params.height) as usize,
                    bytes.len()
                );
            }
            TextureSource::Array(array) => {
                assert_ne!(
                    params.format,
                    TextureFormat::Depth,
                    "Metal: CPU upload of TextureFormat::Depth is not supported; \
                     use TextureFormat::Depth32 instead"
                );
                for face in array.iter() {
                    for bytes in face.iter() {
                        assert_eq!(
                            bytes.len() as u32,
                            params.format.size(params.width, params.height)
                        );
                    }
                }
            }
        }

        let texture = unsafe {
            let sampler_descriptor = msg_send_![class!(MTLSamplerDescriptor), new];
            let descriptor_owner = RcObjcId::from_owned(
                NonNull::new(sampler_descriptor)
                    .expect("Metal: sampler descriptor creation failed"),
            );
            let min_filter = match params.min_filter {
                FilterMode::Nearest => MTLSamplerMinMagFilter::Nearest,
                FilterMode::Linear => MTLSamplerMinMagFilter::Linear,
            };

            let mag_filter = match params.mag_filter {
                FilterMode::Nearest => MTLSamplerMinMagFilter::Nearest,
                FilterMode::Linear => MTLSamplerMinMagFilter::Linear,
            };

            let mipmap_filter = match params.mipmap_filter {
                MipmapFilterMode::None => MTLSamplerMipFilter::NotMipmapped,
                MipmapFilterMode::Nearest => MTLSamplerMipFilter::Nearest,
                MipmapFilterMode::Linear => MTLSamplerMipFilter::Linear,
            };
            msg_send_![sampler_descriptor, setMinFilter: min_filter];
            msg_send_![sampler_descriptor, setMagFilter: mag_filter];
            msg_send_![sampler_descriptor, setMipFilter: mipmap_filter];

            let sampler_state = msg_send_![
                self.device,
                newSamplerStateWithDescriptor: sampler_descriptor
            ];
            let sampler_owner = RcObjcId::from_owned(
                NonNull::new(sampler_state).expect("Metal: sampler creation failed"),
            );
            let raw_texture = self.new_mtl_texture(access, params);
            let texture_owner = RcObjcId::from_owned(
                NonNull::new(raw_texture).expect("Metal: texture creation failed"),
            );
            self.textures.push_managed(Texture {
                sampler: sampler_owner.forget().as_ptr(),
                texture: texture_owner.forget().as_ptr(),
                sampler_descriptor: descriptor_owner.forget().as_ptr(),
                params,
                access,
                freed: false,
            })
        };

        match bytes {
            TextureSource::Empty => {}
            TextureSource::Bytes(bytes) => {
                self.texture_update_part(
                    texture,
                    0,
                    0,
                    params.width as _,
                    params.height as _,
                    bytes,
                );
            }
            TextureSource::Array(array) => {
                let bytes_per_pixel = mtl_storage_bytes_per_pixel(params.format);
                for (n, face) in array.iter().enumerate() {
                    for (mipmap_level, bytes) in face.iter().enumerate() {
                        let raw_texture = self.textures.get(texture).texture;
                        let region = MTLRegion {
                            origin: MTLOrigin {
                                x: 0_u64,
                                y: 0_u64,
                                z: 0,
                            },
                            size: MTLSize {
                                width: params.width as u64,
                                height: params.height as u64,
                                depth: 1,
                            },
                        };
                        let upload = prepare_upload_bytes(params.format, bytes);
                        unsafe {
                            msg_send_![raw_texture, replaceRegion:region
                                  mipmapLevel:mipmap_level
                                  slice: n
                                  withBytes:upload.as_ptr()
                                  bytesPerRow:(params.width * bytes_per_pixel) as u64
                                  bytesPerImage:0
                            ];
                        }
                    }
                }
            }
        }
        texture
    }

    fn texture_update_part(
        &mut self,
        texture: TextureId,
        x_offset: i32,
        y_offset: i32,
        width: i32,
        height: i32,
        bytes: &[u8],
    ) {
        let t = self.textures.get(texture);
        let format = t.params.format;
        assert_ne!(
            format,
            TextureFormat::Depth,
            "Metal: CPU upload of TextureFormat::Depth is not supported; \
             use TextureFormat::Depth32 instead"
        );
        let raw_texture = t.texture;
        let region = MTLRegion {
            origin: MTLOrigin {
                x: x_offset as u64,
                y: y_offset as u64,
                z: 0,
            },
            size: MTLSize {
                width: width as u64,
                height: height as u64,
                depth: 1,
            },
        };
        let upload = prepare_upload_bytes(format, bytes);
        let bytes_per_pixel = mtl_storage_bytes_per_pixel(format);
        unsafe {
            msg_send_![raw_texture, replaceRegion:region
                       mipmapLevel:0
                       withBytes:upload.as_ptr()
                       bytesPerRow:(width as u32 * bytes_per_pixel) as u64];
        }
    }

    fn new_pipeline(
        &mut self,
        buffer_layout: &[BufferLayout],
        attributes: &[VertexAttribute],
        shader: ShaderId,
        params: PipelineParams,
    ) -> Pipeline {
        unsafe {
            let shader_internal = self.shader(shader);

            let vertex_descriptor: ObjcId =
                msg_send![class!(MTLVertexDescriptor), vertexDescriptor];

            let attribute = |i, buffer_index, offset, format: MTLVertexFormat| {
                let mtl_attribute_desc = msg_send_![
                    msg_send_![vertex_descriptor, attributes],
                    objectAtIndexedSubscript: i
                ];
                msg_send_![mtl_attribute_desc, setBufferIndex: buffer_index];
                msg_send_![mtl_attribute_desc, setOffset: offset];
                msg_send_![mtl_attribute_desc, setFormat: format];
            };
            let layout = |i, step_func: VertexStep, stride, step_rate| {
                let mtl_buffer_desc = msg_send_![
                    msg_send_![vertex_descriptor, layouts],
                    objectAtIndexedSubscript: i
                ];
                let step_func: MTLVertexStepFunction = step_func.into();
                msg_send_![mtl_buffer_desc, setStride: stride];
                msg_send_![mtl_buffer_desc, setStepFunction: step_func];
                msg_send_![mtl_buffer_desc, setStepRate: step_rate];
            };

            let mut offsets = [0u64; 50];
            for (i, a) in attributes.iter().enumerate() {
                let offset = &mut offsets[a.buffer_index];
                attribute(
                    i as u64,
                    a.buffer_index as u64 + 1,
                    *offset,
                    a.format.into(),
                );
                *offset += a.format.size_bytes() as u64;
            }
            for (i, buffer) in buffer_layout.iter().enumerate() {
                layout(
                    i as u64 + 1,
                    buffer.step_func,
                    if buffer.stride == 0 {
                        offsets[i]
                    } else {
                        buffer.stride as u64
                    },
                    buffer.step_rate as u64,
                );
            }

            let descriptor = msg_send_![class!(MTLRenderPipelineDescriptor), new];
            let _descriptor_owner = RcObjcId::from_owned(
                NonNull::new(descriptor).expect("Metal: pipeline descriptor creation failed"),
            );
            msg_send_![descriptor, setVertexFunction:shader_internal.vertex_function];
            msg_send_![descriptor, setFragmentFunction:shader_internal.fragment_function];
            msg_send_![descriptor, setVertexDescriptor: vertex_descriptor];
            // Only attachment 0 — the backend has no MRT path and
            // setting attachment 1 to a non-Invalid pixelFormat
            // fails Metal validation when no texture is bound.
            let color_attachments = msg_send_![descriptor, colorAttachments];
            for i in 0..1usize {
                let color_attachment = msg_send_![color_attachments, objectAtIndexedSubscript: i];
                let view_pixel_format: MTLPixelFormat = msg_send![self.view, colorPixelFormat];
                msg_send_![color_attachment, setPixelFormat: view_pixel_format];
                if let Some(color_blend) = params.color_blend {
                    msg_send_![color_attachment, setBlendingEnabled: true];

                    let BlendState {
                        equation: eq_rgb,
                        sfactor: src_rgb,
                        dfactor: dst_rgb,
                    } = color_blend;
                    let BlendState {
                        equation: eq_alpha,
                        sfactor: src_alpha,
                        dfactor: dst_alpha,
                    } = color_blend;
                    msg_send_![
                        color_attachment,
                        setRgbBlendOperation: MTLBlendOperation::from(eq_rgb)
                    ];
                    msg_send_![
                        color_attachment,
                        setAlphaBlendOperation: MTLBlendOperation::from(eq_alpha)
                    ];
                    msg_send_![
                        color_attachment,
                        setSourceRGBBlendFactor: MTLBlendFactor::from(src_rgb)
                    ];
                    msg_send_![
                        color_attachment,
                        setSourceRGBBlendFactor: MTLBlendFactor::from(src_rgb)
                    ];
                    msg_send_![
                        color_attachment,
                        setSourceAlphaBlendFactor: MTLBlendFactor::from(src_alpha)
                    ];
                    msg_send_![
                        color_attachment,
                        setDestinationRGBBlendFactor: MTLBlendFactor::from(dst_rgb)
                    ];
                    msg_send_![
                        color_attachment,
                        setDestinationAlphaBlendFactor: MTLBlendFactor::from(dst_alpha)
                    ];
                }
            }
            // Pipeline depth/stencil formats must match whatever
            // render pass uses this pipeline. MTKView reports
            // `Invalid` when no depth/stencil is configured —
            // leave the descriptor's defaults (also `Invalid`)
            // alone in that case; otherwise mirror the view.
            let view_depth_stencil_format: MTLPixelFormat =
                msg_send![self.view, depthStencilPixelFormat];
            if view_depth_stencil_format != MTLPixelFormat::Invalid {
                msg_send_![
                    descriptor,
                    setDepthAttachmentPixelFormat: view_depth_stencil_format
                ];
                msg_send_![
                    descriptor,
                    setStencilAttachmentPixelFormat: view_depth_stencil_format
                ];
            }
            // Pipeline sampleCount must match every render-pass
            // color attachment it binds to; use the view's as the
            // canonical app-wide value.
            let view_sample_count: u64 = msg_send![self.view, sampleCount];
            msg_send_![descriptor, setSampleCount: view_sample_count];

            let mut error: ObjcId = nil;
            let pipeline_state: ObjcId = msg_send![
                self.device,
                newRenderPipelineStateWithDescriptor: descriptor
                error: &mut error
            ];
            if pipeline_state.is_null() {
                let message = if error.is_null() {
                    "Metal pipeline creation failed without a diagnostic".to_owned()
                } else {
                    let description: ObjcId = msg_send![error, localizedDescription];
                    apple_util::nsstring_to_string(description)
                };
                panic!("Metal: pipeline creation failed: {}", message);
            }
            let pipeline_owner = RcObjcId::from_owned(
                NonNull::new(pipeline_state).expect("Metal: pipeline is unavailable"),
            );

            let depth_stencil_desc = msg_send_![class!(MTLDepthStencilDescriptor), new];
            let _depth_descriptor_owner = RcObjcId::from_owned(
                NonNull::new(depth_stencil_desc).expect("Metal: depth descriptor creation failed"),
            );
            msg_send_![depth_stencil_desc, setDepthWriteEnabled: BOOL::from(params.depth_write)];
            msg_send_![depth_stencil_desc, setDepthCompareFunction: MTLCompareFunction::from(params.depth_test)];

            // if let Some(stencil_test) = params.stencil_test {
            //     let back_face_stencil_desc = StencilDescriptor::new();
            //     back_face_stencil_desc.set_stencil_compare_function(stencil_test.back.test_func.into());
            //     back_face_stencil_desc.set_stencil_failure_operation(stencil_test.back.fail_op.into());
            //     back_face_stencil_desc
            //         .set_depth_failure_operation(stencil_test.back.depth_fail_op.into());
            //     back_face_stencil_desc.set_read_mask(stencil_test.back.test_mask);
            //     back_face_stencil_desc.set_write_mask(stencil_test.back.write_mask);

            //     depth_stencil_desc.set_back_face_stencil(Some(back_face_stencil_desc.as_ref()));

            //     let front_face_stencil_desc = StencilDescriptor::new();
            //     front_face_stencil_desc
            //         .set_stencil_compare_function(stencil_test.front.test_func.into());
            //     front_face_stencil_desc
            //         .set_stencil_failure_operation(stencil_test.front.fail_op.into());
            //     front_face_stencil_desc
            //         .set_depth_failure_operation(stencil_test.front.depth_fail_op.into());
            //     front_face_stencil_desc.set_read_mask(stencil_test.front.test_mask);
            //     front_face_stencil_desc.set_write_mask(stencil_test.front.write_mask);

            //     depth_stencil_desc.set_front_face_stencil(Some(front_face_stencil_desc.as_ref()))
            // }

            let depth_stencil_state = msg_send_![
                self.device,
                newDepthStencilStateWithDescriptor: depth_stencil_desc
            ];
            let depth_owner = RcObjcId::from_owned(
                NonNull::new(depth_stencil_state).expect("Metal: depth state creation failed"),
            );

            let pipeline = PipelineInternal {
                pipeline_state: pipeline_owner.forget().as_ptr(),
                depth_stencil_state: depth_owner.forget().as_ptr(),
                //layout: buffer_layout.to_vec(),
                //attributes: vertex_layout,
                _shader: shader,
                primitive_type: params.primitive_type.into(),
            };

            Pipeline(self.pipelines.add(pipeline))
        }
    }

    fn apply_pipeline(&mut self, pipeline: &Pipeline) {
        assert!(
            self.render_encoder.is_some(),
            "apply_pipeline before begin_pass"
        );
        let render_encoder = self.render_encoder.unwrap();

        unsafe {
            self.current_pipeline = Some(*pipeline);
            let pipeline = self.pipeline(*pipeline);

            msg_send_![render_encoder, setRenderPipelineState: pipeline.pipeline_state];
            msg_send_![render_encoder, setDepthStencilState:pipeline.depth_stencil_state];
            // render_encoder.set_front_facing_winding(pipeline.params.front_face_order.into());
            // render_encoder.set_cull_mode(pipeline.params.cull_face.into());
        }
    }

    fn apply_bindings_from_slice(
        &mut self,
        vertex_buffers: &[BufferId],
        index_buffer: BufferId,
        textures: &[TextureId],
    ) {
        assert!(
            self.render_encoder.is_some(),
            "apply_bindings before begin_pass"
        );

        unsafe {
            let render_encoder = self.render_encoder.unwrap();
            for (index, vertex_buffer) in vertex_buffers.iter().enumerate() {
                let buffer = self.buffer_mut(*vertex_buffer);
                let () = msg_send![render_encoder,
                                   setVertexBuffer:buffer.raw[buffer.value]
                                   offset:0
                                   atIndex:(index + 1) as u64];
                buffer.next_value = buffer.value + 1;
            }
            let index_buffer = self.buffer_mut(index_buffer);
            let index_raw = index_buffer.raw[index_buffer.value];
            let index_type = index_buffer
                .index_type
                .expect("apply_bindings: index_buffer argument must be a BufferType::IndexBuffer");
            index_buffer.next_value = index_buffer.value + 1;
            self.index_buffer = Some(index_raw);
            self.index_type = index_type;

            let img_count = textures.len();
            if img_count > 0 {
                for (n, img) in textures.iter().enumerate() {
                    let Texture {
                        sampler, texture, ..
                    } = self.textures.get(*img);
                    msg_send_![render_encoder, setFragmentSamplerState:sampler
                               atIndex:n
                    ];
                    msg_send_![render_encoder, setFragmentTexture:texture
                               atIndex:n
                    ];
                }
            }
        }
    }

    fn apply_uniforms_from_bytes(&mut self, uniform_ptr: *const u8, size: usize) {
        assert!(
            self.current_pipeline.is_some(),
            "apply_uniforms before apply_pipeline"
        );
        assert!(
            self.render_encoder.is_some(),
            "apply_uniforms before begin_pass"
        );

        let render_encoder = self.render_encoder.unwrap();

        self.current_frame_index = (self.current_frame_index + 1) % NUM_INFLIGHT_FRAMES;

        assert!(size < MAX_UNIFORM_BUFFER_SIZE as usize);

        assert!(self.current_ub_offset < MAX_UNIFORM_BUFFER_SIZE);

        let buffer = self.uniform_buffers[self.current_frame_index];
        unsafe {
            let dest: *mut std::ffi::c_void = msg_send![buffer, contents];
            std::ptr::copy(
                uniform_ptr as _,
                dest.add(self.current_ub_offset as usize),
                size,
            );

            #[cfg(target_os = "macos")]
            msg_send_![buffer, didModifyRange:NSRange::new(0, size as u64)];

            msg_send_![render_encoder,
                       setVertexBuffer:buffer
                       offset:self.current_ub_offset
                       atIndex:0];
            msg_send_![render_encoder,
                       setFragmentBuffer:buffer
                       offset:self.current_ub_offset
                       atIndex:0];
        }
        self.current_ub_offset = roundup_ub_buffer(self.current_ub_offset + size as u64);
    }

    fn begin_default_pass(&mut self, action: PassAction) {
        self.begin_pass(None, action)
    }

    fn begin_pass(&mut self, pass: Option<RenderPass>, action: PassAction) {
        unsafe {
            // Reuse the deferred encoder if this begin continues the
            // same target with a load-style action, such as repeated
            // begin/end pairs for the same render pass.
            if self.pending_end_encoder
                && self.current_pass_target == Some(pass)
                && matches!(action, PassAction::Nothing)
            {
                self.pending_end_encoder = false;
                return;
            }
            // End any encoder that is still open, deferred or not.
            // Without this, re-entering `begin_pass` (e.g. `clear`
            // called while a pass is active) would ask Metal for a
            // second render encoder on the same command buffer
            // before the first one's `endEncoding`, which Metal
            // rejects: Tigon32/miniquad#143.
            if self.render_encoder.is_some() {
                self.really_end_encoder();
            }

            if self.command_buffer.is_none() {
                self.command_buffer = Some(msg_send![self.command_queue, commandBuffer]);
            }

            let (descriptor, width_px, height_px) = match pass {
                None => {
                    // Read dimensions from the actual pass attachment
                    // texture, not `screen_size()`. MTKView's
                    // `drawableSize` and our cached screen size can
                    // both transition to the new size one frame before
                    // `currentDrawable`'s texture is recreated; reading
                    // the attachment directly avoids the gap.
                    let descriptor: ObjcId = msg_send_![self.view, currentRenderPassDescriptor];
                    let color_attachments: ObjcId = msg_send_![descriptor, colorAttachments];
                    let attachment: ObjcId =
                        msg_send_![color_attachments, objectAtIndexedSubscript: 0];
                    let texture: ObjcId = msg_send_![attachment, texture];
                    let width: u64 = msg_send![texture, width];
                    let height: u64 = msg_send![texture, height];
                    (descriptor, width as u32, height as u32)
                }
                Some(pass) => {
                    let pass = self.pass(pass);
                    // new_render_pass will panic with both color and depth components none
                    // so unwrap is safe here
                    let texture = pass
                        .texture
                        .first()
                        .copied()
                        //.or(pass.depth_texture)
                        .unwrap();

                    (
                        pass.render_pass_desc,
                        self.textures.get(texture).params.width,
                        self.textures.get(texture).params.height,
                    )
                }
            };
            assert!(!descriptor.is_null());
            self.current_pass_width = width_px;
            self.current_pass_height = height_px;

            let color_attachments = msg_send_![descriptor, colorAttachments];
            let color_attachment = msg_send_![color_attachments, objectAtIndexedSubscript: 0];

            // If the attachment has a resolve texture, use
            // `StoreAndMultisampleResolve` (not just
            // `MultisampleResolve`) so the multisample texture
            // survives target-switch boundaries within a frame —
            // a later `Load` on the same target would otherwise
            // read discarded memory.
            let resolve_texture: ObjcId = msg_send![color_attachment, resolveTexture];
            let store_action = if resolve_texture.is_null() {
                MTLStoreAction::Store
            } else {
                MTLStoreAction::StoreAndMultisampleResolve
            };
            msg_send_![color_attachment, setStoreAction: store_action];

            match action {
                PassAction::Clear {
                    color: Some(color), ..
                } => {
                    msg_send_![color_attachment, setLoadAction: MTLLoadAction::Clear];
                    msg_send_![color_attachment, setClearColor:MTLClearColor::new(color.0 as _, color.1 as _, color.2 as _, color.3 as _)];
                }
                PassAction::Clear { color: None, .. } | PassAction::Nothing => {
                    msg_send_![color_attachment, setLoadAction: MTLLoadAction::Load];
                }
            }

            // A depth texture is present both for the default pass
            // (MTKView's own depth attachment) and an offscreen pass
            // with a depth target: Tigon32/miniquad#143. `depth`/
            // `stencil` being `None` means preserve, not clear to a
            // default, matching the GL backend's `clear`.
            let depth_attachment = msg_send_![descriptor, depthAttachment];
            let depth_texture: ObjcId = msg_send![depth_attachment, texture];
            if !depth_texture.is_null() {
                msg_send_![depth_attachment, setStoreAction: MTLStoreAction::Store];
                match action {
                    PassAction::Clear {
                        depth: Some(depth), ..
                    } => {
                        msg_send_![depth_attachment, setLoadAction: MTLLoadAction::Clear];
                        msg_send_![depth_attachment, setClearDepth: depth as f64];
                    }
                    PassAction::Clear { depth: None, .. } | PassAction::Nothing => {
                        msg_send_![depth_attachment, setLoadAction: MTLLoadAction::Load];
                    }
                }

                let stencil_attachment = msg_send_![descriptor, stencilAttachment];
                let stencil_texture: ObjcId = msg_send![stencil_attachment, texture];
                if !stencil_texture.is_null() {
                    msg_send_![stencil_attachment, setStoreAction: MTLStoreAction::Store];
                    match action {
                        PassAction::Clear {
                            stencil: Some(stencil),
                            ..
                        } => {
                            msg_send_![stencil_attachment, setLoadAction: MTLLoadAction::Clear];
                            msg_send_![stencil_attachment, setClearStencil: stencil as u32];
                        }
                        PassAction::Clear { stencil: None, .. } | PassAction::Nothing => {
                            msg_send_![stencil_attachment, setLoadAction: MTLLoadAction::Load];
                        }
                    }
                }
            }

            let render_encoder = msg_send_![
                self.command_buffer.unwrap(),
                renderCommandEncoderWithDescriptor: descriptor
            ];

            // render_encoder.set_viewport(MTLViewport {
            //     originX: 0.0,
            //     originY: 0.0,
            //     width: w,
            //     height: h,
            //     znear: 0.0,
            //     zfar: 1.0,
            // });
            // render_encoder.set_scissor_rect(MTLScissorRect {
            //     x: 0,
            //     y: 0,
            //     width: w as u64,
            //     height: h as u64,
            // });

            self.render_encoder = Some(render_encoder);
            self.current_pass_target = Some(pass);
            self.pending_end_encoder = false;
        }
    }

    fn end_render_pass(&mut self) {
        assert!(
            self.render_encoder.is_some(),
            "end_render_pass unpaired with begin_render_pass!"
        );

        // Defer `endEncoding`; see `begin_pass` for the reuse rule.
        // Anything that breaks the merge invariant runs
        // `really_end_encoder` first.
        self.pending_end_encoder = true;
        self.index_buffer = None;
    }

    fn draw(&self, base_element: i32, num_elements: i32, num_instances: i32) {
        assert!(self.render_encoder.is_some(), "draw before begin_pass!");
        let render_encoder = self.render_encoder.unwrap();
        assert!(self.index_buffer.is_some());
        let index_buffer = self.index_buffer.unwrap();
        let primitive_type = self
            .current_pipeline
            .map(|pipeline| self.pipeline(pipeline).primitive_type)
            .expect("draw before apply_pipeline");
        // Reject negative values before the u64 casts below, which
        // would otherwise silently wrap into huge offsets/counts.
        assert!(base_element >= 0, "draw: base_element must be >= 0");
        assert!(num_elements >= 0, "draw: num_elements must be >= 0");
        assert!(num_instances >= 0, "draw: num_instances must be >= 0");
        let index_byte_size = match self.index_type {
            MTLIndexType::UInt16 => 2,
            MTLIndexType::UInt32 => 4,
        };
        let index_buffer_offset = base_element as u64 * index_byte_size;
        unsafe {
            msg_send_![render_encoder, drawIndexedPrimitives:primitive_type
                       indexCount:num_elements as u64
                       indexType:self.index_type
                       indexBuffer:index_buffer
                       indexBufferOffset:index_buffer_offset
                       instanceCount:num_instances as u64
                       baseVertex:0
                       baseInstance:0
            ];
        }
    }

    fn delete_shader(&mut self, shader: ShaderId) {
        let shader = self.shaders.remove(shader.0);
        unsafe {
            msg_send_![shader.vertex_function, release];
            msg_send_![shader.fragment_function, release];
        }
    }
    fn delete_pipeline(&mut self, pipeline: Pipeline) {
        let pipeline = self.pipelines.remove(pipeline.0);
        unsafe {
            msg_send_![pipeline.pipeline_state, release];
            msg_send_![pipeline.depth_stencil_state, release];
        }
    }

    fn commit_frame(&mut self) {
        // Flush the deferred `endEncoding` from the last
        // `end_render_pass`.
        if self.pending_end_encoder {
            self.really_end_encoder();
        }
        unsafe {
            assert!(!self.command_queue.is_null());
            let drawable: ObjcId = msg_send!(self.view, currentDrawable);
            //msg_send_![drawable, retain];
            msg_send_![self.command_buffer.unwrap(), presentDrawable: drawable];
            msg_send_![self.command_buffer.unwrap(), commit];
            msg_send_![self.command_buffer.unwrap(), waitUntilCompleted];
        }
        for buffer in self.buffers.values_mut() {
            buffer.next_value = 0;
        }
        self.current_ub_offset = 0;
        self.current_pipeline = None;
        self.command_buffer = None;
        if (self.current_frame_index + 1) >= 3 {
            self.current_frame_index = 0;
        }
    }
}
