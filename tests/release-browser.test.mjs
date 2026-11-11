// Regressions for issue #19 artifact-acceptance review finding F1: the
// section 6.2 drill phase check must fail when the browser's own observed
// responses do not prove the active package's bytes, even when Node's
// independent `fetch` against the server is fine. Ported and inverted from
// the reviewer's read-only P3 probe (see
// issue19-artifact-acceptance/probes.test.mjs) against the fixed behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReleaseServer, runDrillEngine } from "../scripts/release-browser.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function payloadBytes(tag) {
  return {
    "app.wasm": Buffer.from(`WASM-BYTES-${tag}`),
    "gl.js": Buffer.from(`const version = 3; // ${tag}`),
    "host-preferences.mjs": Buffer.from(`export {}; // ${tag}`),
    "index.html": Buffer.from(`<!doctype html><!-- ${tag} -->`),
    "miniquad.mjs": Buffer.from(`export {}; // ${tag}`),
    "runtime.html": Buffer.from(`<script></script><!-- ${tag} -->`),
    "runtime.mjs": Buffer.from(`globalThis.x = 1; // ${tag}`),
  };
}

function writePackage(dir, role, bytesMap) {
  const payload = join(dir, "payload");
  mkdirSync(payload, { recursive: true });
  const files = Object.entries(bytesMap).map(([file, bytes]) => {
    writeFileSync(join(payload, file), bytes);
    return { file, sha256: sha256(bytes), bytes: bytes.length, sourcePath: null };
  });
  const manifest = {
    schema: "miniquad-release-payload/1",
    label: role === "candidate" ? "0.5.0-tigon32.1.rc.1" : null,
    role,
    reference: role === "baseline" ? "bootstrap-reference" : null,
    source: { repository: "https://github.com/Tigon32/miniquad", sha: "f837a98d415262320a8c66ef9f8024d8f2faeab1" },
    abiVersion: 3,
    files,
  };
  writeFileSync(join(payload, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, bytesMap };
}

/** A fake Playwright `chromium` whose browser always serves the candidate
 * bytes (or always returns 304), regardless of which package the real
 * server has `deploy()`-ed. This models a stale cache or a browser that
 * ignores `deploy()` state changes: exactly what a genuine
 * rollout/rollback check must detect and fail. */
function fakePlaywright({ mode, emitted }) {
  const candidateBytes = payloadBytes("candidate");
  const pngFor = (tag) => Buffer.from(tag);
  const makePage = () => {
    const listeners = new Map();
    let shotIndex = 0;
    const respond = async (url) => {
      const base = url.replace(/\/app\/?$/u, "/app/");
      const files = ["index.html", "gl.js", "miniquad.mjs", "runtime.html", "runtime.mjs", "host-preferences.mjs", "app.wasm"];
      for (const file of files) {
        const u = file === "index.html" ? base : `${base}${file}`;
        const status = mode === "all-304" ? 304 : 200;
        const body = candidateBytes[file];
        emitted.push({ file, status, sha256: sha256(body) });
        for (const fn of listeners.get("response") ?? []) {
          // eslint-disable-next-line no-await-in-loop
          await fn({
            url: () => u,
            status: () => status,
            body: async () => {
              if (status === 304) throw new Error("no body for a 304");
              return body;
            },
          });
        }
      }
    };
    let lastUrl = null;
    return {
      on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      off: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== fn)),
      goto: async (url) => {
        lastUrl = url;
        await respond(url);
      },
      reload: async () => respond(lastUrl),
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => "fake-user-agent",
      frames: () => [{
        url: () => "http://127.0.0.1/app/runtime.html",
        waitForFunction: async () => {},
        evaluate: async () => ({ crateVersion: 3, paramsVersion: 1, frames: 5 }),
      }],
      frameLocator: () => ({
        first: () => ({
          locator: () => ({
            first: () => ({ screenshot: async () => pngFor(shotIndex++ % 2 === 0 ? "before" : "after") }),
          }),
        }),
      }),
    };
  };
  const browser = {
    version: () => "fake-1",
    newContext: async () => ({ newPage: async () => makePage(), close: async () => {} }),
    close: async () => {},
  };
  return { chromium: { launch: async () => browser } };
}

const FakePNG = {
  sync: {
    read: (buf) => {
      const width = 100;
      const height = 100;
      const data = Buffer.alloc(width * height * 4);
      const corner = buf.toString() === "before" ? [16, 16, 26] : [17, 34, 51];
      for (let i = 0; i < width * height; i += 1) data.set([...corner, 255], i * 4);
      data.set([200, 0, 0, 255], (width * 50 + 50) * 4);
      return { width, height, data };
    },
  },
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "release-drill-test-"));
  const baseline = writePackage(join(root, "baseline"), "baseline", payloadBytes("baseline"));
  const candidate = writePackage(join(root, "candidate"), "candidate", payloadBytes("candidate"));
  return { root, baseline, candidate };
}

