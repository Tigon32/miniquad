#!/usr/bin/env node
// Generates a standalone, external Rust + browser project that embeds
// Miniquad through the optional browser adoption layer (see MADR 0009,
// proposed). Uses only Node.js builtins; no npm dependencies.
//
// Usage:
//   node scripts/create-browser-project.mjs <destination> \
//     --source path --miniquad-path /abs/path/to/miniquad [--name my-app]
//
//   node scripts/create-browser-project.mjs <destination> \
//     --source git --git-url https://github.com/Tigon32/miniquad.git \
//     --rev f837a98d415262320a8c66ef9f8024d8f2faeab1 \
//     --git-repo /abs/path/to/local/clone
//
// The destination directory must not already exist. The generator
// writes it fresh; it never overwrites an existing project.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(THIS_FILE));
const TEMPLATES_ROOT = join(REPO_ROOT, "templates", "browser");
const WASM_TARGET = "wasm32-unknown-unknown";
// Pin a browser-tested source. The earlier baseline lacks embedding assets.
const DEFAULT_BASELINE_REV = "f837a98d415262320a8c66ef9f8024d8f2faeab1";
const DEFAULT_GIT_URL = "https://github.com/Tigon32/miniquad.git";

const REQUIRED_WEB_ASSETS = [
  "js/gl.js",
  "js/miniquad.mjs",
  "js/runtime.html",
  "js/runtime.mjs",
  "js/host-preferences.mjs",
];

export class GeneratorError extends Error {}

function fail(message) {
  throw new GeneratorError(message);
}

function readTemplate(relativePath) {
  return readFileSync(join(TEMPLATES_ROOT, relativePath), "utf8");
}

