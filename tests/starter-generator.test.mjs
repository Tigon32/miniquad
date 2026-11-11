import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GeneratorError,
  checkToolchain,
  resolveMiniquadSource,
  readRequiredWebAssets,
  generateProject,
} from "../scripts/create-browser-project.mjs";
import { resolveSafePath, parseArgs as parseServeArgs, MIME_TYPES } from "../templates/browser/project-scripts/serve.mjs";
import {
  sha256 as buildSha256,
  updateManifestWithBuildOutputs,
} from "../templates/browser/project-scripts/build.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Creates scratch directories inside the repository (never under the
// OS temp directory) so fixtures stay visible, reviewable, and are
// removed deterministically by each test.
function makeScratchDir(prefix) {
  const scratchRoot = join(REPO_ROOT, ".generator-test-scratch");
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(join(scratchRoot, prefix));
}

function fakeExecFileSync({ hasCargo = true, hasRustup = true, hasWasmTarget = true } = {}) {
  return (command, args) => {
    if (command === "cargo") {
      if (!hasCargo) {
        throw new Error("cargo not found");
      }
      return "cargo 1.99.0";
    }
    if (command === "rustup") {
      if (!hasRustup) {
        throw new Error("rustup not found");
      }
      if (args[0] === "target" && args[1] === "list") {
        return hasWasmTarget
          ? "wasm32-unknown-unknown (installed)\n"
          : "x86_64-apple-darwin (installed)\n";
      }
      return "";
    }
    if (command === "git") {
      throw new Error("not a git checkout in this fake");
    }
    throw new Error(`unexpected command in fake: ${command}`);
  };
}

test("checkToolchain fails with an actionable error when cargo is missing", () => {
  assert.throws(
    () => checkToolchain({ execFileSyncImpl: fakeExecFileSync({ hasCargo: false }) }),
    (error) => {
      assert.ok(error instanceof GeneratorError);
      assert.match(error.message, /cargo/i);
      assert.match(error.message, /rustup\.rs/);
      return true;
    }
  );
});

test("checkToolchain fails with an actionable error when the wasm32 target is missing", () => {
  assert.throws(
    () => checkToolchain({ execFileSyncImpl: fakeExecFileSync({ hasWasmTarget: false }) }),
    (error) => {
      assert.ok(error instanceof GeneratorError);
      assert.match(error.message, /wasm32-unknown-unknown/);
      assert.match(error.message, /rustup target add/);
      return true;
    }
  );
});

test("resolveMiniquadSource in path mode requires an absolute --miniquad-path", () => {
  assert.throws(
    () => resolveMiniquadSource({ source: "path", miniquadPath: "relative/path" }),
    /absolute path/
  );
});

test("resolveMiniquadSource in git mode requires an explicit --git-repo and never silently defaults to a network fetch", () => {
  assert.throws(
    () => resolveMiniquadSource({ source: "git", rev: "abc123" }),
    /--git-repo is required/
  );
});

