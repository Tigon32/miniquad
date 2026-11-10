//! `miniquad-draw`: an optional, bounded 2D batch-geometry drawing
//! companion for Miniquad.
//!
//! This crate is **not** part of the Miniquad core crate and is not a
//! workspace member of it. It is a standalone package that depends on
//! `miniquad` the same way an application would. See
//! `docs/drawing-companion.md` for the full guide, coordinate and alpha
//! conventions, and a comparison with a maintained tessellation library.
//!
//! # Layout
//!
//! - [`color`] and [`transform`]: small, pure value types.
//! - [`geometry`]: pure functions that build vertices and indices for
//!   triangles, rectangles, thick polylines, circles, and bounded cubic
//!   curve subdivision. No GPU state; fully unit-testable.
//! - [`batch`]: [`batch::Batch`] accumulates geometry in submission
//!   order, grouped into clip-rectangle chunks.
//! - [`gpu`]: [`gpu::Renderer`], the only part of this crate that touches
//!   `miniquad::RenderingBackend`. Owns its shader, pipeline, and dynamic
//!   buffers; requires an explicit [`gpu::Renderer::destroy`] call.
//!
//! # Quick example
//!
//! ```no_run
//! use miniquad_draw::{batch::Batch, color::Color, geometry::Rect, gpu::Renderer, transform::Transform2D};
//! use miniquad::RenderingBackend;
//!
//! fn frame(ctx: &mut dyn RenderingBackend, renderer: &mut Renderer, screen: (f32, f32)) {
//!     let mut batch = Batch::new();
//!     batch
//!         .rectangle(Rect::new(10.0, 10.0, 100.0, 40.0), Color::WHITE, Transform2D::IDENTITY)
//!         .expect("valid rectangle");
//!     renderer.draw(ctx, &batch, screen);
//! }
//! ```

pub mod batch;
pub mod color;
pub mod geometry;
pub mod gpu;
pub mod transform;

pub use batch::Batch;
pub use color::Color;
pub use geometry::{GeometryError, Rect, Vertex};
pub use gpu::Renderer;
pub use transform::Transform2D;