function applyTokens(text, tokens) {
  let result = text;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Checks that `cargo` and the wasm32-unknown-unknown target are
 * available, producing an actionable error naming the exact missing
 * tool and the command to install it. Does not run a build. */
export function checkToolchain({ execFileSyncImpl = execFileSync } = {}) {
  const missing = [];

  try {
    execFileSyncImpl("cargo", ["--version"], { stdio: "pipe" });
  } catch {
    fail(
      "Rust's cargo was not found on PATH. Install Rust from " +
        "https://rustup.rs, then re-run this generator."
    );
  }

  try {
    const output = execFileSyncImpl(
      "rustup",
      ["target", "list", "--installed"],
      { stdio: "pipe", encoding: "utf8" }
    );
    if (!output.split(/\s+/).includes(WASM_TARGET)) {
      missing.push(WASM_TARGET);
    }
  } catch {
    // rustup is not required by itself; cargo build will fail later
    // with its own actionable "target may not be installed" error if
    // the target truly is missing.
  }

  if (missing.length > 0) {
    fail(
      `Required Rust target is not installed: ${missing.join(", ")}.\n` +
        `Run: rustup target add ${missing.join(" ")}`
    );
  }
}

/** Resolves where to read the Miniquad source files (Cargo path
 * dependency root or an immutable git revision) and how to express
 * that choice in the generated Cargo.toml. Never defaults to an
 * unreviewed upstream source; callers must name a revision or path
 * explicitly. */
export function resolveMiniquadSource(options, { execFileSyncImpl = execFileSync } = {}) {
  const source = options.source || "path";

  if (source === "path") {
    const miniquadPath = options.miniquadPath;
    if (!miniquadPath) {
      fail(
        "--miniquad-path is required when --source path is used. " +
          "Supply an absolute path to a local Miniquad checkout."
      );
    }
    if (!isAbsolute(miniquadPath)) {
      fail(`--miniquad-path must be an absolute path, got: ${miniquadPath}`);
    }
    if (!existsSync(join(miniquadPath, "Cargo.toml"))) {
      fail(
        `No Cargo.toml found at: ${miniquadPath}\n` +
          "Confirm --miniquad-path points at a Miniquad checkout root."
      );
    }

    // `label` is console/CLI-facing only (see the "Source: ..." line in
    // main()); it may name the local checkout path because it is never
    // written to a file. `provenance` is what ends up in the shipped
    // web/MANIFEST.json, and must never carry an absolute local path or
    // a credentialed URL -- only the source mode, the resolved commit
    // SHA (or null if it could not be determined), and a dirty flag.
    let label = `local path dependency: ${miniquadPath}`;
    let sha = null;
    let dirtyFlag = false;
    try {
      const rev = execFileSyncImpl("git", ["-C", miniquadPath, "rev-parse", "HEAD"], {
        stdio: "pipe",
        encoding: "utf8",
      }).trim();
      sha = rev;
      let dirty = "";
      try {
        execFileSyncImpl("git", ["-C", miniquadPath, "diff", "--quiet"], {
          stdio: "pipe",
        });
      } catch {
        dirty = " (working tree has uncommitted changes)";
        dirtyFlag = true;
      }
      label = `local path dependency: ${miniquadPath} at ${rev}${dirty}`;
    } catch {
      // Not a git checkout, or git is unavailable. The path label
      // above is still accurate for the console; sha stays null.
    }

    return {
      mode: "path",
      label,
      provenance: { mode: "path", sha, dirty: dirtyFlag },
      dependencyToml: `path = "${miniquadPath}"`,
      readAsset(relativePath) {
        const fullPath = join(miniquadPath, relativePath);
        if (!existsSync(fullPath)) {
          return null;
        }
        return readFileSync(fullPath);
      },
    };
  }

  if (source === "git") {
    const rev = options.rev || DEFAULT_BASELINE_REV;
    const gitUrl = options.gitUrl || DEFAULT_GIT_URL;
    const gitRepo = options.gitRepo;
    if (!gitRepo) {
      fail(
        "--git-repo is required when --source git is used. Supply an " +
          "absolute path to a local clone that has the requested " +
          `revision (${rev}) available, so this generator can copy ` +
          "exact browser asset bytes without a network fetch."
      );
    }
    if (!isAbsolute(gitRepo)) {
      fail(`--git-repo must be an absolute path, got: ${gitRepo}`);
    }

    // Resolve `--rev` to the full 40-character commit SHA it names in
    // `--git-repo`, rather than trusting it as-is. A short or symbolic
    // `--rev` (e.g. "ba0ab9f", "main") is ambiguous: it can name a
    // different commit in a different clone, or start naming a
    // different commit later as the repository gains objects. Pinning
    // Cargo.toml and the shipped manifest to anything less than the
    // full, verified SHA risks a mismatch between the asset bytes this
    // generator copied and the commit Cargo later resolves and builds.
    let resolvedSha;
    try {
      resolvedSha = execFileSyncImpl(
        "git",
        ["-C", gitRepo, "rev-parse", "--verify", `${rev}^{commit}`],
        { stdio: "pipe", encoding: "utf8" }
      ).trim();
    } catch {
      fail(
        `Could not resolve --rev "${rev}" to a commit in --git-repo: ` +
          `${gitRepo}\n` +
          "Confirm the revision exists in that local clone (try " +
          "`git log` there) and names a commit, not a tree or blob."
      );
    }
    if (!/^[0-9a-f]{40}$/.test(resolvedSha)) {
      fail(
        `--rev "${rev}" resolved to "${resolvedSha}", which is not a ` +
          "full 40-character commit SHA. Refusing to continue: a short " +
          "or non-standard hash risks a mismatch between the copied " +
          "browser assets and the pinned Cargo dependency."
      );
    }

    return {
      mode: "git",
      label:
        `git revision ${resolvedSha} (requested as "${rev}", ` +
        `dependency fetched from ${gitUrl})`,
      // `resolvedSha` is the full, verified commit SHA, so
      // `git show <resolvedSha>:<path>` reads the exact committed bytes
      // regardless of the local clone's working-tree state; "dirty" has
      // no meaning here. The dependency URL is deliberately left out of
      // provenance: this generator never asks for a credentialed URL,
      // but it also never assumes any URL supplied by a caller is safe
      // to publish verbatim.
      provenance: { mode: "git", sha: resolvedSha, dirty: false },
      dependencyToml: `git = "${gitUrl}", rev = "${resolvedSha}"`,
      readAsset(relativePath) {
        try {
          return execFileSyncImpl(
            "git",
            ["-C", gitRepo, "show", `${resolvedSha}:${relativePath}`],
            { stdio: "pipe" }
          );
        } catch {
          return null;
        }
      },
    };
  }

  fail(`Unknown --source value: ${source}. Use "path" or "git".`);
  return undefined;
}

/** Reads every required browser asset through `source.readAsset` and
 * fails with one actionable, itemized error if any are missing. */
export function readRequiredWebAssets(source) {
  const assets = new Map();
  const missing = [];
  for (const relativePath of REQUIRED_WEB_ASSETS) {
    const bytes = source.readAsset(relativePath);
    if (bytes === null) {
      missing.push(relativePath);
    } else {
      assets.set(relativePath, bytes);
    }
  }
  if (missing.length > 0) {
    fail(
      "The selected Miniquad source is missing required browser " +
        `files: ${missing.join(", ")}.\n` +
        "These files are supplied by the optional browser adoption " +
        "layer (MADR 0009, proposed) and land through separate " +
        "integration work. Re-run this generator once they exist in " +
        "the selected source revision."
    );
  }
  return assets;
}

function sanitizePackageName(name) {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) {
    fail(`Could not derive a valid Cargo package name from: "${name}"`);
  }
  return cleaned;
}

