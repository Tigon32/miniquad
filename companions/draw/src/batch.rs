//! Order-preserving, clip-batched geometry accumulation.
//!
//! A [`Batch`] accumulates shapes in submission order into chunks grouped
//! by clip rectangle. Consecutive pushes that share the same clip merge
//! into one chunk (one GPU draw call); a clip change starts a new chunk.
//! Chunks are never reordered or merged across an interruption, so
//! overlapping translucent shapes still draw in the painter's-algorithm
//! order the caller submitted them in.

use crate::color::Color;
use crate::geometry::{
    self, cubic_curve_stroke, polyline, rectangle, triangle, GeometryError, Rect, Vertex,
};
use crate::transform::Transform2D;

/// A bound on the total number of vertices a single [`Batch`] can hold.
/// A push that would exceed this bound is rejected and the batch is left
/// unchanged, instead of growing without limit.
pub const MAX_BATCH_VERTICES: usize = 1 << 20;

/// A bound on the number of vertices a single [`Chunk`] can hold.
///
/// The GPU adapter uploads each chunk's indices as `u16`, because the
/// default WebGL 1 context (used unless the host app opts into WebGL 2)
/// does not support `u32` element indices without the
/// `OES_element_index_uint` extension; drawing with an unsupported index
/// type raises `GL_INVALID_ENUM` and silently draws nothing. Capping a
/// chunk at `u16::MAX + 1` vertices keeps every index representable, so
/// a clip change is not the only thing that can start a new chunk: a
/// push that would overflow the current chunk also starts a new one
/// (still with the same clip, so draw order is unaffected). See
/// `docs/drawing-companion.md` for the regression this fixes.
pub const MAX_CHUNK_VERTICES: usize = 1 << 16;

/// One contiguous run of geometry sharing a clip rectangle.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// `None` means no clip (draw over the whole render target).
    pub clip: Option<Rect>,
    pub vertices: Vec<Vertex>,
    /// `u16`-width indices: see [`MAX_CHUNK_VERTICES`].
    pub indices: Vec<u16>,
}

/// An accumulator of 2D batch geometry. See the module docs for the
/// clip-batching and draw-order contract.
#[derive(Debug, Default)]
pub struct Batch {
    chunks: Vec<Chunk>,
    current_clip: Option<Rect>,
    total_vertices: usize,
}

impl Batch {
    pub fn new() -> Batch {
        Batch::default()
    }

    /// Set the clip rectangle applied to shapes pushed after this call.
    /// `None` removes clipping. Errors (without changing the current
    /// clip) on a non-finite or non-positive-size rectangle.
    pub fn set_clip(&mut self, clip: Option<Rect>) -> Result<(), GeometryError> {
        if let Some(rect) = clip {
            rect.validate()?;
        }
        self.current_clip = clip;
        Ok(())
    }

    /// The clip rectangle that applies to the next pushed shape.
    pub fn clip(&self) -> Option<Rect> {
        self.current_clip
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn vertex_count(&self) -> usize {
        self.total_vertices
    }

    /// Remove all accumulated geometry. The current clip rectangle is
    /// kept, so a caller can clear a batch between frames without
    /// reapplying `set_clip`.
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.total_vertices = 0;
    }

