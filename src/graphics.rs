//mod texture;

use crate::native::gl::*;

use std::{error::Error, fmt::Display};

//pub use texture::{FilterMode, TextureAccess, TextureFormat, TextureParams, TextureWrap};

mod gl;

pub use gl::raw_gl;

#[cfg(target_vendor = "apple")]
mod metal;

pub use gl::GlContext;

#[cfg(target_vendor = "apple")]
pub use metal::MetalContext;

#[derive(Clone, Copy, Debug)]
pub enum UniformType {
    /// One 32-bit wide float (equivalent to `f32`)
    Float1,
    /// Two 32-bit wide floats (equivalent to `[f32; 2]`)
    Float2,
    /// Three 32-bit wide floats (equivalent to `[f32; 3]`)
    Float3,
    /// Four 32-bit wide floats (equivalent to `[f32; 4]`)
    Float4,
    /// One unsigned 32-bit integers (equivalent to `[u32; 1]`)
    Int1,
    /// Two unsigned 32-bit integers (equivalent to `[u32; 2]`)
    Int2,
    /// Three unsigned 32-bit integers (equivalent to `[u32; 3]`)
    Int3,
    /// Four unsigned 32-bit integers (equivalent to `[u32; 4]`)
    Int4,
    /// Four by four matrix of 32-bit floats
    Mat4,
}

