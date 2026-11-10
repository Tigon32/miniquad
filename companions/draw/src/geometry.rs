//! Pure 2D batch geometry.
//!
//! Every function here is free of GPU state: it takes plain numbers and a
//! [`crate::transform::Transform2D`] and returns vertices and indices, or a
//! [`GeometryError`]. The GPU adapter in [`crate::gpu`] is the only part of
//! this crate that touches a `miniquad::RenderingBackend`.
//!
//! Coordinates are logical pixels in a **top-left origin, Y-down** space,
//! matching common 2D drawing conventions. The GPU adapter converts this
//! space into clip space for the active render target size; see
//! `docs/drawing-companion.md` for the DPI and coordinate conventions.

use crate::color::Color;
use crate::transform::Transform2D;

/// A bound on any single coordinate value, before or after a transform.
/// A shape whose input or output coordinate falls outside
/// `[-MAX_COORDINATE, MAX_COORDINATE]` is rejected with
/// [`GeometryError::CoordinateOutOfBounds`], so one call cannot build an
/// unbounded vertex buffer from a single pathological input.
pub const MAX_COORDINATE: f32 = 1.0e6;

/// Smallest triangle area (in squared logical pixels) accepted as
/// non-degenerate.
pub const MIN_TRIANGLE_AREA: f32 = 1.0e-6;

/// Circle fan segment count bounds.
pub const MIN_CIRCLE_SEGMENTS: u32 = 3;
pub const MAX_CIRCLE_SEGMENTS: u32 = 256;

/// Polyline point count bound.
pub const MAX_POLYLINE_POINTS: usize = 4096;

/// Cubic curve adaptive-subdivision recursion bound. This bounds the
/// subdivision tree depth, so a curve always terminates in at most
/// `2^MAX_CURVE_SUBDIVISION_DEPTH` segments, regardless of flatness
/// tolerance or control-point placement.
pub const MAX_CURVE_SUBDIVISION_DEPTH: u32 = 16;

/// A reason a geometry build was rejected. Each variant names the exact
/// input class that failed, so a caller can log and recover deterministically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryError {
    /// An input coordinate, thickness, radius, or transform field was
    /// `NaN` or infinite.
    NonFiniteInput,
    /// A finite input or transformed coordinate exceeded [`MAX_COORDINATE`].
    CoordinateOutOfBounds,
    /// A shape had zero area, zero length, or zero radius, and so would
    /// not produce visible geometry (for example three collinear
    /// triangle points, or a polyline with fewer than two points).
    DegenerateShape,
    /// A count-bounded input (circle segments, polyline points) was
    /// outside its documented bound.
    TooManyVertices,
}

/// One GPU-ready vertex: a position in logical pixels and a
/// **premultiplied-alpha** color. See [`Color::to_premultiplied`].
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vertex {
    pub pos: [f32; 2],
    pub color: [f32; 4],
}

/// An axis-aligned rectangle in logical pixels, top-left origin.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    pub(crate) fn validate(self) -> Result<Rect, GeometryError> {
        let fields = [self.x, self.y, self.w, self.h];
        if fields.iter().any(|v| !v.is_finite()) {
            return Err(GeometryError::NonFiniteInput);
        }
        if fields.iter().any(|v| v.abs() > MAX_COORDINATE) {
            return Err(GeometryError::CoordinateOutOfBounds);
        }
        if self.w <= 0.0 || self.h <= 0.0 {
            return Err(GeometryError::DegenerateShape);
        }
        Ok(self)
    }
}

fn check_point(x: f32, y: f32) -> Result<(), GeometryError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(GeometryError::NonFiniteInput);
    }
    if x.abs() > MAX_COORDINATE || y.abs() > MAX_COORDINATE {
        return Err(GeometryError::CoordinateOutOfBounds);
    }
    Ok(())
}

fn transform_point(transform: Transform2D, x: f32, y: f32) -> Result<(f32, f32), GeometryError> {
    check_point(x, y)?;
    if !transform.is_finite() {
        return Err(GeometryError::NonFiniteInput);
    }
    let (px, py) = transform.apply(x, y).ok_or(GeometryError::NonFiniteInput)?;
    check_point(px, py)?;
    Ok((px, py))
}

fn vertex(pos: (f32, f32), color: [f32; 4]) -> Vertex {
    Vertex {
        pos: [pos.0, pos.1],
        color,
    }
}

/// Build a single filled triangle. Errors on a non-finite or
/// out-of-bounds point, and on a degenerate (zero-area, for example
/// collinear) triangle.
pub fn triangle(
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    color: Color,
    transform: Transform2D,
) -> Result<(Vec<Vertex>, Vec<u32>), GeometryError> {
    let a = transform_point(transform, p0.0, p0.1)?;
    let b = transform_point(transform, p1.0, p1.1)?;
    let c = transform_point(transform, p2.0, p2.1)?;

    let area = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
    if area.abs() < MIN_TRIANGLE_AREA {
        return Err(GeometryError::DegenerateShape);
    }

    let col = color.to_premultiplied();
    Ok((
        vec![vertex(a, col), vertex(b, col), vertex(c, col)],
        vec![0, 1, 2],
    ))
}

