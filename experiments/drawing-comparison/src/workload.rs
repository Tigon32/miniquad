//! The bounded reference workload shared by both backends.
//!
//! Both `internal` and `lyon` build the *same* deterministic shape list
//! from this module's constants, so a size, correctness, or timing
//! comparison is paired on equal input, per the Performance proof skill
//! ("select one unit and one test workload").

/// One rectangle in the reference workload: fixed size, laid out on a
/// grid so the whole workload has a predictable, reproducible bounding
/// box.
pub const RECT_COUNT: usize = 50;
pub const RECT_W: f32 = 20.0;
pub const RECT_H: f32 = 14.0;

/// Filled triangles, same grid layout, offset so they do not overlap the
/// rectangles.
pub const TRIANGLE_COUNT: usize = 50;
pub const TRIANGLE_SIZE: f32 = 18.0;

/// Filled circles. `CIRCLE_SEGMENTS` is the explicit internal segment
/// count; the Lyon backend approximates the same radius with its own
/// tolerance-driven arc flattening (see `docs/drawing-companion.md` for
/// why segment count is not expected to match exactly).
pub const CIRCLE_COUNT: usize = 20;
pub const CIRCLE_RADIUS: f32 = 20.0;
pub const CIRCLE_SEGMENTS: u32 = 32;

/// Stroked cubic Bezier curves. `CURVE_TOLERANCE` is passed to both
/// backends' own flattening tolerance parameter (internal:
/// `geometry::flatten_cubic_bezier`'s `tolerance`; Lyon:
/// `StrokeOptions::with_tolerance`), so both target the same flatness
/// bound, even though their subdivision algorithms differ.
pub const CURVE_COUNT: usize = 10;
pub const CURVE_TOLERANCE: f32 = 0.5;
pub const CURVE_THICKNESS: f32 = 2.0;

/// Grid spacing shared by rectangles, triangles, and circles, so the
/// three shape kinds occupy disjoint, deterministic regions of the same
/// logical canvas.
pub const GRID_STEP: f32 = 40.0;
pub const GRID_COLUMNS: usize = 10;

/// The `n`th grid cell's top-left-origin anchor point.
pub fn grid_anchor(n: usize, row_offset: f32) -> (f32, f32) {
    let col = (n % GRID_COLUMNS) as f32;
    let row = (n / GRID_COLUMNS) as f32;
    (col * GRID_STEP, row_offset + row * GRID_STEP)
}

/// Control points for the `n`th reference cubic curve: a fixed S-curve,
/// translated along x so the curves do not overlap.
pub fn curve_points(n: usize) -> [(f32, f32); 4] {
    let x0 = n as f32 * 60.0;
    [
        (x0, 0.0),
        (x0 + 10.0, 50.0),
        (x0 + 40.0, 50.0),
        (x0 + 50.0, 0.0),
    ]
}

/// An axis-aligned bounding box over logical-pixel positions. Used for
/// the cross-backend correctness comparison — not a pixel comparison,
/// since the two backends never render the same framebuffer: this
/// compares the CPU-side geometry both backends would hand to a GPU
/// upload step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

impl BoundingBox {
    pub fn empty() -> Self {
        BoundingBox {
            min_x: f32::INFINITY,
            min_y: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            max_y: f32::NEG_INFINITY,
        }
    }

    pub fn include(&mut self, x: f32, y: f32) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }

    pub fn width(&self) -> f32 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f32 {
        self.max_y - self.min_y
    }
}

/// Per-shape-kind geometry counts and area, for the cross-backend
/// correctness comparison.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShapeStats {
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub total_area: f64,
}

/// The result of running the whole reference workload once with one
/// backend.
#[derive(Debug, Clone, Default)]
pub struct WorkloadResult {
    pub rects: ShapeStats,
    pub triangles: ShapeStats,
    pub circles: ShapeStats,
    pub curve_strokes: ShapeStats,
    pub bounds: Option<BoundingBox>,
    pub total_vertices: usize,
}

impl WorkloadResult {
    pub fn include_bounds(&mut self, b: BoundingBox) {
        self.bounds = Some(match self.bounds {
            Some(mut existing) => {
                existing.include(b.min_x, b.min_y);
                existing.include(b.max_x, b.max_y);
                existing
            }
            None => b,
        });
    }
}
