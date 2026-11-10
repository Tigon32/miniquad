//! The GPU adapter: the only part of this crate that touches
//! `miniquad::RenderingBackend`.
//!
//! [`Renderer`] owns its shader, pipeline, and dynamic vertex/index
//! buffers, and grows them on demand. Call [`Renderer::destroy`] when the
//! renderer is no longer needed; it is not dropped automatically, because
//! `RenderingBackend` resource deletion needs `&mut dyn RenderingBackend`
//! (see the miniquad `delete_buffer`/`delete_pipeline`/`delete_shader`
//! docs, which note the same RAII-in-the-caller pattern).

use miniquad::{
    Backend, BlendFactor, BlendState, BlendValue, BufferId, BufferSource, BufferType, BufferUsage,
    Equation, Pipeline, PipelineParams, RenderingBackend, ShaderId, ShaderMeta, ShaderSource,
    UniformBlockLayout, UniformDesc, UniformType, UniformsSource, VertexAttribute, VertexFormat,
};

use crate::batch::Batch;
use crate::geometry::Rect;

/// Premultiplied-alpha color blending, with the framebuffer alpha channel
/// left untouched by draws. This keeps the WASM canvas from compositing
/// incorrectly against the host page background; see
/// `docs/drawing-companion.md`.
fn blend_params() -> PipelineParams {
    PipelineParams {
        color_blend: Some(BlendState::new(
            Equation::Add,
            BlendFactor::One,
            BlendFactor::OneMinusValue(BlendValue::SourceAlpha),
        )),
        alpha_blend: Some(BlendState::new(
            Equation::Add,
            BlendFactor::Zero,
            BlendFactor::One,
        )),
        ..Default::default()
    }
}

struct GrowBuffer {
    id: BufferId,
    buffer_type: BufferType,
    capacity_items: usize,
}

impl GrowBuffer {
    fn new(ctx: &mut dyn RenderingBackend, buffer_type: BufferType, initial_items: usize) -> Self {
        let id = match buffer_type {
            BufferType::VertexBuffer => ctx.new_buffer(
                buffer_type,
                BufferUsage::Stream,
                BufferSource::empty::<crate::geometry::Vertex>(initial_items),
            ),
            BufferType::IndexBuffer => ctx.new_buffer(
                buffer_type,
                BufferUsage::Stream,
                BufferSource::empty::<u32>(initial_items),
            ),
        };
        GrowBuffer {
            id,
            buffer_type,
            capacity_items: initial_items,
        }
    }

    /// Upload `data`, replacing the buffer with a larger one first if
    /// `data` does not fit in the current capacity.
    fn upload<T>(&mut self, ctx: &mut dyn RenderingBackend, data: &[T]) {
        if data.len() > self.capacity_items {
            ctx.delete_buffer(self.id);
            let new_capacity = data.len().next_power_of_two().max(64);
            self.id = ctx.new_buffer(
                self.buffer_type,
                BufferUsage::Stream,
                BufferSource::empty::<T>(new_capacity),
            );
            self.capacity_items = new_capacity;
        }
        ctx.buffer_update(self.id, BufferSource::slice(data));
    }
}

/// Uniform block uploaded once per draw call: an orthographic projection
/// from top-left-origin, Y-down logical pixels to clip space.
#[repr(C)]
struct Uniforms {
    /// `[2/width, 2/height]`
    scale: [f32; 2],
}

fn shader_meta() -> ShaderMeta {
    ShaderMeta {
        images: vec![],
        uniforms: UniformBlockLayout {
            uniforms: vec![UniformDesc::new("scale", UniformType::Float2)],
        },
    }
}

const VERTEX_GLSL: &str = r#"#version 100
attribute vec2 in_pos;
attribute vec4 in_color;

uniform vec2 scale;

varying lowp vec4 color;

void main() {
    // Top-left-origin, Y-down logical pixels -> clip space.
    float x = in_pos.x * scale.x - 1.0;
    float y = 1.0 - in_pos.y * scale.y;
    gl_Position = vec4(x, y, 0.0, 1.0);
    color = in_color;
}
"#;

const FRAGMENT_GLSL: &str = r#"#version 100
varying lowp vec4 color;

void main() {
    gl_FragColor = color;
}
"#;

const METAL_SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float2 scale;
};

struct Vertex {
    float2 in_pos   [[attribute(0)]];
    float4 in_color [[attribute(1)]];
};

struct RasterizerData {
    float4 position [[position]];
    float4 color [[user(locn0)]];
};