/// Build a filled axis-aligned rectangle (two triangles). Errors on a
/// non-finite, out-of-bounds, or non-positive-size rectangle.
pub fn rectangle(
    rect: Rect,
    color: Color,
    transform: Transform2D,
) -> Result<(Vec<Vertex>, Vec<u32>), GeometryError> {
    let rect = rect.validate()?;
    let corners = [
        (rect.x, rect.y),
        (rect.x + rect.w, rect.y),
        (rect.x + rect.w, rect.y + rect.h),
        (rect.x, rect.y + rect.h),
    ];
    let mut verts = Vec::with_capacity(4);
    let col = color.to_premultiplied();
    for (x, y) in corners {
        let p = transform_point(transform, x, y)?;
        verts.push(vertex(p, col));
    }
    Ok((verts, vec![0, 1, 2, 0, 2, 3]))
}

/// Build a thick polyline from a sequence of points. Each segment becomes
/// a rectangle `thickness` logical pixels wide, with butt caps: adjacent
/// segments are not joined with a miter or round join. State this limit
/// to callers who need smooth wide joins.
///
/// Errors when there are fewer than two points, when `thickness` is not a
/// finite positive number, or when `points.len()` exceeds
/// [`MAX_POLYLINE_POINTS`].
pub fn polyline(
    points: &[(f32, f32)],
    thickness: f32,
    color: Color,
    transform: Transform2D,
) -> Result<(Vec<Vertex>, Vec<u32>), GeometryError> {
    if points.len() > MAX_POLYLINE_POINTS {
        return Err(GeometryError::TooManyVertices);
    }
    if points.len() < 2 {
        return Err(GeometryError::DegenerateShape);
    }
    if !thickness.is_finite() || thickness <= 0.0 {
        return Err(GeometryError::NonFiniteInput);
    }

    let half = thickness / 2.0;
    let col = color.to_premultiplied();
    let mut verts = Vec::with_capacity(points.len() * 2);
    let mut indices = Vec::with_capacity((points.len() - 1) * 6);

    for pair in points.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        check_point(x0, y0)?;
        check_point(x1, y1)?;

        let dx = x1 - x0;
        let dy = y1 - y0;
        let len = (dx * dx + dy * dy).sqrt();
        if !(len > 0.0) {
            // A zero-length segment carries no direction to extrude a
            // width from; skip it instead of dividing by zero.
            continue;
        }
        let nx = -dy / len * half;
        let ny = dx / len * half;

        let base = verts.len() as u32;
        verts.push(vertex(transform_point(transform, x0 + nx, y0 + ny)?, col));
        verts.push(vertex(transform_point(transform, x0 - nx, y0 - ny)?, col));
        verts.push(vertex(transform_point(transform, x1 + nx, y1 + ny)?, col));
        verts.push(vertex(transform_point(transform, x1 - nx, y1 - ny)?, col));
        indices.extend_from_slice(&[base, base + 1, base + 2, base + 1, base + 3, base + 2]);
    }

    if verts.is_empty() {
        return Err(GeometryError::DegenerateShape);
    }
    Ok((verts, indices))
}

/// Build a filled circle as a triangle fan. Errors on a non-finite
/// center or radius, a non-positive radius, and a `segments` count
/// outside `[MIN_CIRCLE_SEGMENTS, MAX_CIRCLE_SEGMENTS]`.
pub fn circle(
    center: (f32, f32),
    radius: f32,
    segments: u32,
    color: Color,
    transform: Transform2D,
) -> Result<(Vec<Vertex>, Vec<u32>), GeometryError> {
    check_point(center.0, center.1)?;
    if !radius.is_finite() || radius <= 0.0 {
        return Err(GeometryError::NonFiniteInput);
    }
    if radius > MAX_COORDINATE {
        return Err(GeometryError::CoordinateOutOfBounds);
    }
    if !(MIN_CIRCLE_SEGMENTS..=MAX_CIRCLE_SEGMENTS).contains(&segments) {
        return Err(GeometryError::TooManyVertices);
    }

    let col = color.to_premultiplied();
    let mut verts = Vec::with_capacity(segments as usize + 1);
    verts.push(vertex(transform_point(transform, center.0, center.1)?, col));
    for i in 0..segments {
        let theta = (i as f32) / (segments as f32) * std::f32::consts::TAU;
        let x = center.0 + radius * theta.cos();
        let y = center.1 + radius * theta.sin();
        verts.push(vertex(transform_point(transform, x, y)?, col));
    }

    let mut indices = Vec::with_capacity(segments as usize * 3);
    for i in 1..=segments {
        let next = if i == segments { 1 } else { i + 1 };
        indices.extend_from_slice(&[0, i, next]);
    }
    Ok((verts, indices))
}