    fn push(&mut self, vertices: Vec<Vertex>, indices: Vec<u32>) -> Result<(), GeometryError> {
        if self.total_vertices + vertices.len() > MAX_BATCH_VERTICES {
            return Err(GeometryError::TooManyVertices);
        }
        // A single shape's own vertex count must itself fit a chunk; every
        // geometry builder is bounded well under `MAX_CHUNK_VERTICES`
        // (`MAX_POLYLINE_POINTS`, `MAX_CIRCLE_SEGMENTS`, triangle, and
        // rectangle all stay far below `1 << 16`), so this only catches a
        // future bound regression rather than ordinary caller input.
        assert!(
            vertices.len() <= MAX_CHUNK_VERTICES,
            "a single shape produced {} vertices, more than MAX_CHUNK_VERTICES ({})",
            vertices.len(),
            MAX_CHUNK_VERTICES
        );

        let fits_current_chunk = matches!(
            self.chunks.last(),
            Some(chunk)
                if chunk.clip == self.current_clip
                    && chunk.vertices.len() + vertices.len() <= MAX_CHUNK_VERTICES
        );

        self.total_vertices += vertices.len();
        if fits_current_chunk {
            let chunk = self
                .chunks
                .last_mut()
                .expect("checked by fits_current_chunk");
            let base = chunk.vertices.len();
            chunk.vertices.extend(vertices);
            chunk.indices.extend(indices.into_iter().map(|i| {
                u16::try_from(i as usize + base)
                    .expect("base + local index is bounded by MAX_CHUNK_VERTICES above")
            }));
        } else {
            let indices = indices
                .into_iter()
                .map(|i| {
                    u16::try_from(i).expect(
                        "a single shape's local index is bounded by MAX_CHUNK_VERTICES above",
                    )
                })
                .collect();
            self.chunks.push(Chunk {
                clip: self.current_clip,
                vertices,
                indices,
            });
        }
        Ok(())
    }

    pub fn triangle(
        &mut self,
        p0: (f32, f32),
        p1: (f32, f32),
        p2: (f32, f32),
        color: Color,
        transform: Transform2D,
    ) -> Result<(), GeometryError> {
        let (v, i) = triangle(p0, p1, p2, color, transform)?;
        self.push(v, i)
    }

    pub fn rectangle(
        &mut self,
        rect: Rect,
        color: Color,
        transform: Transform2D,
    ) -> Result<(), GeometryError> {
        let (v, i) = rectangle(rect, color, transform)?;
        self.push(v, i)
    }

    pub fn polyline(
        &mut self,
        points: &[(f32, f32)],
        thickness: f32,
        color: Color,
        transform: Transform2D,
    ) -> Result<(), GeometryError> {
        let (v, i) = polyline(points, thickness, color, transform)?;
        self.push(v, i)
    }