test("readRequiredWebAssets reports every missing browser-adoption file in one actionable error", () => {
  const scratch = makeScratchDir("missing-assets-");
  try {
    writeFileSync(join(scratch, "Cargo.toml"), "[package]\nname = \"miniquad\"\n");
    mkdirSync(join(scratch, "js"), { recursive: true });
    writeFileSync(join(scratch, "js", "gl.js"), "// only gl.js exists so far\n");

    const source = resolveMiniquadSource(
      { source: "path", miniquadPath: scratch },
      { execFileSyncImpl: fakeExecFileSync() }
    );

    assert.throws(
      () => readRequiredWebAssets(source),
      (error) => {
        assert.ok(error instanceof GeneratorError);
        assert.match(error.message, /miniquad\.mjs/);
        assert.match(error.message, /runtime\.html/);
        assert.match(error.message, /runtime\.mjs/);
        assert.match(error.message, /host-preferences\.mjs/);
        assert.doesNotMatch(error.message, /gl\.js/);
        return true;
      }
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("generateProject refuses to overwrite an existing destination", () => {
  const scratch = makeScratchDir("existing-dest-");
  try {
    assert.throws(
      () =>
        generateProject(
          scratch,
          { source: "path", miniquadPath: scratch },
          { execFileSyncImpl: fakeExecFileSync() }
        ),
      /already exists/
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("generateProject writes a fresh project with a path dependency, copied assets, and a hash manifest", () => {
  const scratchRoot = makeScratchDir("generate-ok-");
  const sourceDir = join(scratchRoot, "source");
  const destinationDir = join(scratchRoot, "project");
  try {
    mkdirSync(join(sourceDir, "js"), { recursive: true });
    writeFileSync(join(sourceDir, "Cargo.toml"), "[package]\nname = \"miniquad\"\n");
    const assetContents = {
      "gl.js": "// gl.js fixture\n",
      "miniquad.mjs": "// miniquad.mjs fixture\n",
      "runtime.html": "<!-- runtime.html fixture -->\n",
      "runtime.mjs": "// runtime.mjs fixture\n",
      "host-preferences.mjs": "// host-preferences.mjs fixture\n",
    };
    for (const [name, contents] of Object.entries(assetContents)) {
      writeFileSync(join(sourceDir, "js", name), contents);
    }

    const result = generateProject(
      destinationDir,
      {
        source: "path",
        miniquadPath: sourceDir,
        name: "Demo App!!",
        title: "Demo App",
      },
      { execFileSyncImpl: fakeExecFileSync() }
    );

    assert.equal(result.name, "demo-app");
    assert.ok(existsSync(join(destinationDir, "Cargo.toml")));
    assert.ok(existsSync(join(destinationDir, "src", "main.rs")));
    assert.ok(existsSync(join(destinationDir, "scripts", "build.mjs")));
    assert.ok(existsSync(join(destinationDir, "scripts", "serve.mjs")));

    const cargoToml = readFileSync(join(destinationDir, "Cargo.toml"), "utf8");
    assert.match(cargoToml, new RegExp(`path = "${sourceDir}"`));
    assert.match(cargoToml, /name = "demo-app"/);

    const buildScript = readFileSync(join(destinationDir, "scripts", "build.mjs"), "utf8");
    assert.match(buildScript, /PACKAGE_NAME = "demo-app"/);

    const indexHtml = readFileSync(join(destinationDir, "web", "index.html"), "utf8");
    assert.match(indexHtml, /Demo App/);
    assert.match(indexHtml, /import \{ mount \} from "\.\/miniquad\.mjs"/);
    assert.match(
      indexHtml,
      /import \{ createHostPreferences, parseHostURLState \} from "\.\/host-preferences\.mjs"/
    );
    assert.match(indexHtml, /app\.supportsParameters/);
    assert.match(indexHtml, /paused: window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
    assert.match(indexHtml, /prefs\?\.setMotionOverride\("paused"\)/);
    assert.match(indexHtml, /prefs\?\.setMotionOverride\("running"\)/);
    assert.match(indexHtml, /prefs\?\.setSpeed/);
    assert.match(indexHtml, /prefs\?\.refreshPalette/);
    assert.match(indexHtml, /--miniquad-foreground/);
    assert.match(indexHtml, /--miniquad-background/);
    assert.match(indexHtml, /miniquaderror/);
    assert.match(indexHtml, /window\.addEventListener\("pagehide"/);
    // Color (and speed) controls must react to both "input" (live drag) and
    // "change" (commit) events: some browsers/automation drivers only fire
    // one of the two for a programmatic or picker-driven value change.
    assert.match(indexHtml, /speedInput\.addEventListener\("input", applySpeedInput\)/);
    assert.match(indexHtml, /speedInput\.addEventListener\("change", applySpeedInput\)/);
    assert.match(indexHtml, /input\.addEventListener\("input", applyColorInput\)/);
    assert.match(indexHtml, /input\.addEventListener\("change", applyColorInput\)/);
    assert.doesNotMatch(indexHtml, /app\.setParameters/);
    assert.doesNotMatch(indexHtml, /beforeunload/);

    const manifest = JSON.parse(
      readFileSync(join(destinationDir, "web", "MANIFEST.json"), "utf8")
    );
    assert.equal(manifest.files.length, 5);
    const byFile = Object.fromEntries(manifest.files.map((entry) => [entry.file, entry]));
    for (const [name, contents] of Object.entries(assetContents)) {
      assert.ok(byFile[name], `manifest is missing ${name}`);
      const onDisk = readFileSync(join(destinationDir, "web", name), "utf8");
      assert.equal(onDisk, contents);
      assert.equal(byFile[name].sha256.length, 64);
    }

    // The shipped manifest's "source" field is sanitized provenance only
    // (mode/sha/dirty): it must never carry the absolute local checkout
    // path, which would otherwise leak the generating developer's home
    // directory into a public deploy artifact.
    assert.deepEqual(Object.keys(manifest.source).sort(), ["dirty", "mode", "sha"]);
    assert.equal(manifest.source.mode, "path");
    assert.equal(typeof manifest.source.dirty, "boolean");
    const manifestText = readFileSync(join(destinationDir, "web", "MANIFEST.json"), "utf8");
    assert.doesNotMatch(manifestText, new RegExp(sourceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(manifestText, /\/Users\//);
    assert.doesNotMatch(manifestText, /\/home\//);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("generated Rust app exports the frozen app-parameters surface", () => {
  const mainRs = readFileSync(
    join(REPO_ROOT, "templates", "browser", "rust", "src", "main.rs"),
    "utf8"
  );
  assert.match(mainRs, /pub extern "C" fn mq_params_version\(\) -> u32/);
  assert.match(mainRs, /pub extern "C" fn mq_param_set_f32\(id: u32, value: f32\) -> i32/);
  assert.match(mainRs, /pub extern "C" fn mq_param_set_rgba8\(id: u32, color: u32\) -> i32/);
  assert.match(mainRs, /AtomicU32/);
});

test("resolveMiniquadSource git-mode provenance never carries the dependency URL", () => {
  const scratch = makeScratchDir("git-provenance-");
  try {
    const source = resolveMiniquadSource(
      {
        source: "git",
        rev: "deadbeefcafe",
        gitUrl: "https://ci-token:super-secret@github.com/Tigon32/miniquad.git",
        gitRepo: scratch,
      },
      { execFileSyncImpl: fakeExecFileSync() }
    );
    assert.deepEqual(Object.keys(source.provenance).sort(), ["dirty", "mode", "sha"]);
    assert.equal(source.provenance.mode, "git");
    assert.equal(source.provenance.sha, "deadbeefcafe");
    assert.equal(source.provenance.dirty, false);
    const serialized = JSON.stringify(source.provenance);
    assert.doesNotMatch(serialized, /ci-token/);
    assert.doesNotMatch(serialized, /super-secret/);
    assert.doesNotMatch(serialized, /github\.com/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("build.mjs records final app.wasm/index.html hashes without dropping source-copied entries or provenance", () => {
  const scratchRoot = makeScratchDir("generate-then-build-");
  const sourceDir = join(scratchRoot, "source");
  const destinationDir = join(scratchRoot, "project");
  try {
    mkdirSync(join(sourceDir, "js"), { recursive: true });
    writeFileSync(join(sourceDir, "Cargo.toml"), "[package]\nname = \"miniquad\"\n");
    const assetContents = {
      "gl.js": "// gl.js fixture\n",
      "miniquad.mjs": "// miniquad.mjs fixture\n",
      "runtime.html": "<!-- runtime.html fixture -->\n",
      "runtime.mjs": "// runtime.mjs fixture\n",
      "host-preferences.mjs": "// host-preferences.mjs fixture\n",
    };
    for (const [name, contents] of Object.entries(assetContents)) {
      writeFileSync(join(sourceDir, "js", name), contents);
    }

    generateProject(
      destinationDir,
      { source: "path", miniquadPath: sourceDir, name: "Demo App!!", title: "Demo App" },
      { execFileSyncImpl: fakeExecFileSync() }
    );

    const webDir = join(destinationDir, "web");
    const beforeManifest = JSON.parse(readFileSync(join(webDir, "MANIFEST.json"), "utf8"));
    assert.equal(beforeManifest.files.length, 5);

    // Simulate what scripts/build.mjs does after a real cargo build:
    // hash the two files it produces/finalizes and merge them in.
    const wasmBytes = Buffer.from("fake wasm bytes for this test");
    const indexHtmlBytes = readFileSync(join(webDir, "index.html"));
    const afterManifest = updateManifestWithBuildOutputs(webDir, [
      { file: "app.wasm", sha256: buildSha256(wasmBytes), bytes: wasmBytes.length },
      { file: "index.html", sha256: buildSha256(indexHtmlBytes), bytes: indexHtmlBytes.length },
    ]);

    assert.equal(afterManifest.files.length, 7);
    assert.deepEqual(afterManifest.source, beforeManifest.source);
    const byFile = Object.fromEntries(afterManifest.files.map((entry) => [entry.file, entry]));
    assert.equal(byFile["app.wasm"].sha256, buildSha256(wasmBytes));
    assert.equal(byFile["app.wasm"].bytes, wasmBytes.length);
    assert.equal(byFile["index.html"].sha256, buildSha256(indexHtmlBytes));
    assert.equal(byFile["index.html"].bytes, indexHtmlBytes.length);
    for (const name of Object.keys(assetContents)) {
      assert.ok(byFile[name], `build step must not drop the generator's ${name} entry`);
    }

    // Reading the manifest back off disk must reflect the merge, and a
    // second build (e.g. a rebuild) must update rather than duplicate.
    const onDiskManifest = JSON.parse(readFileSync(join(webDir, "MANIFEST.json"), "utf8"));
    assert.equal(onDiskManifest.files.length, 7);
    const rebuiltWasmBytes = Buffer.from("different fake wasm bytes");
    const rebuiltManifest = updateManifestWithBuildOutputs(webDir, [
      { file: "app.wasm", sha256: buildSha256(rebuiltWasmBytes), bytes: rebuiltWasmBytes.length },
    ]);
    assert.equal(rebuiltManifest.files.length, 7);
    const rebuiltByFile = Object.fromEntries(rebuiltManifest.files.map((entry) => [entry.file, entry]));
    assert.equal(rebuiltByFile["app.wasm"].sha256, buildSha256(rebuiltWasmBytes));
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("static server resolveSafePath keeps every request inside the web root", () => {
  const webRoot = "/srv/web";
  assert.equal(resolveSafePath("/index.html", "", webRoot), "/srv/web/index.html");
  assert.equal(
    resolveSafePath("/app/index.html", "/app", webRoot),
    "/srv/web/index.html"
  );
  assert.equal(resolveSafePath("/../../etc/passwd", "", webRoot), "/srv/web/etc/passwd");
  assert.equal(
    resolveSafePath("/%2e%2e/%2e%2e/etc/passwd", "", webRoot),
    "/srv/web/etc/passwd"
  );
  assert.equal(resolveSafePath("/index.html", "/app", webRoot), null);
});

test("static server MIME map assigns application/wasm to .wasm files", () => {
  assert.equal(MIME_TYPES[".wasm"], "application/wasm");
  assert.equal(MIME_TYPES[".mjs"], "text/javascript; charset=utf-8");
  assert.equal(MIME_TYPES[".html"], "text/html; charset=utf-8");
});

test("static server CLI arg parsing normalizes a subpath base", () => {
  assert.deepEqual(parseServeArgs(["--port", "9000", "--base", "my-app"]), {
    port: 9000,
    base: "/my-app",
  });
  assert.deepEqual(parseServeArgs([]), { port: 8080, base: "" });
});
