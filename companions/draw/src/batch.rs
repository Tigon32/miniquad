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

/// One contiguous run of geometry sharing a clip rectangle.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// `None` means no clip (draw over the whole render target).
    pub clip: Option<Rect>,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
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
        match self.chunks.last_mut() {
            Some(chunk) if chunk.clip == self.current_clip => {
                let base = chunk.vertices.len() as u32;
                self.total_vertices += vertices.len();
                chunk.vertices.extend(vertices);
                chunk.indices.extend(indices.into_iter().map(|i| i + base));
            }
            _ => {
                self.total_vertices += vertices.len();
                self.chunks.push(Chunk {
                    clip: self.current_clip,
                    vertices,
                    indices,
                });
            }
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
}
