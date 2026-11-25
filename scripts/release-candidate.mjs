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
// Section 5.3 rule 6: the payload file name for each copied asset binds to
// exactly one committed source path. This is fixed, not whatever the
// generated manifest happens to record: a manifest entry with a missing,
// null, or different `sourcePath` for one of these five files is not
// evidence that the bytes came from the selected commit, and must not be
// accepted (see `canonicalizeManifest` rule 6 below).
const FIXED_SOURCE_PATH_BY_PAYLOAD_FILE = {
  "gl.js": "js/gl.js",
  "miniquad.mjs": "js/miniquad.mjs",
  "runtime.html": "js/runtime.html",
  "runtime.mjs": "js/runtime.mjs",
  "host-preferences.mjs": "js/host-preferences.mjs",
};
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

function exactVersionInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("version identifier must be a non-negative safe integer");
  }
  return value;
}

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
    core: {
      major: exactVersionInteger(Number(major)),
      minor: exactVersionInteger(Number(minor)),
      patch: exactVersionInteger(Number(patch)),
    },
    forkSeq: exactVersionInteger(Number(forkSeq)),
    stage: rc !== undefined ? "rc" : "release",
    rc: rc !== undefined ? exactVersionInteger(Number(rc)) : null,
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
  for (const value of [major, minor, patch]) exactVersionInteger(value);
  const breaking = Boolean(rustApiBreaking) || Boolean(browserProtocolBreaking);
  if (major === 0) {
    if (breaking) return { major: 0, minor: exactVersionInteger(minor + 1), patch: 0 };
    if (changed) return { major: 0, minor, patch: exactVersionInteger(patch + 1) };
    return { major, minor, patch };
  }
  if (breaking) return { major: exactVersionInteger(major + 1), minor: 0, patch: 0 };
  if (changed) return { major, minor, patch: exactVersionInteger(patch + 1) };
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
    // Rule 6: for each of the five copied assets, the manifest must record
    // the one fixed source path for that payload file, and the payload
    // bytes must equal the bytes actually committed at that path and SHA.
    // A missing, null, or different `sourcePath`, or a missing expected
    // bytes entry (the caller did not read the real source), must throw
    // rather than silently skip the rule: skipping it is exactly how an
    // unrelated or forged asset can pass as though it came from the
    // selected commit.
    const fixedSourcePath = FIXED_SOURCE_PATH_BY_PAYLOAD_FILE[entry.file];
    if (fixedSourcePath) {
      if (entry.sourcePath !== fixedSourcePath) {
        throw new ManifestError(
          "source-path-mismatch",
          `${entry.file} must record sourcePath ${fixedSourcePath}, got ${JSON.stringify(entry.sourcePath)}`,
        );
      }
      const expectedBytes = expected.sourceAssetBytes?.get(fixedSourcePath);
      if (expectedBytes === undefined) {
        throw new ManifestError(
          "source-bytes-unavailable",
          `No source bytes were supplied to verify ${entry.file} against ${fixedSourcePath} at ${expected.sha}`,
        );
      }
      if (Buffer.compare(bytes, expectedBytes) !== 0) {
        throw new ManifestError(
          "source-bytes-mismatch",
          `${entry.file} bytes do not equal ${fixedSourcePath} at ${expected.sha}`,
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

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
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
        const jobIds = entry.job === "all" ? entry.jobId : [entry.jobId];
        if (!isPositiveId(entry.runId) ||
            !Array.isArray(jobIds) || jobIds.length === 0 ||
            !jobIds.every(isPositiveId) || new Set(jobIds).size !== jobIds.length ||
            entry.url !== `https://github.com/Tigon32/miniquad/actions/runs/${entry.runId}`) {
          blocked = true;
          reasons.push(`Required CI run or job reference is missing or invalid: ${workflow} / ${entry.job}`);
        }
      }
    }
    const securityCi = record.ci.find(
      (entry) => entry?.workflow === "Security advisory review" && entry.job === "all",
    );
    if (!securityCi || record?.security?.workflowRun !== securityCi.url) {
      blocked = true;
      reasons.push("Security evidence does not match the collected security workflow run");
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

  // Section 9.2/11: a drill result only proves something about the real
  // baseline/candidate packages when it is bound to them. A hash that is
  // merely present (e.g. an arbitrary or identical value reused for both
  // packages) is not provenance; require each retained drill's own package
  // identity to match this record's `packages` manifest hashes. Genuine
  // baseline and candidate canonical manifests always differ (role, label,
  // and source SHA are each part of the hashed manifest and never equal
  // between baseline and candidate), so requiring that inequality here
  // rejects a record built from one package reused for both roles, without
  // relying on inequality alone: the binding check above still requires
  // each drill to independently and correctly name both hashes.
  for (const drillKind of ["reference", "local"]) {
    const drillPackages = record?.drill?.[drillKind]?.packages;
    for (const role of ["baseline", "candidate"]) {
      const key = `${role}ManifestSha256`;
      const recorded = drillPackages?.[role]?.canonicalManifestSha256;
      if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded) || recorded !== record?.packages?.[key]) {
        blocked = true;
        reasons.push(`drill.${drillKind}.packages.${role}.canonicalManifestSha256 is missing or does not match packages.${key}`);
      }
    }

    // G1 (Opus follow-up on 0c59538): a hash at the right JSON key is not,
    // by itself, proof the drill actually exercised the correctly-labeled
    // package. Require each retained drill's own `role`/`label`/`sourceSha`
    // to independently match this record's candidate/baseline identity, so
    // a package that merely has the right hash but the wrong slot (e.g. a
    // baseline/candidate role swap) is still rejected.
    const candidatePkg = drillPackages?.candidate;
    if (candidatePkg?.role !== "candidate") {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.candidate.role is "${candidatePkg?.role}", not "candidate"`);
    }
    if (candidatePkg?.label !== record?.label) {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.candidate.label does not match record.label`);
    }
    if (candidatePkg?.sourceSha !== record?.candidateSha) {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.candidate.sourceSha does not match candidateSha`);
    }

    const baselinePkg = drillPackages?.baseline;
    if (baselinePkg?.role !== "baseline") {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.baseline.role is "${baselinePkg?.role}", not "baseline"`);
    }
    if (baselinePkg?.sourceSha !== record?.baseline?.sha) {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.baseline.sourceSha does not match baseline.sha`);
    }
    // A baseline package's manifest label is always null, for both the
    // "bootstrap-reference" and "qualified-release" baseline kinds (section
    // 9.1: "manifest.label must be null for a baseline package"); a
    // non-null retained baseline label can never be genuine.
    if (baselinePkg?.label !== null) {
      blocked = true;
      reasons.push(`drill.${drillKind}.packages.baseline.label is "${baselinePkg?.label}", not null`);
    }
  }
  if (
    typeof record?.packages?.baselineManifestSha256 === "string" &&
    typeof record?.packages?.candidateManifestSha256 === "string" &&
    record.packages.baselineManifestSha256 === record.packages.candidateManifestSha256
  ) {
    blocked = true;
    reasons.push("packages.baselineManifestSha256 must not equal packages.candidateManifestSha256; a genuine baseline and candidate manifest always differ");
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
        !/^[1-9][0-9]*$/.test(run.runId) ||
        !isPositiveId(Number(run.runId)) ||
        !REGRESSION_RESULTS.has(run.result) ||
        run.profile !== record?.regression?.profileId,
    );
    if (malformedRun) {
      blocked = true;
      reasons.push("A retained regression run is malformed, has an unrecognized result, or is not from the declared reference profile");
    }
    if (new Set(regressionRuns.map((run) => run?.runId)).size !== regressionRuns.length) {
      blocked = true;
      reasons.push("A regression workflow run is recorded more than once");
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
    const referenceCi = Array.isArray(record?.ci)
      ? record.ci.find((entry) => entry?.workflow === "Miniquad release candidate" && entry.job === "reference")
      : undefined;
    if (!referenceCi || newestRun?.runId !== String(referenceCi.runId)) {
      blocked = true;
      reasons.push("Newest regression evidence does not match the collected reference workflow run");
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
  // Section 7.6/9.2: the complete baseline/candidate per-compression totals
  // and their signed deltas must be present and mutually consistent, not
  // only a bare `brotliTotalDelta` number. A missing/NaN/negative byte
  // count, or a delta that does not equal candidate minus baseline, must
  // block instead of silently qualifying. A positive accepted Brotli
  // increase also needs a non-empty documented reason (section 9.4); an
  // acceptance flag alone is not sufficient evidence.
  const SIZE_KEYS = ["rawBytes", "gzipBytes", "brotliBytes"];
  const sizeTotalsValid = (totals) =>
    totals !== null && typeof totals === "object" &&
    SIZE_KEYS.every((key) => Number.isSafeInteger(totals[key]) && totals[key] >= 0);
  const baselineSizes = record?.sizes?.baseline;
  const candidateSizes = record?.sizes?.candidate;
  const deltaSizes = record?.sizes?.deltas;
  if (!sizeTotalsValid(baselineSizes) || !sizeTotalsValid(candidateSizes)) {
    blocked = true;
    reasons.push("sizes.baseline or sizes.candidate is missing a finite non-negative byte count for raw, gzip, or Brotli");
  } else if (
    deltaSizes === null || typeof deltaSizes !== "object" ||
    !SIZE_KEYS.every((key) => Number.isSafeInteger(deltaSizes[key]) && deltaSizes[key] === candidateSizes[key] - baselineSizes[key])
  ) {
    blocked = true;
    reasons.push("sizes.deltas is missing or is not consistent with candidate minus baseline for raw, gzip, or Brotli bytes");
  } else if (deltaSizes.brotliBytes > 0) {
    if (review.sizeIncreaseAccepted !== true) {
      blocked = true;
      reasons.push("Size increased without review.sizeIncreaseAccepted");
    }
    if (typeof review.sizeIncreaseReason !== "string" || !review.sizeIncreaseReason.trim()) {
      blocked = true;
      reasons.push("Size increased without a documented, non-empty review.sizeIncreaseReason");
    }
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
      const wasmModule = new WebAssembly.Module(wasmEntry.bytes);
      const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map((item) => item.name));
      const missingExports = REQUIRED_WASM_EXPORTS.filter((name) => !exportNames.has(name));
      if (missingExports.length > 0) {
        reasons.push(`app.wasm is missing required export(s): ${missingExports.join(", ")}`);
      }
    } catch (error) {
      reasons.push(`app.wasm did not compile: ${error.message}`);
    }
  }

  // Section 5.3/9.2 identity: a payload whose WASM compiles and whose bytes
  // match their own (possibly forged) manifest is still not evidence of a
  // real candidate or baseline unless the canonical manifest itself carries
  // a genuine schema, role, label, repository, source SHA, and ABI version.
  // `verifyCanonicalManifest` above re-checks the file list and hashes, but
  // not these identity fields; check them here so an identity-free or
  // mislabeled manifest cannot pass.
  if (manifest?.schema !== "miniquad-release-payload/1") {
    reasons.push("manifest.schema must be \"miniquad-release-payload/1\"");
  }
  if (!["baseline", "candidate"].includes(manifest?.role)) {
    reasons.push("manifest.role must be \"baseline\" or \"candidate\"");
  }
  if (manifest?.role === "candidate") {
    if (typeof manifest?.label !== "string" || !LABEL_RE.test(manifest.label)) {
      reasons.push("manifest.label must be a valid label for a candidate package");
    }
    if (manifest?.reference !== null) {
      reasons.push("manifest.reference must be null for a candidate package");
    }
  } else if (manifest?.role === "baseline") {
    if (manifest?.label !== null) {
      reasons.push("manifest.label must be null for a baseline package");
    }
    if (!["bootstrap-reference", "qualified-release"].includes(manifest?.reference)) {
      reasons.push("manifest.reference must be \"bootstrap-reference\" or \"qualified-release\" for a baseline package");
    }
  }
  if (manifest?.source?.repository !== REPOSITORY_HTTPS) {
    reasons.push(`manifest.source.repository must be ${REPOSITORY_HTTPS}`);
  }
  if (!isCommitSha(manifest?.source?.sha)) {
    reasons.push("manifest.source.sha must be a 40-character lowercase hex commit SHA");
  }
  if (manifest?.abiVersion !== ABI_VERSION) {
    reasons.push(`manifest.abiVersion must be ${ABI_VERSION}`);
  }

  // Section 5.5: when `provenance.json` ships alongside the payload, its
  // recorded canonical-manifest hash and asset source SHA must match the
  // manifest actually present. An absent provenance.json is not checked
  // here (callers of `compare`/`gate` that need provenance evidence read it
  // separately); a present but inconsistent one must not be accepted.
  const provenancePath = join(packageDir, "provenance.json");
  if (existsSync(provenancePath)) {
    try {
      const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
      const manifestBytes = readFileSync(join(payloadDir, "MANIFEST.json"));
      if (provenance?.canonicalManifestSha256 !== sha256Hex(manifestBytes)) {
        reasons.push("provenance.json canonicalManifestSha256 does not match payload/MANIFEST.json bytes");
      }
      if (provenance?.assetSource?.sha !== manifest?.source?.sha) {
        reasons.push("provenance.json assetSource.sha does not match manifest.source.sha");
      }
    } catch (error) {
      reasons.push(`Could not read or parse provenance.json: ${error.message}`);
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

// Fetches every page of a paginated `gh api` list endpoint and merges the
// pages into one array. Uses `--paginate --slurp` so each page arrives as
// its own JSON object in an outer array; a later page is never dropped
// (a failed security job on page 2 of 2 must still be visible). Fails
// closed (throws) on a transport error, invalid JSON, a page missing the
// expected array, disagreeing `total_count` values, or a merged item count
// that does not match the reported `total_count` -- any of these means the
// evidence is incomplete or untrustworthy, and absent/invalid evidence must
// never be accepted as a passing required job.
function fetchPaginatedList(execFileSyncImpl, path, arrayKey) {
  let raw;
  try {
    raw = execFileSyncImpl("gh", [
      "api", "--hostname", "github.com", "--paginate", "--slurp", path,
    ]).toString("utf8");
  } catch (error) {
    throw new Error(`gh api failed for ${path}: ${error.message}`);
  }
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`gh api returned invalid JSON for ${path}: ${error.message}`);
  }
  if (!Array.isArray(pages)) {
    throw new Error(`gh api --slurp did not return a page array for ${path}`);
  }
  const items = [];
  let expectedTotal = null;
  for (const page of pages) {
    if (!page || typeof page !== "object" || !Array.isArray(page[arrayKey])) {
      throw new Error(`gh api page for ${path} is missing a "${arrayKey}" array`);
    }
    if (typeof page.total_count === "number") {
      if (expectedTotal === null) expectedTotal = page.total_count;
      else if (expectedTotal !== page.total_count) {
        throw new Error(`gh api pages for ${path} disagree on total_count (${expectedTotal} vs ${page.total_count})`);
      }
    }
    items.push(...page[arrayKey]);
  }
  if (expectedTotal !== null && items.length !== expectedTotal) {
    throw new Error(`gh api pagination incomplete for ${path}: expected ${expectedTotal} "${arrayKey}" entries, got ${items.length}`);
  }
  return items;
}

export function collectCi(options, { execFileSyncImpl = execFileSync } = {}) {
  const sha = options.sha;
  if (!isCommitSha(sha)) fail("--sha must be a 40-character lowercase hex commit SHA");
  const results = [];

  let runs;
  try {
    runs = fetchPaginatedList(
      execFileSyncImpl,
      `repos/Tigon32/miniquad/actions/runs?head_sha=${sha}&per_page=100`,
      "workflow_runs",
    );
  } catch (error) {
    for (const required of REQUIRED_WORKFLOWS) {
      results.push({ ...required, conclusion: "absent", sha: null, runId: null, jobId: null, url: null, reason: error.message });
    }
    writeOut(options.out, results);
    return results;
  }

  for (const required of REQUIRED_WORKFLOWS) {
    const matching = runs
      .filter((run) => run && run.name === required.workflow && run.head_sha === sha &&
        run.status === "completed" && run.event === "workflow_dispatch" && run.head_branch === "master" &&
        isPositiveId(run.id))
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    const newest = matching[0];
    if (!newest) {
      results.push({ ...required, conclusion: "absent", sha: null, runId: null, jobId: null, url: null });
      continue;
    }

    let jobs;
    try {
      jobs = fetchPaginatedList(
        execFileSyncImpl,
        `repos/Tigon32/miniquad/actions/runs/${newest.id}/jobs?per_page=100`,
        "jobs",
      );
    } catch (error) {
      results.push({ ...required, conclusion: "absent", sha: newest.head_sha, runId: newest.id, jobId: null, url: newest.html_url, reason: error.message });
      continue;
    }

    // Identity binding: a job that is not attached to the run we just
    // selected (a stale/wrong `run_id`, or a malformed job record with no
    // `run_id` at all) must never count as evidence for this run.
    const misattributed = jobs.find((job) => !job || typeof job.run_id !== "number" || job.run_id !== newest.id);
    if (misattributed) {
      results.push({
        ...required,
        conclusion: "absent",
        sha: newest.head_sha,
        runId: newest.id,
        jobId: null,
        url: newest.html_url,
        reason: misattributed && typeof misattributed === "object" && "id" in misattributed
          ? `job ${misattributed.id} is attached to run ${misattributed.run_id}, not the collected run ${newest.id}`
          : `a job record for run ${newest.id} is malformed or missing its run_id`,
      });
      continue;
    }

    const conclusionOf = (job) => (job && job.status === "completed" ? job.conclusion : null);
    if (required.job === "all") {
      const allSuccess = jobs.length > 0 && jobs.every((job) => conclusionOf(job) === "success");
      results.push({
        ...required,
        conclusion: allSuccess ? "success" : (jobs.some((j) => conclusionOf(j) === "failure") ? "failure" : (newest.status === "completed" ? "incomplete" : newest.status)),
        sha: newest.head_sha,
        runId: newest.id,
        jobId: jobs.map((j) => j.id),
        url: newest.html_url,
      });
    } else {
      const job = jobs.find((entry) => entry?.name === required.job);
      results.push({
        ...required,
        conclusion: conclusionOf(job) ?? (newest.status === "completed" ? "incomplete" : newest.status),
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

/** Verifies, by Git command against a real repository, that `tag` is an
 * annotated tag whose commit is exactly `candidateSha`. This is the F4(c)
 * follow-up: the contract already requires the tag to point to
 * `candidateSha` (section 9.2); `evaluateGate` itself stays pure and only
 * checks `formatTag(label) === tag` as a string, so this function is the
 * actual proof, run at the `gate` CLI boundary before a QUALIFIED-CANDIDATE
 * record is treated as real evidence. It performs read-only Git commands;
 * it does not create, move, or push a tag, and it does not authorize
 * publication. `gitImpl` is injectable for tests; it defaults to real Git
 * via `execFileSync`. A missing tag, a non-annotated tag, or a mismatched
 * commit each fail closed with an explicit reason, instead of being
 * silently accepted or skipped. */
export function verifyTagBinding({ repo, tag, candidateSha }, { gitImpl = execFileSync } = {}) {
  const run = (args) => {
    try {
      return gitImpl("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
    } catch (err) {
      return { error: err };
    }
  };

  if (!repo || !tag || !candidateSha) {
    return { ok: false, reason: "verifyTagBinding requires repo, tag, and candidateSha" };
  }

  const objectType = run(["cat-file", "-t", tag]);
  if (typeof objectType !== "string") {
    return { ok: false, reason: `tag ${tag} does not exist in ${repo} (git cat-file -t failed)` };
  }
  if (objectType !== "tag") {
    return { ok: false, reason: `${tag} is a ${objectType}, not an annotated tag object` };
  }

  const resolvedCommit = run(["rev-parse", `${tag}^{commit}`]);
  if (typeof resolvedCommit !== "string" || !/^[0-9a-f]{40}$/u.test(resolvedCommit)) {
    return { ok: false, reason: `could not resolve ${tag}^{commit} to a 40-hex commit SHA` };
  }
  if (resolvedCommit !== candidateSha) {
    return { ok: false, reason: `${tag} points to ${resolvedCommit}, not candidateSha ${candidateSha}` };
  }

  return { ok: true, reason: null };
}

export function gate(options, { gitImpl = execFileSync } = {}) {
  const record = JSON.parse(readFileSync(resolve(options.record), "utf8"));
  const { result, reasons } = evaluateGate(record);
  let finalResult = result;
  const finalReasons = [...reasons];

  // The pure evaluator only checks that `tag` is the string
  // `formatTag(label)`; it has no I/O and cannot prove the tag actually
  // exists or points at `candidateSha`. Run that proof here, at the gate
  // boundary, before a BLOCKED-free record is reported as qualified. This
  // does not create a tag and is not a publication decision.
  if (finalResult !== "BLOCKED" && finalResult !== "FAILED" && record?.tag && record?.candidateSha) {
    const repo = resolve(options.repo ?? REPO_ROOT);
    const tagBinding = verifyTagBinding({ repo, tag: record.tag, candidateSha: record.candidateSha }, { gitImpl });
    if (!tagBinding.ok) {
      finalResult = "BLOCKED";
      finalReasons.push(`tag binding: ${tagBinding.reason}`);
    }
  }

  console.log(JSON.stringify({ result: finalResult, reasons: finalReasons }, null, 2));
  if (finalResult !== "QUALIFIED-CANDIDATE") process.exitCode = 1;
  return { result: finalResult, reasons: finalReasons };
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