vertex RasterizerData vertexShader(Vertex v [[stage_in]], constant Uniforms& uniforms [[buffer(0)]]) {
    RasterizerData out;
    float x = v.in_pos.x * uniforms.scale.x - 1.0;
    float y = 1.0 - v.in_pos.y * uniforms.scale.y;
    out.position = float4(x, y, 0.0, 1.0);
    out.color = v.in_color;
    return out;
}

fragment float4 fragmentShader(RasterizerData in [[stage_in]]) {
    return in.color;
}
"#;

/// Owns the GPU resources that draw a [`Batch`]. See the module docs for
/// the destroy contract.
pub struct Renderer {
    pipeline: Pipeline,
    shader: ShaderId,
    vertex_buffer: GrowBuffer,
    index_buffer: GrowBuffer,
}

impl Renderer {
    pub fn new(ctx: &mut dyn RenderingBackend) -> Renderer {
        let shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: VERTEX_GLSL,
                        fragment: FRAGMENT_GLSL,
                    },
                    Backend::Metal => ShaderSource::Msl {
                        program: METAL_SHADER,
                    },
                },
                shader_meta(),
            )
            .expect("drawing companion shader must compile");

        let pipeline = ctx.new_pipeline(
            &[miniquad::BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float2),
                VertexAttribute::new("in_color", VertexFormat::Float4),
            ],
            shader,
            blend_params(),
        );

        Renderer {
            pipeline,
            shader,
            vertex_buffer: GrowBuffer::new(ctx, BufferType::VertexBuffer, 256),
            index_buffer: GrowBuffer::new(ctx, BufferType::IndexBuffer, 256),
        }
    }

    /// Draw every chunk of `batch`, in submission order, clipped to each
    /// chunk's rectangle. `target_size` is the render target's pixel size
    /// (its physical size at the current DPI scale, when drawing at
    /// native resolution): see `docs/drawing-companion.md`.
    pub fn draw(&mut self, ctx: &mut dyn RenderingBackend, batch: &Batch, target_size: (f32, f32)) {
        let (width, height) = target_size;
        if width <= 0.0 || height <= 0.0 {
            return;
        }

        ctx.apply_pipeline(&self.pipeline);

        for chunk in batch.chunks() {
            if chunk.indices.is_empty() {
                continue;
            }

            self.vertex_buffer.upload(ctx, &chunk.vertices);
            self.index_buffer.upload(ctx, &chunk.indices);
            ctx.apply_bindings_from_slice(&[self.vertex_buffer.id], self.index_buffer.id, &[]);

            apply_clip(ctx, chunk.clip, width, height);

            ctx.apply_uniforms(UniformsSource::table(&Uniforms {
                scale: [2.0 / width, 2.0 / height],
            }));
            ctx.draw(0, chunk.indices.len() as i32, 1);
        }
    }

    /// Release the shader, pipeline, and GPU buffers. Call this exactly
    /// once; using the renderer afterward is a logic error, matching the
    /// `RenderingBackend` delete-then-stop-using contract.
    pub fn destroy(self, ctx: &mut dyn RenderingBackend) {
        ctx.delete_buffer(self.vertex_buffer.id);
        ctx.delete_buffer(self.index_buffer.id);
        ctx.delete_pipeline(self.pipeline);
        ctx.delete_shader(self.shader);
    }
}

/// Convert a top-left-origin, Y-down clip rectangle in logical pixels
/// into the scissor rectangle `RenderingBackend::apply_scissor_rect`
/// expects, and clamp it to the render target.
fn apply_clip(ctx: &mut dyn RenderingBackend, clip: Option<Rect>, width: f32, height: f32) {
    match clip {
        None => {
            ctx.apply_scissor_rect(0, 0, width as i32, height as i32);
        }
        Some(rect) => {
            let x = rect.x.max(0.0);
            let y = rect.y.max(0.0);
            let w = (rect.x + rect.w).min(width) - x;
            let h = (rect.y + rect.h).min(height) - y;
            let w = w.max(0.0);
            let h = h.max(0.0);
            // `apply_scissor_rect` takes the same bottom-left-origin,
            // Y-up rectangle the GL backend forwards to `glScissor`
            // untouched (the Metal backend flips it back internally):
            // flip our top-left, Y-down rect here.
            let gl_y = (height - y - h).max(0.0);
            ctx.apply_scissor_rect(x as i32, gl_y as i32, w as i32, h as i32);
        }
    }
}
