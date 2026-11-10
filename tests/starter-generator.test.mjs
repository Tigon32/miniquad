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