for (const mode of ["stale-candidate-200", "all-304"]) {
  test(`runDrillEngine gives FAIL, not PASS, when the browser never executes the baseline bytes (${mode}) (F1)`, async () => {
    const { root, baseline, candidate } = makeFixture();
    const server = await createReleaseServer({ packages: { baseline: { dir: baseline.dir }, candidate: { dir: candidate.dir } } });
    const emitted = [];
    try {
      const result = await runDrillEngine({
        playwright: fakePlaywright({ mode, emitted }),
        PNG: FakePNG,
        engineName: "chromium",
        serverUrl: server.url,
        baselineManifest: baseline.manifest,
        candidateManifest: candidate.manifest,
        deploy: server.deploy,
        headful: false,
        outDir: join(root, `out-${mode}`),
      });
      const baselineGlHash = sha256(baseline.bytesMap["gl.js"]);
      assert.ok(emitted.every((r) => r.sha256 !== baselineGlHash), "the fake browser never actually saw baseline gl.js");
      // This is the fixed behavior: a browser that never actually received
      // the baseline bytes during the baseline/rollback phases must fail
      // the drill, not merely "pass" because the server itself answered
      // Node's own fetch() correctly.
      assert.equal(result.result, "FAIL");
      for (const phase of ["baseline", "rollback-fresh", "rollback-reload"]) {
        assert.equal(result.phases[phase].pass, false, `phase ${phase} must fail`);
        assert.equal(result.phases[phase].responseChecksPass, false, `phase ${phase} responseChecksPass must be false`);
      }
      assert.ok(JSON.stringify(result).includes("responseHashes"), "browser-observed hashes must be retained for evidence");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runDrillEngine gives PASS and retains responseHashes/userAgent when the browser genuinely follows deploy() (F1)", async () => {
  const { root, baseline, candidate } = makeFixture();
  const server = await createReleaseServer({ packages: { baseline: { dir: baseline.dir }, candidate: { dir: candidate.dir } } });
  const activeBytes = { current: baseline.bytesMap };

  /** This fake actually serves whichever package `deploy()` last selected,
   * modeling a correctly behaving browser, so the fixed, stricter check
   * (require status 200 and a matching hash in every phase) does not
   * regress the valid case. */
  function correctPlaywright() {
    const makePage = () => {
      const listeners = new Map();
      let shotIndex = 0;
      const respond = async (url) => {
        const base = url.replace(/\/app\/?$/u, "/app/");
        const files = ["index.html", "gl.js", "miniquad.mjs", "runtime.html", "runtime.mjs", "host-preferences.mjs", "app.wasm"];
        for (const file of files) {
          const u = file === "index.html" ? base : `${base}${file}`;
          const body = activeBytes.current[file];
          for (const fn of listeners.get("response") ?? []) {
            // eslint-disable-next-line no-await-in-loop
            await fn({ url: () => u, status: () => 200, body: async () => body });
          }
        }
      };
      let lastUrl = null;
      return {
        on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
        off: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== fn)),
        goto: async (url) => {
          lastUrl = url;
          await respond(url);
        },
        reload: async () => respond(lastUrl),
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => "fake-user-agent",
        frames: () => [{
          url: () => "http://127.0.0.1/app/runtime.html",
          waitForFunction: async () => {},
          evaluate: async () => ({ crateVersion: 3, paramsVersion: 1, frames: 5 }),
        }],
        frameLocator: () => ({
          first: () => ({
            locator: () => ({
              first: () => ({ screenshot: async () => Buffer.from(shotIndex++ % 2 === 0 ? "before" : "after") }),
            }),
          }),
        }),
      };
    };
    const browser = {
      version: () => "fake-1",
      newContext: async () => ({ newPage: async () => makePage(), close: async () => {} }),
      close: async () => {},
    };
    return { chromium: { launch: async () => browser } };
  }

  const realDeploy = server.deploy;
  const deploy = (role) => {
    activeBytes.current = role === "baseline" ? baseline.bytesMap : candidate.bytesMap;
    realDeploy(role);
  };

  try {
    const result = await runDrillEngine({
      playwright: correctPlaywright(),
      PNG: FakePNG,
      engineName: "chromium",
      serverUrl: server.url,
      baselineManifest: baseline.manifest,
      candidateManifest: candidate.manifest,
      deploy,
      headful: false,
      outDir: join(root, "out-correct"),
    });
    assert.equal(result.result, "PASS", JSON.stringify(result.phases, null, 2));
    for (const phase of ["baseline", "candidate", "rollback-fresh", "rollback-reload"]) {
      assert.equal(result.phases[phase].pass, true, `phase ${phase} must pass`);
      assert.equal(result.phases[phase].responseChecksPass, true);
      assert.equal(result.phases[phase].userAgent, "fake-user-agent");
      assert.ok(result.phases[phase].responseHashes["gl.js"], "gl.js response must be retained");
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
