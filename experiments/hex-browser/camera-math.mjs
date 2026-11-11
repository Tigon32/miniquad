// Shared camera/hex-geometry math for the hex-offline browser spec.
// Deliberately re-derives the same formulas documented in
// `docs/hex-voxel-contract.md` section 1.5 and `companions/voxel/src/
// camera.rs`/`hex.rs`, in JS, so Playwright can compute real
// screen-space pixel coordinates for a cell's center/corners without
// adding a JS export to the Rust example (no new WASM ABI surface for
// this). Any mismatch between this file and the Rust source would
// show up as a failing test, not a silent pass.
export const HEX_X_STEP = 0.5;
export const HEX_Z_STEP = 0.866_025_4;
export const HEX_LAYER_HEIGHT = 1.0;
const CORNER_KX = [2, 1, -1, -2, -1, 1];
const CORNER_KZ = [0, 1, 1, 0, -1, -1];

export function hexCellCenter(q, r, layer) {
    return [
        3 * q * HEX_X_STEP,
        (2 * layer + 1) * (HEX_LAYER_HEIGHT * 0.5),
        (2 * r + q) * HEX_Z_STEP
    ];
}

// Returns the 12 world-space corners: 0..6 bottom ring, 6..12 top ring
// (matching `HexCell::corners`).
export function hexCellCorners(q, r, layer) {
    const bottomY = layer * HEX_LAYER_HEIGHT;
    const topY = (layer + 1) * HEX_LAYER_HEIGHT;
    const out = new Array(12);
    for (let k = 0; k < 6; k++) {
        const x = (3 * q + CORNER_KX[k]) * HEX_X_STEP;
        const z = (2 * r + q + CORNER_KZ[k]) * HEX_Z_STEP;
        out[k] = [x, bottomY, z];
        out[k + 6] = [x, topY, z];
    }
    return out;
}

function vecSub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vecCross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vecDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vecNormalize(a) {
    const len = Math.sqrt(vecDot(a, a));
    if (len === 0) return [0, 0, 0];
    return [a[0] / len, a[1] / len, a[2] / len];
}

// Column-major 4x4, matching miniquad_voxel::math::Mat4's layout.
function lookAtRh(eye, target, up) {
    const f = vecNormalize(vecSub(target, eye));
    const s = vecNormalize(vecCross(f, up));
    const u = vecCross(s, f);
    return [
        s[0], u[0], -f[0], 0,
        s[1], u[1], -f[1], 0,
        s[2], u[2], -f[2], 0,
        -vecDot(s, eye), -vecDot(u, eye), vecDot(f, eye), 1
    ];
}

function perspectiveRhGl(fovYRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovYRadians * 0.5);
    const rangeInv = 1 / (near - far);
    return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (near + far) * rangeInv, -1,
        0, 0, 2 * far * near * rangeInv, 0
    ];
}

function mat4MulVec4(m, v) {
    const out = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) {
        out[row] = m[0 * 4 + row] * v[0] + m[1 * 4 + row] * v[1] + m[2 * 4 + row] * v[2] + m[3 * 4 + row] * v[3];
    }
    return out;
}
function mat4Mul(a, b) {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

// Matches `offline_hex.rs`'s fixed camera start values: target
// (0, 1.5, 0), distance 14.0, yaw 0.6, pitch 0.5 (OrbitCamera::new
// order is target, distance, yaw, pitch).
export const CAMERA = { target: [0, 1.5, 0], distance: 14.0, yaw: 0.6, pitch: 0.5 };

function cameraEye(camera) {
    const cp = Math.cos(camera.pitch);
    return [
        camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
        camera.target[1] + camera.distance * Math.sin(camera.pitch),
        camera.target[2] + camera.distance * cp * Math.cos(camera.yaw)
    ];
}

// Projects a world-space point to a backing-store pixel [x, y] (origin
// top-left, +y down), given the backing-store viewport size. Returns
// null if the point is behind the camera (w <= 0).
export function projectToPixel(camera, worldPoint, viewport) {
    const eye = cameraEye(camera);
    const view = lookAtRh(eye, camera.target, [0, 1, 0]);
    const aspect = viewport[0] / viewport[1];
    const proj = perspectiveRhGl((45 * Math.PI) / 180, aspect, 0.1, 500.0);
    const viewProjection = mat4Mul(proj, view);
    const clip = mat4MulVec4(viewProjection, [worldPoint[0], worldPoint[1], worldPoint[2], 1]);
    if (clip[3] <= 0) return null;
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    return [((ndcX + 1) / 2) * viewport[0], ((1 - ndcY) / 2) * viewport[1]];
}
