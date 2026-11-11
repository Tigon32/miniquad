#!/usr/bin/env node
// Fork-scoped browser release candidate tool for issue #19.
// Implements docs/adr/0010-browser-release-candidates.md and
// docs/release-candidate-contract.md exactly. Uses only Node.js builtin
// modules, Git, Cargo, `tar`, and the `gh` CLI. Does not add a dependency.
//
// Commands: label, prepare, verify, compare, collect-ci, gate.
// See the contract for the full rules. This file does not weaken any rule;
// an implementer who cannot satisfy a rule must stop and record the blocker
// instead (see the handoff notes recorded with this change).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_URL = "https://github.com/Tigon32/miniquad.git";
const REPOSITORY_HTTPS = "https://github.com/Tigon32/miniquad";
const TAG_PREFIX = "tigon32-miniquad-v";
const ABI_VERSION = 3;
const PARAMS_VERSION = 1;
const CARGO_PACKAGE_NAME = "miniquad";
const CARGO_PACKAGE_VERSION = "0.4.11";

// The five browser assets copied verbatim from the selected commit, plus
// the two assets this tool's own build step produces (app.wasm, index.html).
const SOURCE_COPIED_ASSETS = [
  "js/gl.js",
  "js/miniquad.mjs",
  "js/runtime.html",
  "js/runtime.mjs",
  "js/host-preferences.mjs",
];
const PAYLOAD_FILES = [
  "app.wasm",
  "gl.js",
  "host-preferences.mjs",
  "index.html",
  "miniquad.mjs",
  "runtime.html",
  "runtime.mjs",
].sort();

const LABEL_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-tigon32\.([1-9]\d*)\.(?:rc\.([1-9]\d*)|release)$/u;

export class ManifestError extends Error {
  constructor(rule, message) {
    super(`${rule}: ${message}`);
    this.name = "ManifestError";
    this.rule = rule;
  }
}

// ---------------------------------------------------------------------
// 2. Version and tag rules
// ---------------------------------------------------------------------

export function parseLabel(label) {
  if (typeof label !== "string") {
    throw new Error("label must be a string");
  }
  const match = LABEL_RE.exec(label);
  if (!match) {
    throw new Error(`Invalid release candidate label: ${label}`);
  }
  const [, major, minor, patch, forkSeq, rc] = match;
  return {
    core: { major: Number(major), minor: Number(minor), patch: Number(patch) },
    forkSeq: Number(forkSeq),
    stage: rc !== undefined ? "rc" : "release",
    rc: rc !== undefined ? Number(rc) : null,
  };
}

export function formatTag(label) {
  parseLabel(label);
  return `${TAG_PREFIX}${label}`;
}

export function parseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX)) {
    throw new Error(`Invalid release candidate tag: ${tag}`);
  }
  const label = tag.slice(TAG_PREFIX.length);
  parseLabel(label);
  return label;
}

function splitLabel(label) {
  const dashIndex = label.indexOf("-");
  const core = label
    .slice(0, dashIndex)
    .split(".")
    .map(Number);
  const prerelease = label.slice(dashIndex + 1).split(".");
  return { core, prerelease };
}

/** SemVer 2.0.0 prerelease identifier comparison: numeric identifiers
 * compare numerically and are always lower than alphanumeric ones; a
 * shorter identifier list with identical leading identifiers is lower. */
