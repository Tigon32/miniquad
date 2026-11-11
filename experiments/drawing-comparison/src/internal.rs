//! The `internal` backend: builds the reference workload with
//! `miniquad-draw`'s existing pure geometry functions
//! (`companions/draw/src/geometry.rs`). These functions never touch a
//! `RenderingBackend` or any GPU handle, so this backend reuses the
//! crate's public API directly with no GPU context, shared drawer, or
//! copy of its implementation.

use crate::workload::{
    self, BoundingBox, ShapeStats, WorkloadResult, CIRCLE_COUNT, CIRCLE_RADIUS, CIRCLE_SEGMENTS,
    CURVE_COUNT, CURVE_THICKNESS, CURVE_TOLERANCE, RECT_COUNT, RECT_H, RECT_W, TRIANGLE_COUNT,
    TRIANGLE_SIZE,
};
use miniquad_draw::geometry::{self, Rect};
use miniquad_draw::{Color, Transform2D};

fn triangle_area(vertices: &[miniquad_draw::geometry::Vertex], indices: &[u32]) -> f64 {
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

fn accumulate(
    stats: &mut ShapeStats,
    bounds: &mut BoundingBox,
    vertices: &[miniquad_draw::geometry::Vertex],
    indices: &[u32],
) {
    stats.vertex_count += vertices.len();
    stats.triangle_count += indices.len() / 3;
    stats.total_area += triangle_area(vertices, indices);
    for v in vertices {
        bounds.include(v.pos[0], v.pos[1]);
    }
}

pub fn run() -> WorkloadResult {
    let mut result = WorkloadResult::default();
    let identity = Transform2D::IDENTITY;
    let color = Color::WHITE;

    let mut rect_bounds = BoundingBox::empty();
    for n in 0..RECT_COUNT {
        let (x, y) = workload::grid_anchor(n, 0.0);
        let (v, i) = geometry::rectangle(Rect::new(x, y, RECT_W, RECT_H), color, identity)
            .expect("reference rectangle is always valid");
        accumulate(&mut result.rects, &mut rect_bounds, &v, &i);
    }
    result.include_bounds(rect_bounds);

    let mut tri_bounds = BoundingBox::empty();
    for n in 0..TRIANGLE_COUNT {
        let (x, y) = workload::grid_anchor(n, 400.0);
        let (v, i) = geometry::triangle(
            (x, y),
            (x + TRIANGLE_SIZE, y),
            (x, y + TRIANGLE_SIZE),
            color,
            identity,
        )
        .expect("reference triangle is always valid");
        accumulate(&mut result.triangles, &mut tri_bounds, &v, &i);
    }
    result.include_bounds(tri_bounds);

    let mut circle_bounds = BoundingBox::empty();
    for n in 0..CIRCLE_COUNT {
        let (x, y) = workload::grid_anchor(n, 800.0);
        let center = (x + CIRCLE_RADIUS, y + CIRCLE_RADIUS);
        let (v, i) = geometry::circle(center, CIRCLE_RADIUS, CIRCLE_SEGMENTS, color, identity)
            .expect("reference circle is always valid");
        accumulate(&mut result.circles, &mut circle_bounds, &v, &i);
    }
    result.include_bounds(circle_bounds);

    let mut curve_bounds = BoundingBox::empty();
    for n in 0..CURVE_COUNT {
        let [p0, p1, p2, p3] = workload::curve_points(n);
        let (v, i) = geometry::cubic_curve_stroke(
            p0,
            p1,
            p2,
            p3,
            CURVE_TOLERANCE,
            CURVE_THICKNESS,
            color,
            identity,
        )
        .expect("reference curve is always valid");
        accumulate(&mut result.curve_strokes, &mut curve_bounds, &v, &i);
    }
    result.include_bounds(curve_bounds);

    result.total_vertices = result.rects.vertex_count
        + result.triangles.vertex_count
        + result.circles.vertex_count
        + result.curve_strokes.vertex_count;

    result
}
