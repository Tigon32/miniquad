//! The `lyon` backend: builds the same reference workload
//! (`crate::workload`) with `lyon_tessellation` 1.0.23 (exact pin). This
//! module intentionally does not try to reproduce `miniquad-draw`'s
//! internal geometry bit-for-bit: Lyon's own path flattening, circle
//! approximation, and stroke joins differ from the internal
//! butt-cap/fixed-segment implementation. See
//! `docs/drawing-companion.md` for the documented tolerances and
//! tradeoffs this crate's comparison accepts instead of claiming exact
//! pixel parity.

use crate::workload::{
    self, BoundingBox, ShapeStats, WorkloadResult, CIRCLE_COUNT, CIRCLE_RADIUS, CURVE_COUNT,
    CURVE_THICKNESS, CURVE_TOLERANCE, RECT_COUNT, RECT_H, RECT_W, TRIANGLE_COUNT, TRIANGLE_SIZE,
};
use lyon_path::math::point;
use lyon_path::Path;
use lyon_tessellation::{
    BuffersBuilder, FillOptions, FillTessellator, FillVertex, FillVertexConstructor,
    StrokeOptions, StrokeTessellator, StrokeVertex, StrokeVertexConstructor, VertexBuffers,
};

#[derive(Copy, Clone)]
struct Vert {
    pos: [f32; 2],
}

struct PositionOnly;

impl FillVertexConstructor<Vert> for PositionOnly {
    fn new_vertex(&mut self, vertex: FillVertex) -> Vert {
        Vert {
            pos: vertex.position().to_array(),
        }
    }
}

impl StrokeVertexConstructor<Vert> for PositionOnly {
    fn new_vertex(&mut self, vertex: StrokeVertex) -> Vert {
        Vert {
            pos: vertex.position().to_array(),
        }
    }
}

fn triangle_area(vertices: &[Vert], indices: &[u32]) -> f64 {
    let mut area = 0.0f64;
    for tri in indices.chunks_exact(3) {
        let a = vertices[tri[0] as usize].pos;
        let b = vertices[tri[1] as usize].pos;
        let c = vertices[tri[2] as usize].pos;
        let cross = (b[0] - a[0]) as f64 * (c[1] - a[1]) as f64
            - (b[1] - a[1]) as f64 * (c[0] - a[0]) as f64;
        area += cross.abs() / 2.0;
    }
    area
}

fn accumulate(stats: &mut ShapeStats, bounds: &mut BoundingBox, buffers: &VertexBuffers<Vert, u32>) {
    stats.vertex_count += buffers.vertices.len();
    stats.triangle_count += buffers.indices.len() / 3;
    stats.total_area += triangle_area(&buffers.vertices, &buffers.indices);
    for v in &buffers.vertices {
        bounds.include(v.pos[0], v.pos[1]);
    }
}

pub fn run() -> WorkloadResult {
    let mut result = WorkloadResult::default();
    let mut fill = FillTessellator::new();
    let mut stroke = StrokeTessellator::new();
    // Same flatness tolerance value the internal backend uses, passed to
    // Lyon's own tolerance-driven flattening (see module docs: the
    // subdivision algorithms still differ).
    let fill_options = FillOptions::tolerance(CURVE_TOLERANCE);

    let mut rect_bounds = BoundingBox::empty();
    for n in 0..RECT_COUNT {
        let (x, y) = workload::grid_anchor(n, 0.0);
        let mut path_builder = Path::builder();
        path_builder.begin(point(x, y));
        path_builder.line_to(point(x + RECT_W, y));
        path_builder.line_to(point(x + RECT_W, y + RECT_H));
        path_builder.line_to(point(x, y + RECT_H));
        path_builder.end(true);
        let path = path_builder.build();

        let mut buffers: VertexBuffers<Vert, u32> = VertexBuffers::new();
        fill.tessellate_path(
            &path,
            &fill_options,
            &mut BuffersBuilder::new(&mut buffers, PositionOnly),
        )
        .expect("reference rectangle always tessellates");
        accumulate(&mut result.rects, &mut rect_bounds, &buffers);
    }
    result.include_bounds(rect_bounds);

    let mut tri_bounds = BoundingBox::empty();
    for n in 0..TRIANGLE_COUNT {
        let (x, y) = workload::grid_anchor(n, 400.0);
        let mut path_builder = Path::builder();
        path_builder.begin(point(x, y));
        path_builder.line_to(point(x + TRIANGLE_SIZE, y));
        path_builder.line_to(point(x, y + TRIANGLE_SIZE));
        path_builder.end(true);
        let path = path_builder.build();

        let mut buffers: VertexBuffers<Vert, u32> = VertexBuffers::new();
        fill.tessellate_path(
            &path,
            &fill_options,
            &mut BuffersBuilder::new(&mut buffers, PositionOnly),
        )
        .expect("reference triangle always tessellates");
        accumulate(&mut result.triangles, &mut tri_bounds, &buffers);
    }
    result.include_bounds(tri_bounds);

    // Circles: Lyon approximates a circle from its own tolerance-driven
    // arc flattening (`Path::builder().add_circle`), not the internal
    // backend's fixed `CIRCLE_SEGMENTS` fan. Triangle counts are
    // therefore not expected to match; see `docs/drawing-companion.md`.
    let mut circle_bounds = BoundingBox::empty();
    for n in 0..CIRCLE_COUNT {
        let (x, y) = workload::grid_anchor(n, 800.0);
        let center = point(x + CIRCLE_RADIUS, y + CIRCLE_RADIUS);

        let mut buffers: VertexBuffers<Vert, u32> = VertexBuffers::new();
        fill.tessellate_circle(
            center,
            CIRCLE_RADIUS,
            &fill_options,
            &mut BuffersBuilder::new(&mut buffers, PositionOnly),
        )
        .expect("reference circle always tessellates");
        accumulate(&mut result.circles, &mut circle_bounds, &buffers);
    }
    result.include_bounds(circle_bounds);

    // Stroked curves: Lyon's `StrokeTessellator` applies its default
    // joins/caps (round joins, butt caps by default in 1.0.23), which
    // differ from the internal backend's unconditional butt-cap
    // independent-quad-per-segment model. Only bounding-box and total
    // vertex-count-order-of-magnitude are compared, never an exact
    // triangle-for-triangle count; see `docs/drawing-companion.md`.
    let stroke_options = StrokeOptions::tolerance(CURVE_TOLERANCE).with_line_width(CURVE_THICKNESS);
    let mut curve_bounds = BoundingBox::empty();
    for n in 0..CURVE_COUNT {
        let [p0, p1, p2, p3] = workload::curve_points(n);
        let mut path_builder = Path::builder();
        path_builder.begin(point(p0.0, p0.1));
        path_builder.cubic_bezier_to(
            point(p1.0, p1.1),
            point(p2.0, p2.1),
            point(p3.0, p3.1),
        );
        path_builder.end(false);
        let path = path_builder.build();

        let mut buffers: VertexBuffers<Vert, u32> = VertexBuffers::new();
        stroke
            .tessellate_path(
                &path,
                &stroke_options,
                &mut BuffersBuilder::new(&mut buffers, PositionOnly),
            )
            .expect("reference curve always tessellates");
        accumulate(&mut result.curve_strokes, &mut curve_bounds, &buffers);
    }
    result.include_bounds(curve_bounds);

    result.total_vertices = result.rects.vertex_count
        + result.triangles.vertex_count
        + result.circles.vertex_count
        + result.curve_strokes.vertex_count;

    result
}
