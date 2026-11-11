// miniquad-webgpu-proof/1 invalid shader. The fragment result has three components, not four.
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec3<f32>(1.0, 0.0, 0.0);
}