    pub fn circle(
        &mut self,
        center: (f32, f32),
        radius: f32,
        segments: u32,
        color: Color,
        transform: Transform2D,
    ) -> Result<(), GeometryError> {
        let (v, i) = geometry::circle(center, radius, segments, color, transform)?;
        self.push(v, i)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cubic_curve_stroke(
        &mut self,
        p0: (f32, f32),
        p1: (f32, f32),
        p2: (f32, f32),
        p3: (f32, f32),
        tolerance: f32,
        thickness: f32,
        color: Color,
        transform: Transform2D,
    ) -> Result<(), GeometryError> {
        let (v, i) = cubic_curve_stroke(p0, p1, p2, p3, tolerance, thickness, color, transform)?;
        self.push(v, i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> Transform2D {
        Transform2D::IDENTITY
    }

    #[test]
    fn consecutive_same_clip_shapes_merge_into_one_chunk() {
        let mut batch = Batch::new();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        batch
            .triangle((2.0, 0.0), (3.0, 0.0), (2.0, 1.0), Color::WHITE, id())
            .unwrap();
        assert_eq!(batch.chunks().len(), 1);
        assert_eq!(batch.chunks()[0].vertices.len(), 6);
        // Second triangle's indices are offset past the first triangle's vertices.
        assert_eq!(batch.chunks()[0].indices, vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn clip_change_starts_a_new_chunk() {
        let mut batch = Batch::new();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        batch
            .set_clip(Some(Rect::new(0.0, 0.0, 10.0, 10.0)))
            .unwrap();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        assert_eq!(batch.chunks().len(), 2);
        assert_eq!(batch.chunks()[0].clip, None);
        assert_eq!(
            batch.chunks()[1].clip,
            Some(Rect::new(0.0, 0.0, 10.0, 10.0))
        );
    }

    #[test]
    fn interrupted_clip_reuse_does_not_merge_across_the_interruption() {
        let mut batch = Batch::new();
        let clip_a = Rect::new(0.0, 0.0, 5.0, 5.0);
        let clip_b = Rect::new(5.0, 5.0, 5.0, 5.0);

        batch.set_clip(Some(clip_a)).unwrap();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        batch.set_clip(Some(clip_b)).unwrap();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        batch.set_clip(Some(clip_a)).unwrap();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();

        // Draw order is preserved: A, B, A - not merged into two A chunks.
        assert_eq!(batch.chunks().len(), 3);
        assert_eq!(batch.chunks()[0].clip, Some(clip_a));
        assert_eq!(batch.chunks()[1].clip, Some(clip_b));
        assert_eq!(batch.chunks()[2].clip, Some(clip_a));
    }

    #[test]
    fn failed_push_leaves_batch_unchanged() {
        let mut batch = Batch::new();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        let before = batch.chunks().to_vec();

        // Collinear points: degenerate, must not mutate the batch.
        let err = batch
            .triangle((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), Color::WHITE, id())
            .unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
        assert_eq!(batch.chunks().to_vec(), before);
        assert_eq!(batch.vertex_count(), 3);
    }

    #[test]
    fn set_clip_rejects_invalid_rect_and_keeps_old_clip() {
        let mut batch = Batch::new();
        batch
            .set_clip(Some(Rect::new(0.0, 0.0, 10.0, 10.0)))
            .unwrap();
        let err = batch
            .set_clip(Some(Rect::new(0.0, 0.0, -1.0, 10.0)))
            .unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
        assert_eq!(batch.clip(), Some(Rect::new(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn clear_resets_chunks_and_vertex_count_but_keeps_clip() {
        let mut batch = Batch::new();
        batch
            .set_clip(Some(Rect::new(0.0, 0.0, 10.0, 10.0)))
            .unwrap();
        batch
            .triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id())
            .unwrap();
        batch.clear();
        assert!(batch.is_empty());
        assert_eq!(batch.vertex_count(), 0);
        assert_eq!(batch.clip(), Some(Rect::new(0.0, 0.0, 10.0, 10.0)));
    }

    /// Regression test for the real-browser failure where draws through a
    /// single oversize chunk raised `GL_INVALID_ENUM` on a default WebGL 1
    /// context (`u32` indices are unsupported there) and drew nothing. A
    /// same-clip run that would overflow `MAX_CHUNK_VERTICES` must start a
    /// new chunk instead of growing the current one past `u16::MAX`, and
    /// every resulting index must stay in range.
    #[test]
    fn same_clip_run_past_chunk_cap_splits_into_multiple_u16_safe_chunks() {
        let mut batch = Batch::new();
        // 3 vertices per triangle; push enough to cross MAX_CHUNK_VERTICES.
        let triangle_count = MAX_CHUNK_VERTICES / 3 + 10;
        for i in 0..triangle_count {
            let x = i as f32;
            batch
                .triangle((x, 0.0), (x + 1.0, 0.0), (x, 1.0), Color::WHITE, id())
                .unwrap();
        }

        assert!(
            batch.chunks().len() > 1,
            "expected the oversize same-clip run to split into more than one chunk"
        );
        assert_eq!(batch.vertex_count(), triangle_count * 3);

        let mut total_vertices_in_chunks = 0;
        for chunk in batch.chunks() {
            assert!(chunk.clip.is_none(), "clip was never changed");
            assert!(
                chunk.vertices.len() <= MAX_CHUNK_VERTICES,
                "a chunk must never exceed MAX_CHUNK_VERTICES"
            );
            for &index in &chunk.indices {
                assert!(
                    (index as usize) < chunk.vertices.len(),
                    "every index must address a vertex within its own chunk"
                );
            }
            total_vertices_in_chunks += chunk.vertices.len();
        }
        assert_eq!(total_vertices_in_chunks, triangle_count * 3);
    }
}