/// Flatten a cubic Bezier curve into a point polyline using adaptive
/// subdivision with a flatness `tolerance` (logical pixels). Subdivision
/// always stops: either a segment is flat enough, or
/// [`MAX_CURVE_SUBDIVISION_DEPTH`] is reached, so the result is always
/// bounded even for a degenerate curve (coincident points) or a
/// pathologically small tolerance.
///
/// Errors on a non-finite control point or a non-finite or non-positive
/// `tolerance`.
pub fn flatten_cubic_bezier(
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    p3: (f32, f32),
    tolerance: f32,
) -> Result<Vec<(f32, f32)>, GeometryError> {
    for (x, y) in [p0, p1, p2, p3] {
        check_point(x, y)?;
    }
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(GeometryError::NonFiniteInput);
    }

    let mut points = vec![p0];
    subdivide_cubic(p0, p1, p2, p3, tolerance, 0, &mut points);
    points.push(p3);
    Ok(points)
}

fn flatness(p0: (f32, f32), p1: (f32, f32), p2: (f32, f32), p3: (f32, f32)) -> f32 {
    // Maximum distance of the two interior control points from the
    // chord p0-p3; a standard, cheap flatness estimate for a cubic.
    let ux = (3.0 * p1.0 - 2.0 * p0.0 - p3.0).abs();
    let uy = (3.0 * p1.1 - 2.0 * p0.1 - p3.1).abs();
    let vx = (3.0 * p2.0 - 2.0 * p3.0 - p0.0).abs();
    let vy = (3.0 * p2.1 - 2.0 * p3.1 - p0.1).abs();
    let ux = ux.max(vx);
    let uy = uy.max(vy);
    (ux * ux + uy * uy).sqrt()
}

fn midpoint(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)
}

#[allow(clippy::too_many_arguments)]
fn subdivide_cubic(
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    p3: (f32, f32),
    tolerance: f32,
    depth: u32,
    out: &mut Vec<(f32, f32)>,
) {
    if depth >= MAX_CURVE_SUBDIVISION_DEPTH || flatness(p0, p1, p2, p3) <= tolerance * 16.0 {
        return;
    }

    // De Casteljau split at t = 0.5.
    let p01 = midpoint(p0, p1);
    let p12 = midpoint(p1, p2);
    let p23 = midpoint(p2, p3);
    let p012 = midpoint(p01, p12);
    let p123 = midpoint(p12, p23);
    let mid = midpoint(p012, p123);

    subdivide_cubic(p0, p01, p012, mid, tolerance, depth + 1, out);
    out.push(mid);
    subdivide_cubic(mid, p123, p23, p3, tolerance, depth + 1, out);
}

