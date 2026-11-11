// Builds the offline_hex example twice (WebGL1 default, WebGL2
// feature) into two dedicated, gitignored target directories before
// the private hex browser harness serves them. This keeps the
// fixtures hermetic and real: no stale or silently prebuilt artifact
// is served, and a missing Rust/wasm32 toolchain fails loudly here
// instead of surfacing as a confusing 404 or stale WASM later.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const voxelCrate = resolve(repoRoot, "companions/voxel");

function build(targetDirName, extraArgs) {
    const env = { ...process.env, CARGO_TARGET_DIR: targetDirName };
    const args = [
        "build",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--example",
        "offline_hex",
        ...extraArgs
    ];
    console.log("hex-browser fixtures: cargo " + args.join(" ") + " (CARGO_TARGET_DIR=" + targetDirName + ")");
    execFileSync("cargo", args, { cwd: voxelCrate, env, stdio: "inherit" });
    const wasmPath = resolve(voxelCrate, targetDirName, "wasm32-unknown-unknown/release/examples/offline_hex.wasm");
    if (!existsSync(wasmPath)) {
        throw new Error("Expected build output missing: " + wasmPath);
    }
    return wasmPath;
}

export function buildHexFixtures() {
    const webgl1 = build("target-webgl1", []);
    const webgl2 = build("target-webgl2", ["--features", "webgl2"]);
    return { webgl1, webgl2 };
}

// Builds the UNCHANGED cubic `offline` example for a paired measurement
// of the current examples. Their cell counts differ and are reported;
// this is not an equal-workload performance comparison. Build it into
// its own gitignored target directory, the same hermetic way as the
// hex fixtures above. Never edit `offline.rs`; only add a build step
// for it here, inside this private harness.
export function buildCubicMeasurementFixture() {
    const env = { ...process.env, CARGO_TARGET_DIR: "target-cubic" };
    const args = ["build", "--release", "--target", "wasm32-unknown-unknown", "--example", "offline"];
    console.log("hex-browser fixtures: cargo " + args.join(" ") + " (CARGO_TARGET_DIR=target-cubic)");
    execFileSync("cargo", args, { cwd: voxelCrate, env, stdio: "inherit" });
    const wasmPath = resolve(voxelCrate, "target-cubic/wasm32-unknown-unknown/release/examples/offline.wasm");
    if (!existsSync(wasmPath)) {
        throw new Error("Expected build output missing: " + wasmPath);
    }
    return wasmPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    buildHexFixtures();
    buildCubicMeasurementFixture();
}