/** Writes a fresh external project into `destination`. Fails if the
 * destination already exists. Returns the resolved options used, for
 * logging. */
export function generateProject(destination, rawOptions, deps = {}) {
  const execFileSyncImpl = deps.execFileSyncImpl || execFileSync;

  const destinationPath = resolve(destination);
  if (existsSync(destinationPath)) {
    fail(
      `Destination already exists: ${destinationPath}\n` +
        "This generator only writes a fresh project. Choose a new, " +
        "empty path."
    );
  }

  const name = sanitizePackageName(rawOptions.name || basename(destinationPath));
  const title = rawOptions.title || name;

  checkToolchain({ execFileSyncImpl });
  const source = resolveMiniquadSource(rawOptions, { execFileSyncImpl });
  const assets = readRequiredWebAssets(source);

  // Only after every precondition passes do we write anything, so a
  // failed generation never leaves a partial destination directory.
  mkdirSync(destinationPath, { recursive: true });
  mkdirSync(join(destinationPath, "src"), { recursive: true });
  mkdirSync(join(destinationPath, "web"), { recursive: true });
  mkdirSync(join(destinationPath, "scripts"), { recursive: true });

  const cargoToml = applyTokens(readTemplate("rust/Cargo.toml.template"), {
    PACKAGE_NAME: name,
    MINIQUAD_DEPENDENCY: source.dependencyToml,
  });
  writeFileSync(join(destinationPath, "Cargo.toml"), cargoToml);

  copyFileSync(
    join(TEMPLATES_ROOT, "rust", "src", "main.rs"),
    join(destinationPath, "src", "main.rs")
  );

  const indexHtml = applyTokens(readTemplate("web/index.html.template"), {
    TITLE: title,
  });
  writeFileSync(join(destinationPath, "web", "index.html"), indexHtml);

  // web/MANIFEST.json is shipped alongside the deployed project, so its
  // "source" field is the sanitized provenance object (mode/sha/dirty),
  // never source.label: label may contain an absolute local checkout
  // path, which must not leak into a public deploy artifact.
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: source.provenance,
    files: [],
  };
  for (const relativePath of REQUIRED_WEB_ASSETS) {
    const bytes = assets.get(relativePath);
    const outName = basename(relativePath);
    writeFileSync(join(destinationPath, "web", outName), bytes);
    manifest.files.push({
      file: outName,
      sourcePath: relativePath,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }
  writeFileSync(
    join(destinationPath, "web", "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const buildScript = applyTokens(
    readTemplate("project-scripts/build.mjs"),
    { PACKAGE_NAME: name }
  );
  writeFileSync(join(destinationPath, "scripts", "build.mjs"), buildScript);
  copyFileSync(
    join(TEMPLATES_ROOT, "project-scripts", "serve.mjs"),
    join(destinationPath, "scripts", "serve.mjs")
  );

  const readme = applyTokens(
    readTemplate("project-scripts/README.md.template"),
    { TITLE: title }
  );
  writeFileSync(join(destinationPath, "README.md"), readme);
  writeFileSync(join(destinationPath, ".gitignore"), "/target\n");

  return { name, title, source: source.label, destination: destinationPath };
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      options.source = argv[++i];
    } else if (arg === "--miniquad-path") {
      options.miniquadPath = argv[++i];
    } else if (arg === "--git-url") {
      options.gitUrl = argv[++i];
    } else if (arg === "--git-repo") {
      options.gitRepo = argv[++i];
    } else if (arg === "--rev") {
      options.rev = argv[++i];
    } else if (arg === "--name") {
      options.name = argv[++i];
    } else if (arg === "--title") {
      options.title = argv[++i];
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) {
    fail(
      "Usage: node scripts/create-browser-project.mjs <destination> " +
        "--source <path|git> [options]"
    );
  }
  return { destination: positionals[0], options };
}

function main() {
  const { destination, options } = parseArgs(process.argv.slice(2));
  try {
    const result = generateProject(destination, options);
    console.log(`Created project "${result.name}" at: ${result.destination}`);
    console.log(`Source: ${result.source}`);
    console.log("Next: cd into the project and run node scripts/build.mjs");
  } catch (error) {
    if (error instanceof GeneratorError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