function comparePrerelease(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareLabels(a, b) {
  parseLabel(a);
  parseLabel(b);
  const left = splitLabel(a);
  const right = splitLabel(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i] < right.core[i] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function deriveCore(previousCore, { rustApiBreaking, browserProtocolBreaking, changed }) {
  const { major, minor, patch } = previousCore;
  const breaking = Boolean(rustApiBreaking) || Boolean(browserProtocolBreaking);
  if (major === 0) {
    if (breaking) return { major: 0, minor: minor + 1, patch: 0 };
    if (changed) return { major: 0, minor, patch: patch + 1 };
    return { major, minor, patch };
  }
  if (breaking) return { major: major + 1, minor: 0, patch: 0 };
  if (changed) return { major, minor, patch: patch + 1 };
  return { major, minor, patch };
}

export function coreToString(core) {
  return `${core.major}.${core.minor}.${core.patch}`;
}

// ---------------------------------------------------------------------
// 5.3/5.4 Canonical payload manifest and leak scan
// ---------------------------------------------------------------------

export function isSafePayloadName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) &&
    !name.includes("..")
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Pure manifest canonicalization (section 5.3). `raw` is the parsed
 * generated web/MANIFEST.json. `fileEntries` describes the actual entries
 * found under web/: `[{name, kind: "file"|"dir"|"symlink", bytes}]`.
 * `expected` carries the values this candidate run expects:
 * `{sha, label, role, reference, abiVersion, repository, sourceAssetBytes}`
 * where `sourceAssetBytes` is a `Map` from a committed relative path (for
 * example `js/gl.js`) to the exact bytes at `sha`.
 * Returns `{canonical, timing}`, or throws a `ManifestError`.
 */
export function canonicalizeManifest(raw, fileEntries, expected) {
  if (!raw || typeof raw !== "object") {
    throw new ManifestError("manifest", "MANIFEST.json must be an object");
  }
  const allowedTopLevel = new Set(["generatedAt", "updatedAt", "source", "files"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) {
      throw new ManifestError("unknown-key", `Unknown top-level manifest key: ${key}`);
    }
  }

  const source = raw.source;
  if (!source || source.mode !== "git") {
    throw new ManifestError("source-mode", "source.mode must be \"git\"");
  }
  if (source.sha !== expected.sha) {
    throw new ManifestError("source-sha", `source.sha ${source.sha} does not equal expected ${expected.sha}`);
  }
  if (source.dirty !== false) {
    throw new ManifestError("source-dirty", "source.dirty must be false");
  }

  if (!Array.isArray(raw.files)) {
    throw new ManifestError("files", "manifest.files must be an array");
  }

  const seenNames = new Set();
  for (const entry of raw.files) {
    if (!isSafePayloadName(entry.file)) {
      throw new ManifestError("unsafe-name", `Unsafe payload file name: ${entry.file}`);
    }
    if (seenNames.has(entry.file)) {
      throw new ManifestError("duplicate-name", `Duplicate payload file name: ${entry.file}`);
    }
    seenNames.add(entry.file);
    if (entry.sourcePath !== undefined && entry.sourcePath !== null) {
      if (entry.sourcePath.startsWith("/") || entry.sourcePath.split("/").includes("..")) {
        throw new ManifestError("source-path", `Unsafe sourcePath: ${entry.sourcePath}`);
      }
    }
  }

  for (const entry of fileEntries) {
    if (entry.kind !== "file") {
      throw new ManifestError("non-regular-file", `Unexpected directory or symbolic link in web/: ${entry.name}`);
    }
  }
  // `fileEntries` is, by convention, the web/ directory listing with
  // MANIFEST.json itself excluded (both the generator and this tool treat
  // MANIFEST.json as always present and separate); so "files[].file plus
  // MANIFEST.json equals the regular files in web/" reduces to comparing
  // files[].file against the non-manifest entries directly.
  const actualNames = fileEntries.map((entry) => entry.name).sort();
  const expectedNames = [...seenNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new ManifestError(
      "file-set",
      `web/ regular files (excluding MANIFEST.json) ${JSON.stringify(actualNames)} do not match manifest files ${JSON.stringify(expectedNames)}`,
    );
  }

  if (JSON.stringify([...seenNames].sort()) !== JSON.stringify(PAYLOAD_FILES)) {
    throw new ManifestError(
      "payload-set",
      `manifest files must be exactly ${JSON.stringify(PAYLOAD_FILES)}, got ${JSON.stringify([...seenNames].sort())}`,
    );
  }

  const bytesByName = new Map(fileEntries.map((entry) => [entry.name, entry.bytes]));
  for (const entry of raw.files) {
    const bytes = bytesByName.get(entry.file);
    const actualSha = sha256Hex(bytes);
    if (actualSha !== entry.sha256) {
      throw new ManifestError("hash-mismatch", `sha256 mismatch for ${entry.file}`);
    }
    if (bytes.length !== entry.bytes) {
      throw new ManifestError("bytes-mismatch", `byte length mismatch for ${entry.file}`);
    }
    if (entry.sourcePath) {
      const expectedBytes = expected.sourceAssetBytes?.get(entry.sourcePath);
      if (expectedBytes !== undefined && Buffer.compare(bytes, expectedBytes) !== 0) {
        throw new ManifestError(
          "source-bytes-mismatch",
          `${entry.file} bytes do not equal ${entry.sourcePath} at ${expected.sha}`,
        );
      }
    }
  }

  const sortedFiles = [...raw.files]
    .map((entry) => ({
      file: entry.file,
      sha256: entry.sha256,
      bytes: entry.bytes,
      sourcePath: entry.sourcePath ?? null,
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const canonical = {
    schema: "miniquad-release-payload/1",
    label: expected.label ?? null,
    role: expected.role,
    reference: expected.reference ?? null,
    source: { repository: expected.repository ?? REPOSITORY_HTTPS, sha: expected.sha },
    abiVersion: expected.abiVersion ?? ABI_VERSION,
    files: sortedFiles,
  };
  const timing = { generatedAt: raw.generatedAt ?? null, updatedAt: raw.updatedAt ?? null };
  return { canonical, timing };
}

/**
 * Re-checks an already-canonical `payload/MANIFEST.json` against the
 * payload directory it ships with. This repeats section 5.3 rules 2, 3, 4,
 * 5, and 7 only: the rules that `verify` can check without the original
 * repository or `--sha` (rule 1, which needs `source.mode`/`source.dirty`
 * from the pre-canonical generated manifest, and rule 6, which needs
 * `git show <sha>:<path>`, do not apply to an already-canonical manifest
 * and are out of scope for `verify`). Throws a `ManifestError` on the
 * first rule it finds broken.
 */
export function verifyCanonicalManifest(canonical, fileEntries) {
  if (!canonical || typeof canonical !== "object" || !Array.isArray(canonical.files)) {
    throw new ManifestError("manifest", "payload/MANIFEST.json must be a canonical manifest with a files array");
  }

  const seenNames = new Set();
  for (const entry of canonical.files) {
    if (!isSafePayloadName(entry.file)) {
      throw new ManifestError("unsafe-name", `Unsafe payload file name: ${entry.file}`);
    }
    if (seenNames.has(entry.file)) {
      throw new ManifestError("duplicate-name", `Duplicate payload file name: ${entry.file}`);
    }
    seenNames.add(entry.file);
    if (entry.sourcePath !== undefined && entry.sourcePath !== null) {
      if (entry.sourcePath.startsWith("/") || entry.sourcePath.split("/").includes("..")) {
        throw new ManifestError("source-path", `Unsafe sourcePath: ${entry.sourcePath}`);
      }
    }
  }

  for (const entry of fileEntries) {
    if (entry.kind !== "file") {
      throw new ManifestError("non-regular-file", `Unexpected directory or symbolic link in payload/: ${entry.name}`);
    }
  }
  const actualNames = fileEntries.map((entry) => entry.name).sort();
  const expectedNames = [...seenNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new ManifestError(
      "file-set",
      `payload/ regular files (excluding MANIFEST.json) ${JSON.stringify(actualNames)} do not match manifest files ${JSON.stringify(expectedNames)}`,
    );
  }

  if (JSON.stringify([...seenNames].sort()) !== JSON.stringify(PAYLOAD_FILES)) {
    throw new ManifestError(
      "payload-set",
      `manifest files must be exactly ${JSON.stringify(PAYLOAD_FILES)}, got ${JSON.stringify([...seenNames].sort())}`,
    );
  }

  const bytesByName = new Map(fileEntries.map((entry) => [entry.name, entry.bytes]));
  for (const entry of canonical.files) {
    const bytes = bytesByName.get(entry.file);
    const actualSha = sha256Hex(bytes);
    if (actualSha !== entry.sha256) {
      throw new ManifestError("hash-mismatch", `sha256 mismatch for ${entry.file}`);
    }
    if (bytes.length !== entry.bytes) {
      throw new ManifestError("bytes-mismatch", `byte length mismatch for ${entry.file}`);
    }
  }
}

const LEAK_RULES = [
  { id: "unix-home", pattern: /\/(?:Users|home)\/[^/\x00-\x1f]+\/|\/root\//g },
  { id: "windows-home", pattern: /[A-Za-z]:[\\/]Users[\\/]/g },
  { id: "file-url", pattern: /file:\/\//g },
  { id: "credential-url", pattern: /https?:\/\/[^/\s@]+@/g },
  { id: "token", pattern: /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)\w{20,}/g },
];

/**
 * Leak scan (section 5.4). `bytes` is scanned as raw bytes (not decoded
 * text), so offsets are exact. `forbiddenStrings` are full absolute path
 * prefixes (the `--repo`, `--out`, home directory, and `CARGO_HOME`
 * values); each must be at least 4 characters and not equal to "/".
 * Returns findings without the matched text.
 */
export function scanForLeaks(bytes, forbiddenStrings = []) {
  const text = Buffer.from(bytes).toString("latin1");
  const findings = [];
  for (const candidate of forbiddenStrings) {
    if (!candidate || candidate === "/" || candidate.length < 4) continue;
    let index = text.indexOf(candidate);
    while (index !== -1) {
      const next = text[index + candidate.length];
      if (next === "/" || next === "\\") {
        findings.push({ ruleId: "local-path", offset: index });
      }
      index = text.indexOf(candidate, index + 1);
    }
  }
  for (const rule of LEAK_RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({ ruleId: rule.id, offset: match.index });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// 9.3 evaluateGate
// ---------------------------------------------------------------------

function requireField(record, path) {
  const parts = path.split(".");
  let value = record;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

const REQUIRED_GATE_FIELDS = [
  "schema",
  "label",
  "tag",
  "candidateSha",
  "toolSha",
  "baseline.sha",
  "baseline.kind",
  "upstream.mergeBaseSha",
  "upstream.cargoVersion",
  "compatibility.previousCore",
  "compatibility.derivedCore",
  "cargoPackage.name",
  "cargoPackage.version",
  "packages.reproducible",
  "packages.baselineManifestSha256",
  "packages.candidateManifestSha256",
  "contracts",
  "ci",
  "drill.reference",
  "drill.local",
  "regression.profileId",
  "regression.result",
  "regression.metrics",
  "sizes",
  "security",
  "changelog",
  "native",
  "limits",
  "review.reviewerKind",
  "review.reviewer",
  "review.method",
  "review.reference",
  "review.ownerApproval",
  "review.date",
];
const REQUIRED_CI_JOBS = [
  ["Miniquad integration CI", "rust-wasm"],
  ["Miniquad three-engine browser acceptance", "engines"],
  ["Security advisory review", "all"],
  ["Miniquad release candidate", "reference"],
];
const SHA_HEX_RE = /^[0-9a-f]{40}$/;
const REGRESSION_RESULTS = new Set(["PASS", "FAIL", "INCONCLUSIVE"]);

/** `true` only for a 40-character lowercase hexadecimal commit SHA. Used
 * to fail closed on a candidate/tool/baseline SHA field that is missing,
 * the wrong type, or not a real commit SHA (section 9.2). */
function isCommitSha(value) {
  return typeof value === "string" && SHA_HEX_RE.test(value);
}

export function evaluateGate(record) {
  const reasons = [];
  let failed = false;
  let blocked = false;

  for (const path of REQUIRED_GATE_FIELDS) {
    const value = requireField(record, path);
    if (value === undefined || value === null || value === "") {
      blocked = true;
      reasons.push(`Missing or invalid required field: ${path}`);
    }
  }

  if (record?.schema !== "miniquad-release-gate/1") {
    blocked = true;
    reasons.push("Gate record schema is invalid");
  }
  if (record?.contracts?.abiVersion !== ABI_VERSION ||
      record?.contracts?.starterParamsVersion !== PARAMS_VERSION) {
    blocked = true;
    reasons.push("Browser contract versions do not match the candidate contract");
  }
  for (const path of [
    "upstream.cargoVersion", "compatibility.evidence", "drill.local.profile",
    "review.reviewer", "review.method", "review.reference", "review.date",
  ]) {
    const value = requireField(record, path);
    if (typeof value !== "string" || !value.trim()) {
      blocked = true;
      reasons.push(`Required evidence text is missing or invalid: ${path}`);
    }
  }
  for (const path of ["upstream.importedChanges", "review.waivers"]) {
    if (!Array.isArray(requireField(record, path))) {
      blocked = true;
      reasons.push(`Required evidence list is missing or invalid: ${path}`);
    }
  }
  for (const path of ["limits", "regression.metrics"]) {
    const value = requireField(record, path);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      blocked = true;
      reasons.push(`Required evidence object is missing or invalid: ${path}`);
    }
  }
  for (const path of [
    "packages.baselineManifestSha256", "packages.candidateManifestSha256",
    "drill.reference.sha256", "drill.local.sha256",
  ]) {
    const value = requireField(record, path);
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      blocked = true;
      reasons.push(`Evidence SHA-256 is missing or invalid: ${path}`);
    }
  }
  for (const field of ["rustApiBreaking", "browserProtocolBreaking", "changed"]) {
    if (typeof record?.compatibility?.[field] !== "boolean") {
      blocked = true;
      reasons.push(`Compatibility flag is missing or invalid: ${field}`);
    }
  }
  for (const path of ["compatibility.previousCore", "compatibility.derivedCore"]) {
    const core = requireField(record, path);
    if (!["major", "minor", "patch"].every((key) => Number.isSafeInteger(core?.[key]) && core[key] >= 0)) {
      blocked = true;
      reasons.push(`Compatibility version is missing or invalid: ${path}`);
    }
  }
  if (typeof record?.review?.sizeIncreaseAccepted !== "boolean") {
    blocked = true;
    reasons.push("review.sizeIncreaseAccepted is not a boolean");
  }

  if (record?.packages?.reproducible !== true) {
    blocked = true;
    reasons.push("packages.reproducible is not true");
  }

  // Section 9.2/9.3: candidateSha, toolSha, and baseline.sha must each be a
  // real 40-character lowercase hex commit SHA, and the baseline must not be
  // the candidate itself. A string that merely passes the REQUIRED_GATE_FIELDS
  // non-empty check (e.g. "not-a-real-sha") must still fail closed here.
  for (const [name, value] of [
    ["candidateSha", record?.candidateSha],
    ["toolSha", record?.toolSha],
    ["baseline.sha", record?.baseline?.sha],
    ["upstream.mergeBaseSha", record?.upstream?.mergeBaseSha],
  ]) {
    if (!isCommitSha(value)) {
      blocked = true;
      reasons.push(`${name} is not a 40-character lowercase hex commit SHA`);
    }
  }
  if (isCommitSha(record?.candidateSha) && isCommitSha(record?.baseline?.sha) && record.candidateSha === record.baseline.sha) {
    blocked = true;
    reasons.push("baseline.sha must not equal candidateSha");
  }

  // Section 9.1/9.3: `ci` must be the actual list of collected job results,
  // not merely present. A non-array value (e.g. `{}`) must not silently skip
  // every required-CI-job check; it must block instead. Each required job's
  // evidence must also be for the exact candidateSha, not a stale or
  // unrelated run (no substituting evidence from a different commit).
  if (!Array.isArray(record?.ci) || record.ci.length === 0) {
    blocked = true;
    reasons.push("ci is missing or is not the list of collected CI job results");
  } else {
    for (const [workflow, job] of REQUIRED_CI_JOBS) {
      const workflowEntries = record.ci.filter((entry) => entry?.workflow === workflow);
      const matching = workflowEntries.filter((entry) => entry.job === job);
      if (matching.length !== 1) {
        blocked = true;
        reasons.push(`Required CI job must have exactly one record: ${workflow} / ${job}`);
      }
      for (const entry of job === "all" ? workflowEntries : matching) {
        if (entry.conclusion === "failure") {
          failed = true;
          reasons.push(`Required CI job failed: ${workflow} / ${entry.job}`);
        } else if (entry.conclusion !== "success") {
          blocked = true;
          reasons.push(`Required CI job not successful: ${workflow} / ${entry.job}`);
        }
        if (!isCommitSha(entry.sha) || entry.sha !== record?.candidateSha) {
          blocked = true;
          reasons.push(`Required CI job evidence is not recorded for the candidate SHA: ${workflow} / ${entry.job}`);
        }
      }
    }
  }

  // Section 9.3: `compare` must be the recorded boolean result, not merely
  // non-false. An absent or wrong-typed `compare` field is missing evidence,
  // not a pass.
  if (record?.compare === false) {
    failed = true;
    reasons.push("compare did not pass");
  } else if (record?.compare !== true) {
    blocked = true;
    reasons.push("compare is missing or is not a boolean result");
  }

  // Section 6.2/9.1: both the reference-profile drill and the local
  // rollout/rollback exercise must each independently record PASS. A
  // `drill.local` of `{}` (no `result` at all) must not count as passing.
  if (record?.drill?.reference?.result === "FAIL" || record?.drill?.local?.result === "FAIL") {
    failed = true;
    reasons.push("Drill result is FAIL");
  }
  if (record?.drill?.reference?.result !== "PASS") {
    blocked = true;
    reasons.push("Reference drill result is missing or not PASS");
  }
  if (record?.drill?.reference?.profile !== "gha-ubuntu-24.04-x64-pw1.56.1") {
    blocked = true;
    reasons.push("Reference drill profile is not the reference profile");
  }
  if (record?.drill?.local?.result !== "PASS") {
    blocked = true;
    reasons.push("Local drill result is missing or not PASS");
  }

  // Section 7.5/9.3: evaluate the actual retained regression runs, not only
  // the asserted top-level `regression.result`. The newest retained run
  // (last in the array; the tool never drops or reorders a run) must be the
  // one that determines `regression.result` -- a record must not cherry-pick
  // an earlier PASS while the newest retained run is INCONCLUSIVE or absent.
  // Every retained run must also be from the declared reference profile: a
  // local rehearsal result must never be substituted into `regression.runs`.
  const regressionRuns = record?.regression?.runs;
  if (!Array.isArray(regressionRuns) || regressionRuns.length === 0) {
    blocked = true;
    reasons.push("regression.runs is missing or empty");
  } else {
    if (regressionRuns.some((run) => run?.result === "FAIL")) {
      failed = true;
      reasons.push("A retained regression run is FAIL");
    }
    const malformedRun = regressionRuns.some(
      (run) =>
        !run ||
        typeof run.runId !== "string" ||
        run.runId === "" ||
        !REGRESSION_RESULTS.has(run.result) ||
        run.profile !== record?.regression?.profileId,
    );
    if (malformedRun) {
      blocked = true;
      reasons.push("A retained regression run is malformed, has an unrecognized result, or is not from the declared reference profile");
    }
    if (regressionRuns.length > 3) {
      blocked = true;
      reasons.push("More than three retained regression runs are recorded for one candidate label");
    }
    const newestRun = regressionRuns[regressionRuns.length - 1];
    if (!newestRun || newestRun.result !== record?.regression?.result) {
      blocked = true;
      reasons.push("regression.result does not match the newest retained run's result");
    }
  }
  if (record?.regression?.result !== "PASS") {
    blocked = true;
    reasons.push("Regression result is not PASS");
  }
  if (record?.regression?.profileId !== "gha-ubuntu-24.04-x64-pw1.56.1") {
    blocked = true;
    reasons.push("Regression profile ID is not the reference profile");
  }
  for (const engineName of ["chromium", "firefox", "webkit"]) {
    const engine = record?.regression?.metrics?.[engineName];
    if (engine?.result === "FAIL") {
      failed = true;
      reasons.push(`Regression engine failed: ${engineName}`);
    } else if (engine?.result !== "PASS") {
      blocked = true;
      reasons.push(`Regression engine is missing or not PASS: ${engineName}`);
    }
    if (!Number.isFinite(engine?.resolution) || engine.resolution <= 0 ||
        !Number.isSafeInteger(engine?.validSampleCount) || engine.validSampleCount < 40 ||
        engine?.invalidSampleCount !== 0) {
      blocked = true;
      reasons.push(`Regression sample evidence is missing or invalid: ${engineName}`);
    }
    for (const metricName of [
      "coldStartupToRunningMs", "coldStartupToFirstFrameMs",
      "warmStartupToRunningMs", "warmFrameIntervalP95Ms",
    ]) {
      const metric = engine?.metrics?.[metricName];
      if (metric?.result === "FAIL") {
        failed = true;
        reasons.push(`Regression metric failed: ${engineName} / ${metricName}`);
      } else if (metric?.result !== "PASS" ||
          ![metric?.limit, metric?.ciLow, metric?.ciHigh].every((v) => Number.isFinite(v) && v >= 0) ||
          metric.ciLow > metric.ciHigh || metric.ciHigh > metric.limit) {
        blocked = true;
        reasons.push(`Regression metric is missing, inconsistent, or not PASS: ${engineName} / ${metricName}`);
      }
    }
  }

  try {
    const derived = coreToString(
      deriveCore(record?.compatibility?.previousCore, record?.compatibility),
    );
    const labelCore = record?.label ? coreToString(parseLabel(record.label).core) : null;
    if (derived !== coreToString(record?.compatibility?.derivedCore ?? {}) || derived !== labelCore) {
      blocked = true;
      reasons.push("compatibility.derivedCore differs from the label core");
    }
    if (record?.label && record?.tag && formatTag(record.label) !== record.tag) {
      blocked = true;
      reasons.push("tag does not match formatTag(label)");
    }
  } catch {
    blocked = true;
    reasons.push("compatibility or label could not be evaluated");
  }

  if (record?.cargoPackage?.name !== CARGO_PACKAGE_NAME || record?.cargoPackage?.version !== CARGO_PACKAGE_VERSION) {
    blocked = true;
    reasons.push("cargoPackage differs from the required name/version");
  }

  if (typeof record?.changelog?.hasHeading !== "boolean" || record.changelog.hasHeading !== true) {
    blocked = true;
    reasons.push("CHANGELOG.md heading for the label is missing");
  }

  for (const target of ["windows", "linux", "macos", "android", "ios"]) {
    if (record?.native?.[target] === undefined) {
      blocked = true;
      reasons.push(`Native target qualification is missing: ${target}`);
    }
  }
  for (const [target, value] of Object.entries(record?.native ?? {})) {
    if (value !== "unqualified" && !(value && typeof value.evidence === "string" && value.evidence.trim())) {
      blocked = true;
      reasons.push(`Native target not unqualified and has no evidence link: ${target}`);
    }
  }

  const security = record?.security;
  if (typeof security?.workflowRun !== "string" || !security.workflowRun.trim() ||
      !Array.isArray(security.openFindings) || !Array.isArray(security.waivers)) {
    blocked = true;
    reasons.push("Security workflow, findings, or waiver details are missing or invalid");
  }
  if (security?.openFindings?.length > 0 || security?.waivers?.length > 0) {
    blocked = true;
    reasons.push("Open security findings or waivers remain");
  }

  const review = record?.review ?? {};
  if (!["person", "automated"].includes(review.reviewerKind)) {
    blocked = true;
    reasons.push("review.reviewerKind is invalid");
  }
  if (!review.reviewer || !review.method || !review.reference) {
    blocked = true;
    reasons.push("review.reviewer, review.method, or review.reference is empty");
  }
  if (review.ownerApproval !== false) {
    blocked = true;
    reasons.push("review.ownerApproval must be false for a candidate");
  }
  if (Array.isArray(review.waivers) && review.waivers.length > 0) {
    blocked = true;
    reasons.push("A waiver is recorded; a waiver keeps the result BLOCKED");
  }
  if (typeof record?.sizes?.brotliTotalDelta !== "number" || !Number.isFinite(record.sizes.brotliTotalDelta)) {
    blocked = true;
    reasons.push("sizes.brotliTotalDelta is missing or is not a finite number");
  } else if (record.sizes.brotliTotalDelta > 0 && review.sizeIncreaseAccepted !== true) {
    blocked = true;
    reasons.push("Size increased without review.sizeIncreaseAccepted");
  }

  const hasReleaseTag = Boolean(record?.existingReleaseTag);
  if (!["bootstrap-reference", "qualified-release"].includes(record?.baseline?.kind)) {
    blocked = true;
    reasons.push("baseline.kind is invalid");
  }
  if (record?.baseline?.kind === "bootstrap-reference" && hasReleaseTag) {
    blocked = true;
    reasons.push("Bootstrap baseline used while a .release tag exists");
  }
  if (record?.baseline?.kind === "qualified-release" && record?.baseline?.tagPointsToSha !== true) {
    blocked = true;
    reasons.push("qualified-release baseline tag does not point to baseline.sha");
  }

  if (Array.isArray(record?.leakFindings) && record.leakFindings.length > 0) {
    failed = true;
    reasons.push("Payload leak finding exists");
  }

  let result;
  if (failed) result = "FAILED";
  else if (blocked) result = "BLOCKED";
  else result = "QUALIFIED-CANDIDATE";
  return { result, reasons };
}

// ---------------------------------------------------------------------
// Shared helpers for the CLI commands
// ---------------------------------------------------------------------

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function gitText(repo, args) {
  return git(repo, args).toString("utf8").trim();
}

function fail(message) {
  // Library-safe: only throw. The CLI dispatcher (main()) is responsible
  // for turning a thrown error into a printed message and a process exit
  // code, so calling these validating functions directly (e.g. from unit
  // tests) never mutates global process state.
  throw new Error(message);
}

function assertAbsolute(name, value) {
  if (!value || !isAbsolute(value)) {
    fail(`${name} must be an absolute path, got: ${value}`);
  }
}

function findGitRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function assertOutsideWorktreeAndTemp(outDir) {
  const parent = dirname(resolve(outDir));
  const gitRoot = findGitRoot(parent);
  if (gitRoot) {
    fail(`--out must not be inside a Git working tree (found ${gitRoot})`);
  }
  const tmp = resolve(os.tmpdir());
  if (resolve(outDir).startsWith(tmp + sep) || resolve(outDir) === tmp) {
    fail("--out must not be inside a system temporary directory");
  }
}

function sha256File(path) {
  return sha256Hex(readFileSync(path));
}

function readDirEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file";
    const bytes = kind === "file" ? readFileSync(join(dir, entry.name)) : null;
    return { name: entry.name, kind, bytes };
  });
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return options;
}

function homeDir() {
  return os.homedir();
}

function cargoHome() {
  return process.env.CARGO_HOME || join(homeDir(), ".cargo");
}

// ---------------------------------------------------------------------
// `prepare`
// ---------------------------------------------------------------------

function validatePrepareArgs(options) {
  const { sha, role, label, reference } = options;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    fail(`--sha must be 40 lowercase hexadecimal characters, got: ${sha}`);
  }
  if (role !== "baseline" && role !== "candidate") {
    fail(`--role must be "baseline" or "candidate", got: ${role}`);
  }
  if (role === "candidate") {
    if (!label) fail("--label is required for --role candidate");
    parseLabel(label);
    if (reference) fail("--reference is not permitted for --role candidate");
  } else {
    if (reference !== "bootstrap-reference" && reference !== "qualified-release") {
      fail('--reference must be "bootstrap-reference" or "qualified-release" for --role baseline');
    }
    if (reference === "bootstrap-reference" && label) {
      fail("--label is not permitted for a bootstrap baseline");
    }
    if (reference === "qualified-release" && !label) {
      fail("--label is required for a qualified-release baseline");
    }
  }
}

function buildRemapRustflags(outConsumerDir) {
  if (process.env.RUSTFLAGS || process.env.CARGO_ENCODED_RUSTFLAGS) {
    fail("RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS is already set; refusing to combine flags");
  }
  const flags = [
    `--remap-path-prefix=${cargoHome()}=/cargo-home`,
    `--remap-path-prefix=${outConsumerDir}=/consumer`,
    `--remap-path-prefix=${homeDir()}=/home-redacted`,
  ];
  return flags.join("\x1f");
}

function readSourceAssetBytes(repo, sha) {
  const map = new Map();
  for (const relativePath of SOURCE_COPIED_ASSETS) {
    map.set(relativePath, git(repo, ["show", `${sha}:${relativePath}`]));
  }
  return map;
}

function compressionReport(bytes) {
  return {
    sha256: sha256Hex(bytes),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
}

function toolchainInfo() {
  const tryRun = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim();
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  };
  return {
    rustc: tryRun("rustc", ["-vV"]),
    cargo: tryRun("cargo", ["-V"]),
    rustupActiveToolchain: tryRun("rustup", ["show", "active-toolchain"]),
    node: tryRun("node", ["-v"]),
    npm: tryRun("npm", ["-v"]),
    git: tryRun("git", ["--version"]),
    tar: tryRun("tar", ["--version"]),
    zlib: process.versions.zlib,
    brotli: process.versions.brotli,
  };
}

function hostInfo() {
  const cpus = os.cpus();
  return {
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemory: os.totalmem(),
  };
}

export function prepare(options) {
  validatePrepareArgs(options);
  const { sha, role, label, reference, lockfile } = options;
  const repo = resolve(options.repo);
  const out = resolve(options.out);
  assertAbsolute("--repo", repo);
  assertAbsolute("--out", out);
  if (existsSync(out)) fail(`--out must not already exist: ${out}`);
  assertOutsideWorktreeAndTemp(out);

  // Step 2: the commit must exist in the local clone.
  git(repo, ["cat-file", "-e", `${sha}^{commit}`]);

  // Step 3: the commit must be an ancestor of origin/master.
  git(repo, ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/master"]);
  const originMasterSha = gitText(repo, ["rev-parse", "refs/remotes/origin/master"]);

  // Step 4: fixed package identity and ABI version at the selected commit.
  const cargoToml = git(repo, ["show", `${sha}:Cargo.toml`]).toString("utf8");
  if (!/name\s*=\s*"miniquad"/u.test(cargoToml) || !new RegExp(`version\\s*=\\s*"${CARGO_PACKAGE_VERSION}"`).test(cargoToml)) {
    fail(`Cargo.toml at ${sha} does not have name = "miniquad" and version = "${CARGO_PACKAGE_VERSION}"`);
  }
  const glJs = git(repo, ["show", `${sha}:js/gl.js`]).toString("utf8");
  if (!glJs.includes(`const version = ${ABI_VERSION};`)) {
    fail(`js/gl.js at ${sha} does not contain const version = ${ABI_VERSION};`);
  }

  mkdirSync(out, { recursive: true });
  const sourceDir = join(out, "source");
  mkdirSync(sourceDir, { recursive: true });

  // Step 5: materialize the exact commit tree; never build from the
  // current working tree's generator or templates.
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  spawnSync("tar", ["-x", "-f", "-", "-C", sourceDir], { input: archive, stdio: ["pipe", "inherit", "inherit"] });

  // Step 6: run the generator of the selected commit, not this tool's own.
  const consumerDir = join(out, "consumer");
  execFileSync(
    "node",
    [
      join(sourceDir, "scripts", "create-browser-project.mjs"),
      consumerDir,
      "--source",
      "git",
      "--git-url",
      GIT_URL,
      "--rev",
      sha,
      "--git-repo",
      repo,
      "--name",
      "release-fixture",
      "--title",
      "Miniquad release fixture",
    ],
    { stdio: "inherit" },
  );

  let lockfileSha256Before = null;
  if (lockfile) {
    assertAbsolute("--lockfile", resolve(lockfile));
    copyFileSync(lockfile, join(consumerDir, "Cargo.lock"));
    lockfileSha256Before = sha256File(join(consumerDir, "Cargo.lock"));
    execFileSync("cargo", ["fetch", "--locked"], { cwd: consumerDir, stdio: "inherit" });
  }

  // Step 8: build, with remapped local paths only (section 5.2).
  execFileSync("node", [join(consumerDir, "scripts", "build.mjs"), "--release"], {
    cwd: consumerDir,
    stdio: "inherit",
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: buildRemapRustflags(consumerDir) },
  });

  if (lockfile) {
    const after = sha256File(join(consumerDir, "Cargo.lock"));
    if (after !== lockfileSha256Before) {
      fail("Cargo.lock changed after the build; the locked dependency graph is not reproducible");
    }
  }

  // Step 10: canonicalize the manifest and run the leak scan.
  const webDir = join(consumerDir, "web");
  const rawManifest = JSON.parse(readFileSync(join(webDir, "MANIFEST.json"), "utf8"));
  const fileEntries = readDirEntries(webDir).filter((entry) => entry.name !== "MANIFEST.json");
  const expected = {
    sha,
    label: role === "candidate" ? label : null,
    role,
    reference: role === "baseline" ? reference : null,
    abiVersion: ABI_VERSION,
    repository: REPOSITORY_HTTPS,
    sourceAssetBytes: readSourceAssetBytes(repo, sha),
  };
  const { canonical, timing } = canonicalizeManifest(rawManifest, fileEntries, expected);

  const forbiddenStrings = [repo, out, homeDir(), cargoHome()];
  const leakFindings = [];
  for (const entry of fileEntries) {
    const findings = scanForLeaks(entry.bytes, forbiddenStrings);
    for (const finding of findings) leakFindings.push({ file: entry.name, ...finding });
  }
  if (leakFindings.length > 0) {
    fail(`Leak scan found ${leakFindings.length} finding(s): ${JSON.stringify(leakFindings)}`);
  }

  // Step 11: write the package.
  const packageDir = join(out, "package");
  const payloadDir = join(packageDir, "payload");
  const receiptsDir = join(packageDir, "receipts");
  mkdirSync(payloadDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  for (const entry of fileEntries) {
    writeFileSync(join(payloadDir, entry.name), entry.bytes, { flag: "wx" });
  }
  writeFileSync(join(payloadDir, "MANIFEST.json"), `${JSON.stringify(canonical, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(receiptsDir, "build-timing.json"), `${JSON.stringify(timing, null, 2)}\n`, { flag: "wx" });

  const sizes = { schema: "miniquad-release-sizes/1", files: {}, totals: { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 } };
  let wasmPlusGl = { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 };
  for (const entry of fileEntries) {
    const report = compressionReport(entry.bytes);
    sizes.files[entry.name] = report;
    sizes.totals.rawBytes += report.rawBytes;
    sizes.totals.gzipBytes += report.gzipBytes;
    sizes.totals.brotliBytes += report.brotliBytes;
    if (entry.name === "app.wasm" || entry.name === "gl.js") {
      wasmPlusGl.rawBytes += report.rawBytes;
      wasmPlusGl.gzipBytes += report.gzipBytes;
      wasmPlusGl.brotliBytes += report.brotliBytes;
    }
  }
  sizes.wasmPlusGl = wasmPlusGl;
  writeFileSync(join(packageDir, "sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`, { flag: "wx" });

  if (lockfile) {
    copyFileSync(join(consumerDir, "Cargo.lock"), join(packageDir, "Cargo.lock"));
  }

  const provenance = {
    schema: "miniquad-release-provenance/1",
    label: expected.label,
    role,
    reference: expected.reference,
    assetSource: {
      sha,
      originMasterSha,
      generatorSha256: sha256Hex(git(repo, ["show", `${sha}:scripts/create-browser-project.mjs`])),
      templatesTree: gitText(repo, ["rev-parse", `${sha}:templates/browser`]),
    },
    tool: {
      sha: gitText(REPO_ROOT, ["rev-parse", "HEAD"]),
      dirty: spawnSync("git", ["-C", REPO_ROOT, "diff", "--quiet"]).status !== 0,
      scriptSha256: sha256File(fileURLToPath(import.meta.url)),
    },
    inputs: {
      consumerCargoToml: sha256File(join(consumerDir, "Cargo.toml")),
      consumerCargoLock: existsSync(join(consumerDir, "Cargo.lock")) ? sha256File(join(consumerDir, "Cargo.lock")) : null,
      consumerBuildScript: sha256File(join(consumerDir, "scripts", "build.mjs")),
      toolPackageLock: existsSync(join(REPO_ROOT, "package-lock.json")) ? sha256File(join(REPO_ROOT, "package-lock.json")) : null,
    },
    toolchain: toolchainInfo(),
    host: hostInfo(),
    build: { remapTargets: ["/cargo-home", "/consumer", "/home-redacted"] },
    upstream: null,
    canonicalManifestSha256: sha256Hex(Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`)),
  };
  writeFileSync(join(packageDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });

  // Step 12: verify must pass before prepare reports success.
  const verifyResult = verify({ package: packageDir });
  if (!verifyResult.ok) {
    fail(`verify failed on the freshly prepared package: ${verifyResult.reasons.join("; ")}`);
  }
  console.log(`Prepared ${role} package at ${packageDir}`);
  return { packageDir, canonical, provenance, sizes };
}

// ---------------------------------------------------------------------
// `verify`
// ---------------------------------------------------------------------

const REQUIRED_WASM_EXPORTS = [
  "memory",
  "main",
  "frame",
  "crate_version",
  "allocate_transfer_vec_u8",
  "discard_transfer_vec_u8",
  "mq_params_version",
];

export function verify(options) {
  const packageDir = resolve(options.package);
  const payloadDir = join(packageDir, "payload");
  const reasons = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(payloadDir, "MANIFEST.json"), "utf8"));
  } catch (error) {
    return { ok: false, reasons: [`Could not read payload/MANIFEST.json: ${error.message}`] };
  }

  const fileEntries = readDirEntries(payloadDir).filter((entry) => entry.name !== "MANIFEST.json");
  try {
    verifyCanonicalManifest(manifest, fileEntries);
  } catch (error) {
    reasons.push(error.message);
  }

  const forbiddenStrings = [REPO_ROOT, packageDir, homeDir(), cargoHome()];
  const leakFindings = [];
  for (const entry of fileEntries) {
    for (const finding of scanForLeaks(entry.bytes, forbiddenStrings)) {
      leakFindings.push({ file: entry.name, ...finding });
    }
  }
  if (leakFindings.length > 0) {
    reasons.push(`Leak scan found ${leakFindings.length} finding(s)`);
  }

  const wasmEntry = fileEntries.find((entry) => entry.name === "app.wasm");
  if (!wasmEntry) {
    reasons.push("app.wasm is missing from the payload");
  } else {
    try {
      // eslint-disable-next-line no-new
      new WebAssembly.Module(wasmEntry.bytes);
    } catch (error) {
      reasons.push(`app.wasm did not compile: ${error.message}`);
    }
  }

  const ok = reasons.length === 0;
  if (options.package && process.argv[2] === "verify") {
    if (ok) console.log(`verify passed for ${packageDir}`);
    else console.error(`verify failed for ${packageDir}:\n${reasons.join("\n")}`);
  }
  return { ok, reasons, leakFindings };
}

// ---------------------------------------------------------------------
// `compare`
// ---------------------------------------------------------------------

export function compare(options) {
  const a = resolve(options.a);
  const b = resolve(options.b);
  const manifestA = readFileSync(join(a, "payload", "MANIFEST.json"));
  const manifestB = readFileSync(join(b, "payload", "MANIFEST.json"));
  if (Buffer.compare(manifestA, manifestB) !== 0) {
    return { ok: false, reason: "canonical manifests are not byte-identical" };
  }
  const namesA = readDirEntries(join(a, "payload")).filter((e) => e.name !== "MANIFEST.json");
  for (const entry of namesA) {
    const other = readFileSync(join(b, "payload", entry.name));
    if (Buffer.compare(entry.bytes, other) !== 0) {
      return { ok: false, reason: `payload file not byte-identical: ${entry.name}` };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------
// `collect-ci`
// ---------------------------------------------------------------------

const REQUIRED_WORKFLOWS = [
  { workflow: "Miniquad integration CI", job: "rust-wasm" },
  { workflow: "Miniquad three-engine browser acceptance", job: "engines" },
  { workflow: "Security advisory review", job: "all" },
  { workflow: "Miniquad release candidate", job: "reference" },
];

export function collectCi(options) {
  const sha = options.sha;
  const results = [];
  let runsRaw;
  try {
    runsRaw = execFileSync("gh", [
      "api",
      `repos/Tigon32/miniquad/actions/runs?head_sha=${sha}&per_page=100`,
    ]).toString("utf8");
  } catch (error) {
    for (const required of REQUIRED_WORKFLOWS) {
      results.push({ ...required, conclusion: "absent", sha, reason: `gh api failed: ${error.message}` });
    }
    writeOut(options.out, results);
    return results;
  }
  const runs = JSON.parse(runsRaw).workflow_runs ?? [];
  for (const required of REQUIRED_WORKFLOWS) {
    const matching = runs
      .filter((run) => run.name === required.workflow && run.head_sha === sha)
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    const newest = matching[0];
    if (!newest) {
      results.push({ ...required, conclusion: "absent", sha: null, runId: null, jobId: null, url: null });
      continue;
    }
    let jobsRaw;
    try {
      jobsRaw = execFileSync("gh", ["api", `repos/Tigon32/miniquad/actions/runs/${newest.id}/jobs`]).toString("utf8");
    } catch (error) {
      results.push({ ...required, conclusion: "absent", sha: newest.head_sha, runId: newest.id, jobId: null, url: newest.html_url, reason: error.message });
      continue;
    }
    const jobs = JSON.parse(jobsRaw).jobs ?? [];
    if (required.job === "all") {
      const allSuccess = jobs.length > 0 && jobs.every((job) => job.conclusion === "success");
      results.push({
        ...required,
        conclusion: allSuccess ? "success" : (jobs.some((j) => j.conclusion === "failure") ? "failure" : (newest.status === "completed" ? "incomplete" : newest.status)),
        sha: newest.head_sha,
        runId: newest.id,
        jobId: jobs.map((j) => j.id),
        url: newest.html_url,
      });
    } else {
      const job = jobs.find((entry) => entry.name === required.job);
      results.push({
        ...required,
        conclusion: job?.conclusion ?? (newest.status === "completed" ? "incomplete" : newest.status),
        sha: newest.head_sha,
        runId: newest.id,
        jobId: job?.id ?? null,
        url: newest.html_url,
      });
    }
  }
  writeOut(options.out, results);
  return results;
}

function writeOut(path, value) {
  if (!path) return;
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------
// `gate`
// ---------------------------------------------------------------------

export function gate(options) {
  const record = JSON.parse(readFileSync(resolve(options.record), "utf8"));
  const { result, reasons } = evaluateGate(record);
  console.log(JSON.stringify({ result, reasons }, null, 2));
  if (result !== "QUALIFIED-CANDIDATE") process.exitCode = 1;
  return { result, reasons };
}

// ---------------------------------------------------------------------
// `label`
// ---------------------------------------------------------------------

export function labelCommand(options) {
  if (options.validate) {
    const parsed = parseLabel(options.validate);
    console.log(JSON.stringify({ valid: true, tag: formatTag(options.validate), ...parsed }, null, 2));
    return parsed;
  }
  const previousCore = {
    major: Number(options.previousMajor ?? 0),
    minor: Number(options.previousMinor ?? 4),
    patch: Number(options.previousPatch ?? 11),
  };
  const derived = deriveCore(previousCore, {
    rustApiBreaking: Boolean(options.rustApiBreaking),
    browserProtocolBreaking: Boolean(options.browserProtocolBreaking),
    changed: Boolean(options.changed),
  });
  const forkSeq = Number(options.forkSeq ?? 1);
  const rc = Number(options.rc ?? 1);
  const label = `${coreToString(derived)}-tigon32.${forkSeq}.rc.${rc}`;
  console.log(JSON.stringify({ label, tag: formatTag(label), derivedCore: derived }, null, 2));
  return { label, derivedCore: derived };
}

// ---------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------

function main() {
  const [, , command, ...rest] = process.argv;
  const options = parseArgs(rest);
  try {
    switch (command) {
      case "label":
        labelCommand(options);
        break;
      case "prepare":
        prepare(options);
        break;
      case "verify": {
        const result = verify(options);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "compare": {
        const result = compare(options);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "collect-ci":
        collectCi(options);
        break;
      case "gate":
        gate(options);
        break;
      default:
        console.error(
          "Usage: node scripts/release-candidate.mjs <label|prepare|verify|compare|collect-ci|gate> [options]",
        );
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