/// Build a stroked cubic Bezier curve: flatten it with
/// [`flatten_cubic_bezier`], then stroke the resulting polyline with
/// [`polyline`].
pub fn cubic_curve_stroke(
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    p3: (f32, f32),
    tolerance: f32,
    thickness: f32,
    color: Color,
    transform: Transform2D,
) -> Result<(Vec<Vertex>, Vec<u32>), GeometryError> {
    let points = flatten_cubic_bezier(p0, p1, p2, p3, tolerance)?;
    polyline(&points, thickness, color, transform)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> Transform2D {
        Transform2D::IDENTITY
    }

    #[test]
    fn triangle_builds_three_vertices() {
        let (v, i) = triangle((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id()).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(i, vec![0, 1, 2]);
    }

    #[test]
    fn collinear_triangle_is_degenerate() {
        let err = triangle((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
    }

    #[test]
    fn triangle_rejects_non_finite_point() {
        let err =
            triangle((f32::NAN, 0.0), (1.0, 0.0), (0.0, 1.0), Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn triangle_rejects_oversize_point() {
        let err = triangle(
            (MAX_COORDINATE * 2.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
            Color::WHITE,
            id(),
        )
        .unwrap_err();
        assert_eq!(err, GeometryError::CoordinateOutOfBounds);
    }

    #[test]
    fn rectangle_builds_four_vertices() {
        let (v, i) = rectangle(Rect::new(0.0, 0.0, 10.0, 5.0), Color::WHITE, id()).unwrap();
        assert_eq!(v.len(), 4);
        assert_eq!(i, vec![0, 1, 2, 0, 2, 3]);
    }

    #[test]
    fn rectangle_rejects_zero_size() {
        let err = rectangle(Rect::new(0.0, 0.0, 0.0, 5.0), Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
    }

    #[test]
    fn rectangle_rejects_negative_size() {
        let err = rectangle(Rect::new(0.0, 0.0, -1.0, 5.0), Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
    }

    #[test]
    fn polyline_rejects_single_point() {
        let err = polyline(&[(0.0, 0.0)], 1.0, Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
    }

    #[test]
    fn polyline_rejects_too_many_points() {
        let points = vec![(0.0, 0.0); MAX_POLYLINE_POINTS + 1];
        let err = polyline(&points, 1.0, Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::TooManyVertices);
    }

    #[test]
    fn polyline_rejects_non_finite_thickness() {
        let err = polyline(&[(0.0, 0.0), (1.0, 1.0)], f32::NAN, Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn polyline_skips_zero_length_segment_but_keeps_others() {
        let (v, _) = polyline(
            &[(0.0, 0.0), (0.0, 0.0), (10.0, 0.0)],
            2.0,
            Color::WHITE,
            id(),
        )
        .unwrap();
        // Only the second (non-zero-length) segment produces a quad.
        assert_eq!(v.len(), 4);
    }

    #[test]
    fn polyline_all_zero_length_segments_is_degenerate() {
        let err = polyline(
            &[(1.0, 1.0), (1.0, 1.0), (1.0, 1.0)],
            2.0,
            Color::WHITE,
            id(),
        )
        .unwrap_err();
        assert_eq!(err, GeometryError::DegenerateShape);
    }

    #[test]
    fn circle_builds_center_plus_segment_vertices() {
        let (v, i) = circle((0.0, 0.0), 10.0, 8, Color::WHITE, id()).unwrap();
        assert_eq!(v.len(), 9);
        assert_eq!(i.len(), 8 * 3);
    }

    #[test]
    fn circle_rejects_too_few_segments() {
        let err = circle((0.0, 0.0), 10.0, 2, Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::TooManyVertices);
    }

    #[test]
    fn circle_rejects_too_many_segments() {
        let err = circle(
            (0.0, 0.0),
            10.0,
            MAX_CIRCLE_SEGMENTS + 1,
            Color::WHITE,
            id(),
        )
        .unwrap_err();
        assert_eq!(err, GeometryError::TooManyVertices);
    }

    #[test]
    fn circle_rejects_zero_radius() {
        let err = circle((0.0, 0.0), 0.0, 8, Color::WHITE, id()).unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn curve_flatten_terminates_for_degenerate_coincident_points() {
        let p = (5.0, 5.0);
        let points = flatten_cubic_bezier(p, p, p, p, 0.01).unwrap();
        // A fully collapsed curve is flat immediately: start and end only.
        assert_eq!(points, vec![p, p]);
    }

    #[test]
    fn curve_flatten_is_bounded_for_tiny_tolerance() {
        let points = flatten_cubic_bezier(
            (0.0, 0.0),
            (0.0, 100.0),
            (100.0, 100.0),
            (100.0, 0.0),
            // A tolerance far smaller than float precision can resolve:
            // the depth bound must still stop recursion.
            1.0e-12,
        )
        .unwrap();
        let max_points = (1usize << MAX_CURVE_SUBDIVISION_DEPTH) + 1;
        assert!(points.len() <= max_points);
        assert!(points.len() > 2);
    }

    #[test]
    fn curve_flatten_rejects_non_finite_control_point() {
        let err = flatten_cubic_bezier(
            (0.0, 0.0),
            (f32::INFINITY, 0.0),
            (1.0, 1.0),
            (2.0, 0.0),
            0.1,
        )
        .unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn curve_flatten_rejects_non_finite_tolerance() {
        let err = flatten_cubic_bezier((0.0, 0.0), (1.0, 1.0), (2.0, 1.0), (3.0, 0.0), f32::NAN)
            .unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn curve_flatten_rejects_zero_tolerance() {
        let err =
            flatten_cubic_bezier((0.0, 0.0), (1.0, 1.0), (2.0, 1.0), (3.0, 0.0), 0.0).unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn cubic_curve_stroke_builds_geometry_for_a_simple_curve() {
        let (v, i) = cubic_curve_stroke(
            (0.0, 0.0),
            (10.0, 50.0),
            (40.0, 50.0),
            (50.0, 0.0),
            0.5,
            2.0,
            Color::WHITE,
            id(),
        )
        .unwrap();
        assert!(!v.is_empty());
        assert_eq!(i.len() % 6, 0);
    }

    #[test]
    fn vertex_color_is_premultiplied() {
        let (v, _) = rectangle(
            Rect::new(0.0, 0.0, 1.0, 1.0),
            Color::new(1.0, 1.0, 1.0, 0.5),
            id(),
        )
        .unwrap();
        for vert in v {
            assert_eq!(vert.color, [0.5, 0.5, 0.5, 0.5]);
        }
    }
}