impl UniformType {
    /// Byte size for a given UniformType
    pub fn size(&self) -> usize {
        match self {
            UniformType::Float1 => 4,
            UniformType::Float2 => 8,
            UniformType::Float3 => 12,
            UniformType::Float4 => 16,
            UniformType::Int1 => 4,
            UniformType::Int2 => 8,
            UniformType::Int3 => 12,
            UniformType::Int4 => 16,
            UniformType::Mat4 => 64,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UniformDesc {
    pub name: String,
    pub uniform_type: UniformType,
    pub array_count: usize,
}

#[derive(Debug, Clone)]
pub struct UniformBlockLayout {
    pub uniforms: Vec<UniformDesc>,
}

impl UniformDesc {
    pub fn new(name: &str, uniform_type: UniformType) -> UniformDesc {
        UniformDesc {
            name: name.to_string(),
            uniform_type,
            array_count: 1,
        }
    }

    pub fn array(self, array_count: usize) -> UniformDesc {
        UniformDesc {
            array_count,
            ..self
        }
    }
}

#[derive(Clone)]
pub struct ShaderMeta {
    pub uniforms: UniformBlockLayout,
    pub images: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum VertexFormat {
    /// One 32-bit wide float (equivalent to `f32`)
    Float1,
    /// Two 32-bit wide floats (equivalent to `[f32; 2]`)
    Float2,
    /// Three 32-bit wide floats (equivalent to `[f32; 3]`)
    Float3,
    /// Four 32-bit wide floats (equivalent to `[f32; 4]`)
    Float4,
    /// One unsigned 8-bit integer (equivalent to `u8`)
    Byte1,
    /// Two unsigned 8-bit integers (equivalent to `[u8; 2]`)
    Byte2,
    /// Three unsigned 8-bit integers (equivalent to `[u8; 3]`)
    Byte3,
    /// Four unsigned 8-bit integers (equivalent to `[u8; 4]`)
    Byte4,
    /// One unsigned 16-bit integer (equivalent to `u16`)
    Short1,
    /// Two unsigned 16-bit integers (equivalent to `[u16; 2]`)
    Short2,
    /// Tree unsigned 16-bit integers (equivalent to `[u16; 3]`)
    Short3,
    /// Four unsigned 16-bit integers (equivalent to `[u16; 4]`)
    Short4,
    /// One unsigned 32-bit integers (equivalent to `[u32; 1]`)
    Int1,
    /// Two unsigned 32-bit integers (equivalent to `[u32; 2]`)
    Int2,
    /// Three unsigned 32-bit integers (equivalent to `[u32; 3]`)
    Int3,
    /// Four unsigned 32-bit integers (equivalent to `[u32; 4]`)
    Int4,
    /// Four by four matrix of 32-bit floats
    Mat4,
}

impl VertexFormat {
    /// Number of components in this VertexFormat
    /// it is called size in OpenGl, but do not confuse this with bytes size
    /// basically, its an N from FloatN/IntN
    pub fn components(&self) -> i32 {
        match self {
            VertexFormat::Float1 => 1,
            VertexFormat::Float2 => 2,
            VertexFormat::Float3 => 3,
            VertexFormat::Float4 => 4,
            VertexFormat::Byte1 => 1,
            VertexFormat::Byte2 => 2,
            VertexFormat::Byte3 => 3,
            VertexFormat::Byte4 => 4,
            VertexFormat::Short1 => 1,
            VertexFormat::Short2 => 2,
            VertexFormat::Short3 => 3,
            VertexFormat::Short4 => 4,
            VertexFormat::Int1 => 1,
            VertexFormat::Int2 => 2,
            VertexFormat::Int3 => 3,
            VertexFormat::Int4 => 4,
            VertexFormat::Mat4 => 16,
        }
    }

    /// Size in bytes
    pub fn size_bytes(&self) -> i32 {
        match self {
            VertexFormat::Float1 => 1 * 4,
            VertexFormat::Float2 => 2 * 4,
            VertexFormat::Float3 => 3 * 4,
            VertexFormat::Float4 => 4 * 4,
            VertexFormat::Byte1 => 1,
            VertexFormat::Byte2 => 2,
            VertexFormat::Byte3 => 3,
            VertexFormat::Byte4 => 4,
            VertexFormat::Short1 => 1 * 2,
            VertexFormat::Short2 => 2 * 2,
            VertexFormat::Short3 => 3 * 2,
            VertexFormat::Short4 => 4 * 2,
            VertexFormat::Int1 => 1 * 4,
            VertexFormat::Int2 => 2 * 4,
            VertexFormat::Int3 => 3 * 4,
            VertexFormat::Int4 => 4 * 4,
            VertexFormat::Mat4 => 16 * 4,
        }
    }

    fn type_(&self) -> GLuint {
        match self {
            VertexFormat::Float1 => GL_FLOAT,
            VertexFormat::Float2 => GL_FLOAT,
            VertexFormat::Float3 => GL_FLOAT,
            VertexFormat::Float4 => GL_FLOAT,
            VertexFormat::Byte1 => GL_UNSIGNED_BYTE,
            VertexFormat::Byte2 => GL_UNSIGNED_BYTE,
            VertexFormat::Byte3 => GL_UNSIGNED_BYTE,
            VertexFormat::Byte4 => GL_UNSIGNED_BYTE,
            VertexFormat::Short1 => GL_UNSIGNED_SHORT,
            VertexFormat::Short2 => GL_UNSIGNED_SHORT,
            VertexFormat::Short3 => GL_UNSIGNED_SHORT,
            VertexFormat::Short4 => GL_UNSIGNED_SHORT,
            VertexFormat::Int1 => GL_UNSIGNED_INT,
            VertexFormat::Int2 => GL_UNSIGNED_INT,
            VertexFormat::Int3 => GL_UNSIGNED_INT,
            VertexFormat::Int4 => GL_UNSIGNED_INT,
            VertexFormat::Mat4 => GL_FLOAT,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum VertexStep {
    #[default]
    PerVertex,
    PerInstance,
}

#[derive(Clone, Debug)]
pub struct BufferLayout {
    pub stride: i32,
    pub step_func: VertexStep,
    pub step_rate: i32,
}

impl Default for BufferLayout {
    fn default() -> BufferLayout {
        BufferLayout {
            stride: 0,
            step_func: VertexStep::PerVertex,
            step_rate: 1,
        }
    }
}

#[derive(Clone, Debug)]
pub struct VertexAttribute {
    pub name: &'static str,
    pub format: VertexFormat,
    pub buffer_index: usize,
    /// This flag affects integer VertexFormats, Byte*, Short*, Int*
    /// Taking Byte4 as an example:
    /// On Metal, it might be received as either `float4` or `uint4`
    /// On OpenGl and `gl_pass_as_float = true` shaders should receive it as `vec4`
    /// With `gl_pass_as_float = false`, as `uvec4`
    ///
    /// Note that `uvec4` requires at least `150` glsl version
    /// Before setting `gl_pass_as_float` to false, better check `context.info().has_integer_attributes()` and double check that shaders are at least `150`
    pub gl_pass_as_float: bool,
}

impl VertexAttribute {
    pub const fn new(name: &'static str, format: VertexFormat) -> VertexAttribute {
        Self::with_buffer(name, format, 0)
    }

    pub const fn with_buffer(
        name: &'static str,
        format: VertexFormat,
        buffer_index: usize,
    ) -> VertexAttribute {
        VertexAttribute {
            name,
            format,
            buffer_index,
            gl_pass_as_float: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PipelineLayout {
    pub buffers: &'static [BufferLayout],
    pub attributes: &'static [VertexAttribute],
}

#[derive(Clone, Debug, Copy)]
pub enum ShaderType {
    Vertex,
    Fragment,
}

impl Display for ShaderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Vertex => write!(f, "Vertex"),
            Self::Fragment => write!(f, "Fragment"),
        }
    }
}

#[derive(Clone, Debug)]
pub enum ShaderError {
    CompilationError {
        shader_type: ShaderType,
        error_message: String,
    },
    LinkError(String),
    /// Shader strings should never contains \00 in the middle
    FFINulError(std::ffi::NulError),
}

impl From<std::ffi::NulError> for ShaderError {
    fn from(e: std::ffi::NulError) -> ShaderError {
        ShaderError::FFINulError(e)
    }
}

impl Display for ShaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CompilationError {
                shader_type,
                error_message,
            } => write!(f, "{shader_type} shader error:\n{error_message}"),
            Self::LinkError(msg) => write!(f, "Link shader error:\n{msg}"),
            Self::FFINulError(e) => write!(f, "{e}"),
        }
    }
}

impl Error for ShaderError {}

/// List of all the possible formats of input data when uploading to texture.
/// The list is built by intersection of texture formats supported by 3.3 core profile and webgl1.
#[repr(u8)]
#[derive(Debug, PartialEq, Eq, Clone, Copy, Hash)]
pub enum TextureFormat {
    RGB8,
    RGBA8,
    RGBA16F,
    Depth,
    Depth32,
    Alpha,
}
impl TextureFormat {
    /// Returns the size in bytes of texture with `dimensions`.
    pub fn size(self, width: u32, height: u32) -> u32 {
        let square = width * height;
        match self {
            TextureFormat::RGB8 => 3 * square,
            TextureFormat::RGBA8 => 4 * square,
            TextureFormat::RGBA16F => 8 * square,
            TextureFormat::Depth => 2 * square,
            TextureFormat::Depth32 => 4 * square,
            TextureFormat::Alpha => 1 * square,
        }
    }
}

/// Sets the wrap parameter for texture.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TextureWrap {
    /// Samples at coord x + 1 map to coord x.
    Repeat,
    /// Samples at coord x + 1 map to coord 1 - x.
    Mirror,
    /// Samples at coord x + 1 map to coord 1.
    Clamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Hash)]
pub enum FilterMode {
    Linear,
    Nearest,
}

#[derive(Clone, Copy, Debug, PartialEq, Hash)]
pub enum MipmapFilterMode {
    None,
    Linear,
    Nearest,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TextureAccess {
    /// Used as read-only from GPU
    Static,
    /// Can be written to from GPU
    RenderTarget,
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub enum TextureKind {
    Texture2D,
    CubeMap,
}

#[derive(Debug, Copy, Clone)]
pub struct TextureParams {
    pub kind: TextureKind,
    pub format: TextureFormat,
    pub wrap: TextureWrap,
    pub min_filter: FilterMode,
    pub mag_filter: FilterMode,
    pub mipmap_filter: MipmapFilterMode,
    pub width: u32,
    pub height: u32,
    // All miniquad API could work without this flag being explicit.
    // We can decide if mipmaps are required by the data provided
    // And reallocate non-mipmapped texture(on metal) on generateMipmaps call
    // But! Reallocating cubemaps is too much struggle, so leave it for later.
    pub allocate_mipmaps: bool,
    /// Only used for render textures. `sample_count > 1` allows anti-aliased render textures.
    ///
    /// On OpenGL, for a `sample_count > 1` render texture, render buffer object will
    /// be created instead of a regulat texture.
    ///
    pub sample_count: i32,
}

impl Default for TextureParams {
    fn default() -> Self {
        TextureParams {
            kind: TextureKind::Texture2D,
            format: TextureFormat::RGBA8,
            wrap: TextureWrap::Clamp,
            min_filter: FilterMode::Linear,
            mag_filter: FilterMode::Linear,
            mipmap_filter: MipmapFilterMode::None,
            width: 0,
            height: 0,
            allocate_mipmaps: false,
            sample_count: 1,
        }
    }
}

#[derive(Clone, Debug, Copy, PartialEq, Eq, Hash)]
pub struct ShaderId(usize);

// Inner hence we can't have private data in enum fields
#[derive(Clone, Debug, Copy, PartialEq, Eq, Hash)]
pub(crate) enum TextureIdInner {
    Managed(usize),
    Raw(RawId),
}

#[derive(Clone, Debug, Copy, PartialEq, Eq, Hash)]
pub struct TextureId(TextureIdInner);

impl TextureId {
    /// Wrap raw platform texture into a TextureId acceptable for miniquad
    /// Without allocating any miniquad memory and without letting miniquad
    /// manage the texture.
    ///
    /// Metal-specific note: on first use (any binding/`texture_params`/`texture_read_pixels`/
    /// `texture_raw_id`/`delete_texture` call), miniquad reads the real width, height, pixel
    /// format, and mipmap level count off the wrapped `MTLTexture` and builds its own sampler
    /// for it — this sampler is the only object miniquad owns for a raw texture. miniquad never
    /// retains or releases the wrapped `MTLTexture` itself, and `delete_texture` releases only
    /// the synthesized sampler. `texture_resize` is unsupported for a raw texture (miniquad
    /// cannot reallocate storage it does not own). See
    /// docs/adr/0024-metal-texture-format-and-raw-texture-contract.md.
    pub fn from_raw_id(raw_id: RawId) -> TextureId {
        TextureId(TextureIdInner::Raw(raw_id))
    }
}

/// Pixel arithmetic description for blending operations.
/// Will be used in an equation:
/// `equation(sfactor * source_color, dfactor * destination_color)`
/// Where source_color is the new pixel color and destination color is color from the destination buffer.
///
/// Example:
///```
///# use miniquad::{BlendState, BlendFactor, BlendValue, Equation};
///BlendState::new(
///    Equation::Add,
///    BlendFactor::Value(BlendValue::SourceAlpha),
///    BlendFactor::OneMinusValue(BlendValue::SourceAlpha)
///);
///```
/// This will be `source_color * source_color.a + destination_color * (1 - source_color.a)`
/// Wich is quite common set up for alpha blending.
#[derive(Debug, Copy, Clone, PartialEq)]
pub struct BlendState {
    equation: Equation,
    sfactor: BlendFactor,
    dfactor: BlendFactor,
}

impl BlendState {
    pub fn new(equation: Equation, sfactor: BlendFactor, dfactor: BlendFactor) -> BlendState {
        BlendState {
            equation,
            sfactor,
            dfactor,
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub struct StencilState {
    pub front: StencilFaceState,
    pub back: StencilFaceState,
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub struct StencilFaceState {
    /// Operation to use when stencil test fails
    pub fail_op: StencilOp,

    /// Operation to use when stencil test passes, but depth test fails
    pub depth_fail_op: StencilOp,

    /// Operation to use when both stencil and depth test pass,
    /// or when stencil pass and no depth or depth disabled
    pub pass_op: StencilOp,

    /// Used for stencil testing with test_ref and test_mask: if (test_ref & test_mask) *test_func* (*stencil* && test_mask)
    /// Default is Always, which means "always pass"
    pub test_func: CompareFunc,

    /// Default value: 0
    pub test_ref: i32,

    /// Default value: all 1s
    pub test_mask: u32,

    /// Specifies a bit mask to enable or disable writing of individual bits in the stencil planes
    /// Default value: all 1s
    pub write_mask: u32,
}

/// Operations performed on current stencil value when comparison test passes or fails.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum StencilOp {
    /// Default value
    Keep,
    Zero,
    Replace,
    IncrementClamp,
    DecrementClamp,
    Invert,
    IncrementWrap,
    DecrementWrap,
}

/// Depth and stencil compare function
#[derive(Debug, Copy, Clone, PartialEq)]
pub enum CompareFunc {
    /// Default value
    Always,
    Never,
    Less,
    Equal,
    LessOrEqual,
    Greater,
    NotEqual,
    GreaterOrEqual,
}

type ColorMask = (bool, bool, bool, bool);

pub enum PassAction {
    Nothing,
    Clear {
        color: Option<(f32, f32, f32, f32)>,
        depth: Option<f32>,
        stencil: Option<i32>,
    },
}

impl PassAction {
    pub fn clear_color(r: f32, g: f32, b: f32, a: f32) -> PassAction {
        PassAction::Clear {
            color: Some((r, g, b, a)),
            depth: Some(1.),
            stencil: None,
        }
    }
}

impl Default for PassAction {
    fn default() -> PassAction {
        PassAction::Clear {
            color: Some((0.0, 0.0, 0.0, 0.0)),
            depth: Some(1.),
            stencil: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderPass(usize);

pub const MAX_VERTEX_ATTRIBUTES: usize = 16;
pub const MAX_SHADERSTAGE_IMAGES: usize = 12;

#[derive(Clone, Debug)]
pub struct Features {
    pub instancing: bool,
    /// Does current rendering backend support automatic resolve of
    /// multisampled render passes on end_render_pass.
    /// Would be false on WebGl1 and GL2.
    ///
    /// With resolve_attachments: false, not-none resolve_img in new_render_pass will
    /// result in a runtime panic.
    pub resolve_attachments: bool,
}

impl Default for Features {
    fn default() -> Features {
        Features {
            instancing: true,
            resolve_attachments: true,
        }
    }
}

/// Specify whether front- or back-facing polygons can be culled.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CullFace {
    Nothing,
    Front,
    Back,
}

/// Define front- and back-facing polygons.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FrontFaceOrder {
    Clockwise,
    CounterClockwise,
}

/// A pixel-wise comparison function.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Comparison {
    Never,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    Equal,
    NotEqual,
    Always,
}

impl From<Comparison> for GLenum {
    fn from(cmp: Comparison) -> Self {
        match cmp {
            Comparison::Never => GL_NEVER,
            Comparison::Less => GL_LESS,
            Comparison::LessOrEqual => GL_LEQUAL,
            Comparison::Greater => GL_GREATER,
            Comparison::GreaterOrEqual => GL_GEQUAL,
            Comparison::Equal => GL_EQUAL,
            Comparison::NotEqual => GL_NOTEQUAL,
            Comparison::Always => GL_ALWAYS,
        }
    }
}

/// Specifies how incoming RGBA values (source) and the RGBA in framebuffer (destination)
/// are combined.
#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub enum Equation {
    /// Adds source and destination. Source and destination are multiplied
    /// by blending parameters before addition.
    #[default]
    Add,
    /// Subtracts destination from source. Source and destination are
    /// multiplied by blending parameters before subtraction.
    Subtract,
    /// Subtracts source from destination. Source and destination are
    /// multiplied by blending parameters before subtraction.
    ReverseSubtract,
}

/// Blend values.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BlendValue {
    SourceColor,
    SourceAlpha,
    DestinationColor,
    DestinationAlpha,
}

/// Blend factors.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BlendFactor {
    Zero,
    One,
    Value(BlendValue),
    OneMinusValue(BlendValue),
    SourceAlphaSaturate,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum PrimitiveType {
    Triangles,
    Lines,
    Points,
}

impl From<PrimitiveType> for GLenum {
    fn from(primitive_type: PrimitiveType) -> Self {
        match primitive_type {
            PrimitiveType::Triangles => GL_TRIANGLES,
            PrimitiveType::Lines => GL_LINES,
            PrimitiveType::Points => GL_POINTS,
        }
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct PipelineParams {
    pub cull_face: CullFace,
    pub front_face_order: FrontFaceOrder,
    pub depth_test: Comparison,
    pub depth_write: bool,
    pub depth_write_offset: Option<(f32, f32)>,
    /// Color (RGB) blend function. If None - blending will be disabled for this pipeline.
    /// Usual use case to get alpha-blending:
    ///```
    ///# use miniquad::{PipelineParams, BlendState, BlendValue, BlendFactor, Equation};
    ///PipelineParams {
    ///    color_blend: Some(BlendState::new(
    ///        Equation::Add,
    ///        BlendFactor::Value(BlendValue::SourceAlpha),
    ///        BlendFactor::OneMinusValue(BlendValue::SourceAlpha))
    ///    ),
    ///    ..Default::default()
    ///};
    ///```
    pub color_blend: Option<BlendState>,
    /// Alpha blend function. If None - alpha will be blended with same equation than RGB colors.
    /// One of possible separate alpha channel blend settings is to avoid blending with WebGl background.
    /// On webgl canvas's resulting alpha channel will be used to blend the whole canvas background.
    /// To avoid modifying only alpha channel, but keep usual transparency:
    ///```
    ///# use miniquad::{PipelineParams, BlendState, BlendValue, BlendFactor, Equation};
    ///PipelineParams {
    ///    color_blend: Some(BlendState::new(
    ///        Equation::Add,
    ///        BlendFactor::Value(BlendValue::SourceAlpha),
    ///        BlendFactor::OneMinusValue(BlendValue::SourceAlpha))
    ///    ),
    ///    alpha_blend: Some(BlendState::new(
    ///        Equation::Add,
    ///        BlendFactor::Zero,
    ///        BlendFactor::One)
    ///    ),
    ///    ..Default::default()
    ///};
    ///```
    /// The same results may be achieved with ColorMask(true, true, true, false)
    pub alpha_blend: Option<BlendState>,
    pub stencil_test: Option<StencilState>,
    pub color_write: ColorMask,
    pub primitive_type: PrimitiveType,
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub struct Pipeline(usize);

impl Default for PipelineParams {
    fn default() -> PipelineParams {
        PipelineParams {
            cull_face: CullFace::Nothing,
            front_face_order: FrontFaceOrder::CounterClockwise,
            depth_test: Comparison::Always, // no depth test,
            depth_write: false,             // no depth write,
            depth_write_offset: None,
            color_blend: None,
            alpha_blend: None,
            stencil_test: None,
            color_write: (true, true, true, true),
            primitive_type: PrimitiveType::Triangles,
        }
    }
}

/// Geometry bindings
#[derive(Clone, Debug)]
pub struct Bindings {
    /// Vertex buffers. Data contained in the buffer must match layout
    /// specified in the `Pipeline`.
    ///
    /// Most commonly vertex buffer will contain `(x,y,z,w)` coordinates of the
    /// vertex in 3d space, as well as `(u,v)` coordinates that map the vertex
    /// to some position in the corresponding `Texture`.
    pub vertex_buffers: Vec<BufferId>,
    /// Index buffer which instructs the GPU in which order to draw vertices
    /// from a vertex buffer, with each subsequent 3 indices forming a
    /// triangle.
    pub index_buffer: BufferId,
    /// Textures to be used with when drawing the geometry in the fragment
    /// shader.
    pub images: Vec<TextureId>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BufferType {
    VertexBuffer,
    IndexBuffer,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BufferUsage {
    Immutable,
    Dynamic,
    Stream,
}

fn gl_buffer_target(buffer_type: &BufferType) -> GLenum {
    match buffer_type {
        BufferType::VertexBuffer => GL_ARRAY_BUFFER,
        BufferType::IndexBuffer => GL_ELEMENT_ARRAY_BUFFER,
    }
}

fn gl_usage(usage: &BufferUsage) -> GLenum {
    match usage {
        BufferUsage::Immutable => GL_STATIC_DRAW,
        BufferUsage::Dynamic => GL_DYNAMIC_DRAW,
        BufferUsage::Stream => GL_STREAM_DRAW,
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
pub struct BufferId(usize);

/// Why an [`ElapsedQuery`] read did not give a measured value.
///
/// `ElapsedQuery` never returns a success-shaped `0` or `false` for an
/// unsupported, pending, or disjoint query. Use this type to find out why a
/// read did not give a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElapsedQueryError {
    /// The active [`Backend`], WebGL version, or browser extension set
    /// gives no verified GPU timer-query path in this release.
    /// [`ElapsedQuery::is_supported`] reports this state in advance.
    Unsupported,
    /// `end_query` ran, but the GPU has not finished the query yet. Poll
    /// [`ElapsedQuery::is_available`] again before reading a result.
    NotReady,
    /// The GPU clock changed while the query was running (for example, a
    /// power-state change). The browser's `GPU_DISJOINT_EXT` flag reported
    /// this; discard the query and run a new one instead of trusting its
    /// timing.
    Disjoint,
}

/// Measures the duration of GPU operations between `begin_query` and
/// `end_query`.
///
/// This release gives a real, verified measurement only on a WebGL2
/// context where the browser grants the `EXT_disjoint_timer_query_webgl2`
/// extension. [`ElapsedQuery::is_supported`] reports the state of the
/// active [`Backend`] first; native OpenGL, Metal, WebGL1, and a WebGL2
/// context without the extension are explicit unsupported states. No
/// method returns a `0` or `false` placeholder for an unsupported,
/// pending, or disjoint query; see [`ElapsedQueryError`].
///
/// See [MADR 0023](https://github.com/Tigon32/miniquad/blob/master/docs/adr/0023-webgl2-gpu-timer-query.md),
/// which supersedes [MADR 0021](https://github.com/Tigon32/miniquad/blob/master/docs/adr/0021-deprecate-unverified-elapsed-query.md),
/// and [issue #145](https://github.com/Tigon32/miniquad/issues/145).
///
/// ```
/// use miniquad::graphics::{Backend, ElapsedQuery};
/// // Native OpenGL has no verified timer-query path in this release.
/// assert!(!ElapsedQuery::is_supported(Backend::OpenGl));
/// // Metal never loads a GL timer-query entry point.
/// assert!(!ElapsedQuery::is_supported(Backend::Metal));
/// ```
///
/// ```should_panic
/// # use miniquad::graphics::{Backend, ElapsedQuery};
/// let mut query = ElapsedQuery::new();
/// query.begin_query(Backend::Metal);
/// ```
#[derive(Clone, Copy)]
pub struct ElapsedQuery {
    gl_query: GLuint,
}

impl Default for ElapsedQuery {
    fn default() -> Self {
        Self::new()
    }
}

impl ElapsedQuery {
    pub fn new() -> ElapsedQuery {
        ElapsedQuery { gl_query: 0 }
    }

    /// Reports whether `backend` gives a real GPU timer-query measurement.
    ///
    /// Never panics and never calls an unloaded GL function pointer.
    /// Native OpenGL and Metal always return `false`: this release scopes
    /// the verified timer-query path to WebGL2 (issue #145). On WebGL this
    /// probes the browser with the WebGL2 `EXT_disjoint_timer_query_webgl2`
    /// feature-detection call; it returns `true` only on a WebGL2 context
    /// where the browser grants that extension.
    pub fn is_supported(backend: Backend) -> bool {
        match backend {
            Backend::Metal => false,
            Backend::OpenGl => unsafe { crate::native::gl::gpu_timer_query_supported() },
        }
    }

    /// Starts measuring elapsed GPU time.
    ///
    /// # Panics
    ///
    /// Panics if `ElapsedQuery::is_supported(backend)` is `false`. Check it
    /// first; a caller that does so never reaches this panic.
    pub fn begin_query(&mut self, backend: Backend) {
        assert!(
            Self::is_supported(backend),
            "ElapsedQuery is unsupported on this backend; check ElapsedQuery::is_supported() first"
        );
        unsafe {
            if self.gl_query == 0 {
                glGenQueries(1, &mut self.gl_query as *mut _);
            }
            glBeginQuery(GL_TIME_ELAPSED, self.gl_query);
        }
    }

    /// Stops measuring elapsed GPU time.
    ///
    /// # Panics
    ///
    /// Panics if `ElapsedQuery::is_supported(backend)` is `false`.
    pub fn end_query(&mut self, backend: Backend) {
        assert!(
            Self::is_supported(backend),
            "ElapsedQuery is unsupported on this backend; check ElapsedQuery::is_supported() first"
        );
        unsafe { glEndQuery(GL_TIME_ELAPSED) };
    }

    /// Reports whether the query has a measured result ready to read.
    ///
    /// Returns [`ElapsedQueryError::Unsupported`] instead of a placeholder
    /// `false` when `backend` has no timer-query path. Returns
    /// [`ElapsedQueryError::Disjoint`] when the browser reports that the
    /// GPU clock changed while the query ran; discard this query.
    pub fn is_available(&self, backend: Backend) -> Result<bool, ElapsedQueryError> {
        if !Self::is_supported(backend) {
            return Err(ElapsedQueryError::Unsupported);
        }
        let mut available: GLint = 0;
        unsafe { glGetQueryObjectiv(self.gl_query, GL_QUERY_RESULT_AVAILABLE, &mut available) };
        if available == 0 {
            // The disjoint flag is read-and-cleared; read it only once the
            // result exists, not on every "not ready yet" poll.
            return Ok(false);
        }
        if unsafe { crate::native::gl::gpu_timer_query_disjoint() } {
            return Err(ElapsedQueryError::Disjoint);
        }
        Ok(true)
    }

    /// Reads the measured GPU time, in nanoseconds.
    ///
    /// Returns [`ElapsedQueryError::Unsupported`] for a backend with no
    /// timer-query path, [`ElapsedQueryError::NotReady`] when the query has
    /// not finished, and [`ElapsedQueryError::Disjoint`] when the GPU clock
    /// changed during the query. None of these states give a `0`
    /// placeholder; a real zero-length query still gives `Ok(0)`.
    pub fn get_result(&self, backend: Backend) -> Result<u64, ElapsedQueryError> {
        match self.is_available(backend) {
            Ok(true) => {}
            Ok(false) => return Err(ElapsedQueryError::NotReady),
            Err(error) => return Err(error),
        }
        let mut result: GLuint64 = 0;
        unsafe { glGetQueryObjectui64v(self.gl_query, GL_QUERY_RESULT, &mut result) };
        Ok(result)
    }

    /// Releases the underlying GPU query object.
    ///
    /// # Panics
    ///
    /// Panics if `ElapsedQuery::is_supported(backend)` is `false`.
    pub fn delete(&mut self, backend: Backend) {
        assert!(
            Self::is_supported(backend),
            "ElapsedQuery is unsupported on this backend; check ElapsedQuery::is_supported() first"
        );
        if self.gl_query != 0 {
            unsafe { glDeleteQueries(1, &self.gl_query as *const _) };
            self.gl_query = 0;
        }
    }
}

/// A vtable-erased generic argument.
/// Basically, the same thing as `fn f<U>(a: &U)`, but
/// trait-object friendly.
pub struct Arg<'a> {
    ptr: *const std::ffi::c_void,
    element_size: usize,
    size: usize,
    is_slice: bool,
    _phantom: std::marker::PhantomData<&'a ()>,
}

pub enum TextureSource<'a> {
    Empty,
    Bytes(&'a [u8]),
    /// Array of `[cubemap_face][mipmap_level][bytes]`
    Array(&'a [&'a [&'a [u8]]]),
}

pub enum BufferSource<'a> {
    Slice(Arg<'a>),
    Empty { size: usize, element_size: usize },
}
impl<'a> BufferSource<'a> {
    /// Empty buffer of `size * size_of::<T>` bytes
    ///
    /// Platform specific note, OpenGL:
    /// For VertexBuffer T could be anything, it is only used to calculate total size,
    /// but for IndexBuffers T should be either u8, u16 or u32, other
    /// types are not supported.
    ///
    /// For vertex buffers it is OK to use `empty::<u8>(byte_size);`
    pub fn empty<T>(size: usize) -> BufferSource<'a> {
        let element_size = std::mem::size_of::<T>();
        BufferSource::Empty {
            size: size * std::mem::size_of::<T>(),
            element_size,
        }
    }

    pub fn slice<T>(data: &'a [T]) -> BufferSource<'a> {
        BufferSource::Slice(Arg {
            ptr: data.as_ptr() as _,
            size: std::mem::size_of_val(data),
            element_size: std::mem::size_of::<T>(),
            is_slice: true,
            _phantom: std::marker::PhantomData,
        })
    }

    pub unsafe fn pointer(ptr: *const u8, size: usize, element_size: usize) -> BufferSource<'a> {
        BufferSource::Slice(Arg {
            ptr: ptr as _,
            size,
            element_size,
            is_slice: true,
            _phantom: std::marker::PhantomData,
        })
    }
}

pub struct UniformsSource<'a>(Arg<'a>);
impl<'a> UniformsSource<'a> {
    pub fn table<T>(data: &'a T) -> UniformsSource<'a> {
        Self(Arg {
            ptr: data as *const T as _,
            size: std::mem::size_of_val(data),
            element_size: std::mem::size_of::<T>(),
            is_slice: false,
            _phantom: std::marker::PhantomData,
        })
    }
}

#[derive(Debug)]
pub enum ShaderSource<'a> {
    Glsl { vertex: &'a str, fragment: &'a str },
    Msl { program: &'a str },
}

#[derive(Debug, Clone, Copy, PartialEq, Hash, Eq)]
pub enum RawId {
    OpenGl(crate::native::gl::GLuint),
    #[cfg(target_vendor = "apple")]
    Metal(*mut objc::runtime::Object),
}
unsafe impl Send for RawId {}
unsafe impl Sync for RawId {}

#[derive(Clone, Debug, Default)]
pub struct GlslSupport {
    pub v130: bool,
    pub v150: bool,
    pub v330: bool,
    pub v300es: bool,
    pub v100_ext: bool,
    pub v100: bool,
}

#[derive(PartialEq, Clone, Copy, Debug)]
pub enum Backend {
    Metal,
    OpenGl,
}

#[derive(Clone, Debug)]
pub struct ContextInfo {
    pub backend: Backend,
    /// GL_VERSION_STRING from OpenGL. Would be empty on metal.
    pub gl_version_string: String,
    /// OpenGL provides an enumeration over GL_SHADING_LANGUAGE_VERSION,
    /// allowing to see which glsl versions are actually supported.
    /// Unfortunately, it only works on GL4.3+... and even there it is not quite correct.
    ///
    /// miniquad will take a guess based on GL_VERSION_STRING, current platform and implementation
    /// details. Would be all false on metal.
    pub glsl_support: GlslSupport,
    /// List of platform-dependent features that miniquad failed to make cross-platforms
    /// and therefore they might be missing.
    pub features: Features,
}

impl ContextInfo {
    pub fn has_integer_attributes(&self) -> bool {
        match self.backend {
            Backend::Metal => true,
            Backend::OpenGl => {
                self.glsl_support.v150 | self.glsl_support.v300es | self.glsl_support.v330
            }
        }
    }
}

pub trait RenderingBackend {
    fn info(&self) -> ContextInfo;
    /// For metal context's ShaderSource should contain MSL source string, for GL - glsl.
    ///
    /// If in doubt, _most_ OpenGL contexts support "#version 100" glsl shaders.
    /// So far miniquad never encountered where it can create a rendering context,
    /// but `version 100` shaders are not supported.
    ///
    /// Typical `new_shader` invocation for an MSL and `glsl version 100` sources:
    /// ```ignore
    /// let source = match ctx.info().backend {
    ///    Backend::OpenGl => ShaderSource::Glsl {
    ///        vertex: display_shader::VERTEX,
    ///        fragment: display_shader::FRAGMENT,
    ///    },
    ///    Backend::Metal => ShaderSource::Msl {
    ///        program: display_shader::METAL
    ///    },
    /// };
    /// let shader = ctx.new_shader(source, display_shader::meta()).unwrap();
    /// ```
    /// Or just
    /// ```ignore
    /// let shader = ctx.new_shader(ShaderSource::Glsl {...}, ...);
    /// ```
    /// for GL-only.
    fn new_shader(
        &mut self,
        shader: ShaderSource,
        meta: ShaderMeta,
    ) -> Result<ShaderId, ShaderError>;
    fn new_texture(
        &mut self,
        access: TextureAccess,
        data: TextureSource,
        params: TextureParams,
    ) -> TextureId;
    fn new_render_texture(&mut self, params: TextureParams) -> TextureId {
        self.new_texture(TextureAccess::RenderTarget, TextureSource::Empty, params)
    }
    fn new_texture_from_data_and_format(
        &mut self,
        bytes: &[u8],
        params: TextureParams,
    ) -> TextureId {
        self.new_texture(TextureAccess::Static, TextureSource::Bytes(bytes), params)
    }
    fn new_texture_from_rgba8(&mut self, width: u16, height: u16, bytes: &[u8]) -> TextureId {
        assert_eq!(width as usize * height as usize * 4, bytes.len());

        self.new_texture_from_data_and_format(
            bytes,
            TextureParams {
                kind: TextureKind::Texture2D,
                width: width as _,
                height: height as _,
                format: TextureFormat::RGBA8,
                wrap: TextureWrap::Clamp,
                min_filter: FilterMode::Linear,
                mag_filter: FilterMode::Linear,
                mipmap_filter: MipmapFilterMode::None,
                allocate_mipmaps: false,
                sample_count: 1,
            },
        )
    }
    fn texture_params(&self, texture: TextureId) -> TextureParams;
    fn texture_size(&self, texture: TextureId) -> (u32, u32) {
        let params = self.texture_params(texture);
        (params.width, params.height)
    }

    /// Get OpenGL's GLuint texture ID or metals ObjcId
    ///
    /// Metal-specific note: for a texture wrapped with `TextureId::from_raw_id`, this returns
    /// the same caller-owned `MTLTexture` pointer unchanged (miniquad never substitutes its own
    /// object here). See `TextureId::from_raw_id`'s ownership note.
    unsafe fn texture_raw_id(&self, texture: TextureId) -> RawId;

    /// Update whole texture content
    /// bytes should be width * height * 4 size - non rgba8 textures are not supported yet anyway
    fn texture_update(&mut self, texture: TextureId, bytes: &[u8]) {
        let (width, height) = self.texture_size(texture);
        self.texture_update_part(texture, 0 as _, 0 as _, width as _, height as _, bytes)
    }
    fn texture_set_filter(
        &mut self,
        texture: TextureId,
        filter: FilterMode,
        mipmap_filter: MipmapFilterMode,
    ) {
        self.texture_set_min_filter(texture, filter, mipmap_filter);
        self.texture_set_mag_filter(texture, filter);
    }
    fn texture_set_min_filter(
        &mut self,
        texture: TextureId,
        filter: FilterMode,
        mipmap_filter: MipmapFilterMode,
    );
    fn texture_set_mag_filter(&mut self, texture: TextureId, filter: FilterMode);
    fn texture_set_wrap(&mut self, texture: TextureId, wrap_x: TextureWrap, wrap_y: TextureWrap);
    /// Metal-specific note: panics if the texture was created without
    /// `params.allocate_mipmaps`.
    ///
    /// Also note that if MipmapFilter is set to None, mipmaps will not be visible, even if
    /// generated.
    fn texture_generate_mipmaps(&mut self, texture: TextureId);
    /// Reports whether [`RenderingBackend::texture_resize`] can be called for `texture`
    /// without panicking. Callers that may run on Metal and accept a texture from elsewhere
    /// should check this before calling `texture_resize` rather than relying on the panic.
    ///
    /// Default: always `true`.
    ///
    /// Metal-specific note: returns `false` for a texture wrapped with
    /// `TextureId::from_raw_id` (miniquad does not own that storage) and for a texture whose
    /// format is `TextureFormat::Depth` (see
    /// docs/adr/0024-metal-texture-format-and-raw-texture-contract.md).
    fn texture_supports_resize(&self, texture: TextureId) -> bool {
        let _ = texture;
        true
    }
    /// Reallocates the texture's backing storage at the new dimensions, optionally re-uploading
    /// `bytes` (same per-pixel contract as `new_texture`: `format.size(width, height)` bytes).
    ///
    /// Use [`RenderingBackend::texture_supports_resize`] to check in advance whether this call
    /// is supported for `texture` instead of relying on the panic below.
    ///
    /// Metal-specific note: panics for a texture wrapped with `TextureId::from_raw_id` — Metal
    /// does not own the caller's texture and cannot reallocate it — and for
    /// `TextureFormat::Depth` (see `texture_read_pixels`'s note on that format).
    fn texture_resize(&mut self, texture: TextureId, width: u32, height: u32, bytes: Option<&[u8]>);
    /// Reports whether [`RenderingBackend::texture_read_pixels`] can be called for `texture`
    /// without panicking. Callers that may run on Metal and accept a texture from elsewhere
    /// should check this before calling `texture_read_pixels` rather than relying on the panic.
    ///
    /// Default: always `true`.
    ///
    /// Metal-specific note: returns `false` for a texture whose format is
    /// `TextureFormat::Depth` (see
    /// docs/adr/0024-metal-texture-format-and-raw-texture-contract.md).
    fn texture_supports_read_pixels(&self, texture: TextureId) -> bool {
        let _ = texture;
        true
    }
    /// Reads the texture's pixels into `bytes`, which must be exactly
    /// `format.size(width, height)` bytes — the same per-pixel contract as `new_texture`.
    ///
    /// Use [`RenderingBackend::texture_supports_read_pixels`] to check in advance whether this
    /// call is supported for `texture` instead of relying on the panic below.
    ///
    /// Metal-specific note: panics for `TextureFormat::Depth`. Metal has no pixel format whose
    /// CPU-visible storage matches `TextureFormat::Depth`'s documented 2 bytes/pixel (Metal's
    /// combined depth/stencil format is used instead); use `TextureFormat::Depth32` for a depth
    /// texture that supports read-back.
    fn texture_read_pixels(&mut self, texture: TextureId, bytes: &mut [u8]);
    fn texture_update_part(
        &mut self,
        texture: TextureId,
        x_offset: i32,
        y_offset: i32,
        width: i32,
        height: i32,
        bytes: &[u8],
    );
    fn new_render_pass(
        &mut self,
        color_img: TextureId,
        depth_img: Option<TextureId>,
    ) -> RenderPass {
        self.new_render_pass_mrt(&[color_img], None, depth_img)
    }
    /// Same as "new_render_pass", but allows multiple color attachments.
    /// if `resolve_img` is set, MSAA-resolve operation will happen in `end_render_pass`
    /// this operation require `color_img` to have sample_count > 1,resolve_img have
    /// sample_count == 1, and color_img.len() should be equal to resolve_img.len()
    ///
    /// Note that resolve attachments may be not supported by current backend!
    /// They are only available when `ctx.info().features.resolve_attachments` is true.
    fn new_render_pass_mrt(
        &mut self,
        color_img: &[TextureId],
        resolve_img: Option<&[TextureId]>,
        depth_img: Option<TextureId>,
    ) -> RenderPass;
    /// panics for depth-only or multiple color attachment render pass
    /// This function is, mostly, legacy. Using "render_pass_color_attachments"
    /// is recommended instead.
    fn render_pass_texture(&self, render_pass: RenderPass) -> TextureId {
        let textures = self.render_pass_color_attachments(render_pass);
        #[allow(clippy::len_zero)]
        if textures.len() == 0 {
            panic!("depth-only render pass");
        }
        if textures.len() != 1 {
            panic!("multiple render target render pass");
        }
        textures[0]
    }
    /// For depth-only render pass returns empty slice.
    fn render_pass_color_attachments(&self, render_pass: RenderPass) -> &[TextureId];
    fn delete_render_pass(&mut self, render_pass: RenderPass);
    fn new_pipeline(
        &mut self,
        buffer_layout: &[BufferLayout],
        attributes: &[VertexAttribute],
        shader: ShaderId,
        params: PipelineParams,
    ) -> Pipeline;
    fn apply_pipeline(&mut self, pipeline: &Pipeline);
    fn delete_pipeline(&mut self, pipeline: Pipeline);

    /// Create a buffer resource object.
    /// ```ignore
    /// #[repr(C)]
    /// struct Vertex {
    ///     pos: Vec2,
    ///     uv: Vec2,
    /// }
    /// let vertices: [Vertex; 4] = [
    ///     Vertex { pos : Vec2 { x: -0.5, y: -0.5 }, uv: Vec2 { x: 0., y: 0. } },
    ///     Vertex { pos : Vec2 { x:  0.5, y: -0.5 }, uv: Vec2 { x: 1., y: 0. } },
    ///     Vertex { pos : Vec2 { x:  0.5, y:  0.5 }, uv: Vec2 { x: 1., y: 1. } },
    ///     Vertex { pos : Vec2 { x: -0.5, y:  0.5 }, uv: Vec2 { x: 0., y: 1. } },
    /// ];
    ///    let buffer = ctx.new_buffer(
    ///        BufferType::VertexBuffer,
    ///        BufferUsage::Immutable,
    ///        BufferSource::slice(&vertices),
    ///    );
    /// ```
    fn new_buffer(&mut self, type_: BufferType, usage: BufferUsage, data: BufferSource)
        -> BufferId;
    /// Replace the buffer's contents with `data`, which can be shorter than
    /// the buffer: what lies past it is undefined afterwards.
    fn buffer_update(&mut self, buffer: BufferId, data: BufferSource);

    /// Size of buffer in bytes.
    /// For 1 element, u16 buffer this will return 2.
    fn buffer_size(&mut self, buffer: BufferId) -> usize;

    /// Delete GPU buffer, leaving handle unmodified.
    ///
    /// More high-level code on top of miniquad probably is going to call this in Drop
    /// implementation of some more RAII buffer object.
    ///
    /// There is no protection against using deleted buffers later. However its not an UB in OpenGl
    /// and thats why this function is not marked as unsafe
    fn delete_buffer(&mut self, buffer: BufferId);

    /// Delete GPU texture, leaving handle unmodified.
    ///
    /// More high-level code on top of miniquad probably is going to call this in Drop
    /// implementation of some more RAII buffer object.
    ///
    /// There is no protection against using deleted textures later. However its not a CPU-level UB
    /// and thats why this function is not marked as unsafe
    fn delete_texture(&mut self, texture: TextureId);

    /// Delete GPU program, leaving handle unmodified.
    ///
    /// More high-level code on top of miniquad probably is going to call this in Drop
    /// implementation of some more RAII buffer object.
    ///
    /// There is no protection against using deleted programs later. However its not a CPU-level
    /// Porgram and thats why this function is not marked as unsafe
    fn delete_shader(&mut self, program: ShaderId);

    /// Set a new viewport rectangle.
    /// Should be applied after begin_pass.
    fn apply_viewport(&mut self, x: i32, y: i32, w: i32, h: i32);

    /// Set a new scissor rectangle.
    /// Should be applied after begin_pass.
    fn apply_scissor_rect(&mut self, x: i32, y: i32, w: i32, h: i32);

    fn apply_bindings_from_slice(
        &mut self,
        vertex_buffers: &[BufferId],
        index_buffer: BufferId,
        textures: &[TextureId],
    );

    fn apply_bindings(&mut self, bindings: &Bindings) {
        self.apply_bindings_from_slice(
            &bindings.vertex_buffers,
            bindings.index_buffer,
            &bindings.images,
        );
    }

    fn apply_uniforms(&mut self, uniforms: UniformsSource) {
        self.apply_uniforms_from_bytes(uniforms.0.ptr as _, uniforms.0.size)
    }
    fn apply_uniforms_from_bytes(&mut self, uniform_ptr: *const u8, size: usize);

    fn clear(
        &mut self,
        color: Option<(f32, f32, f32, f32)>,
        depth: Option<f32>,
        stencil: Option<i32>,
    );
    /// start rendering to the default frame buffer
    fn begin_default_pass(&mut self, action: PassAction);
    /// start rendering to an offscreen framebuffer
    fn begin_pass(&mut self, pass: Option<RenderPass>, action: PassAction);

    fn end_render_pass(&mut self);

    fn commit_frame(&mut self);

    /// Draw elements using currently applied bindings and pipeline.
    ///
    /// + `base_element` specifies starting offset in `index_buffer`.
    /// + `num_elements` specifies length of the slice of `index_buffer` to draw.
    /// + `num_instances` specifies how many instances should be rendered.
    ///
    /// NOTE: num_instances > 1 might be not supported by the GPU (gl2.1 and gles2).
    /// `features.instancing` check is required.
    fn draw(&self, base_element: i32, num_elements: i32, num_instances: i32);
}

#[cfg(test)]
mod elapsed_query_tests {
    use super::{Backend, ElapsedQuery, ElapsedQueryError};
    use std::panic::catch_unwind;

    #[test]
    fn native_opengl_and_metal_report_unsupported_without_a_panic() {
        // These run on the host (native) build, never the WebGL2 path, so
        // both backends must report unsupported deterministically.
        assert!(!ElapsedQuery::is_supported(Backend::OpenGl));
        assert!(!ElapsedQuery::is_supported(Backend::Metal));
    }

    #[test]
    fn unsupported_backend_reports_a_typed_error_not_a_placeholder_value() {
        let query = ElapsedQuery::new();
        assert_eq!(
            query.is_available(Backend::Metal),
            Err(ElapsedQueryError::Unsupported)
        );
        assert_eq!(
            query.get_result(Backend::Metal),
            Err(ElapsedQueryError::Unsupported)
        );
        assert_eq!(
            query.is_available(Backend::OpenGl),
            Err(ElapsedQueryError::Unsupported)
        );
        assert_eq!(
            query.get_result(Backend::OpenGl),
            Err(ElapsedQueryError::Unsupported)
        );
    }

    #[test]
    fn lifecycle_calls_on_an_unsupported_backend_panic_instead_of_touching_gl_pointers() {
        assert!(catch_unwind(|| ElapsedQuery::new().begin_query(Backend::Metal)).is_err());
        assert!(catch_unwind(|| ElapsedQuery::new().end_query(Backend::Metal)).is_err());
        assert!(catch_unwind(|| ElapsedQuery::new().delete(Backend::Metal)).is_err());
        assert!(catch_unwind(|| ElapsedQuery::new().begin_query(Backend::OpenGl)).is_err());
        assert!(catch_unwind(|| ElapsedQuery::new().end_query(Backend::OpenGl)).is_err());
        assert!(catch_unwind(|| ElapsedQuery::new().delete(Backend::OpenGl)).is_err());
    }
}
