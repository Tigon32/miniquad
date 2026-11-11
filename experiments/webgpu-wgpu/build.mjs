import {execFileSync} from "node:child_process";
import {mkdirSync, copyFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const cargo = process.env.CARGO ?? "cargo";
const generator = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const expected = "wasm-bindgen 0.2.130";
const installed = execFileSync(generator, ["--version"], {encoding: "utf8"}).trim();
if (installed !== expected) throw new Error(`Expected ${expected}, got ${installed}`);
const run = (command, args) => execFileSync(command, args, {cwd: root, stdio: "inherit"});
run(cargo, ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"]);
mkdirSync(join(root, "dist", "pkg"), {recursive: true});
run(generator, [
    "--target", "web",
    "--out-dir", join(root, "dist", "pkg"),
    join(root, "target", "wasm32-unknown-unknown", "release", "webgpu_wgpu_proof.wasm"),
]);
for (const name of ["index.html", "host.js"]) {
    copyFileSync(join(root, "web", name), join(root, "dist", name));
}
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify({
    candidate: "wgpu",
    command: "node experiments/webgpu-wgpu/build.mjs",
    rust: execFileSync(cargo, ["--version"], {cwd: root, encoding: "utf8"}).trim(),
    wasmBindgen: installed,
    target: "wasm32-unknown-unknown",
}, null, 2) + "\n");
