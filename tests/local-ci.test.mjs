import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { prepareLocalGit } from "../scripts/prepare-local-git.mjs";
import { parseArgs, isolatedEnvironment, buildCommand, checkedProcess } from "../scripts/local-ci.mjs";

const paths = { root: "/checkout with spaces", run: "/run", cache: "/cache", architecture: "linux/arm64" };

test("local CI rejects unknown options, runners, and lanes", () => {
  for (const args of [
    ["--runner", "sh"], ["--runner"], ["--lane", "owner"], ["--lane", "release"],
    ["--secret", "TOKEN"], ["--privileged"], ["--workflows", "other.yml"],
  ]) assert.throws(() => parseArgs(args), /Invalid|Unknown/);
});

test("both local runners select only the existing required test job", () => {
  const direct = buildCommand(parseArgs([]), paths);
  const extension = buildCommand(parseArgs(["--runner", "gh-act"]), paths);
  assert.equal(direct.command, "act");
  assert.equal(extension.command, "gh");
  assert.deepEqual(extension.args, ["act", ...direct.args]);
  assert.equal(direct.args[direct.args.indexOf("--job") + 1], "rust-wasm");
  assert.equal(direct.args[direct.args.indexOf("--workflows") + 1], join(paths.root, ".github/workflows/integration-ci.yml"));
  assert.ok(direct.args.includes("NODE_USE_SYSTEM_CA=1"));
  assert.ok(direct.args.includes("--rm"));
});

test("browser lane and planning modes are explicit and use the same test workflow", () => {
  const command = buildCommand(parseArgs(["--lane", "browser", "--list", "--dryrun"]), paths);
  assert.equal(command.args[command.args.indexOf("--job") + 1], "engines");
  assert.match(command.args[command.args.indexOf("--workflows") + 1], /browser-acceptance-matrix.yml$/);
  assert.ok(command.args.includes("--list"));
  assert.ok(command.args.includes("--dryrun"));
});

test("local CI does not inherit authentication, SSH, personal configuration, or Node injection", () => {
  const original = {
    PATH: "/bin", HOME: "/personal", XDG_CONFIG_HOME: "/personal/config",
    GH_TOKEN: "test-only", GITHUB_TOKEN: "test-only", SSH_AUTH_SOCK: "/agent",
    NODE_OPTIONS: "--require unsafe.cjs", CARGO_REGISTRY_TOKEN: "test-only",
    NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_USE_SYSTEM_CA: "0", NODE_EXTRA_CA_CERTS: "/personal/ca.pem",
  };
  const result = isolatedEnvironment(original, "/isolated", "unix:///docker.sock", "/extensions");
  for (const key of [
    "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "CARGO_REGISTRY_TOKEN",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS",
  ]) {
    assert.equal(result[key], undefined);
  }
  assert.equal(result.HOME, "/isolated");
  assert.equal(result.XDG_CONFIG_HOME, "/isolated");
  assert.equal(result.GH_CONFIG_DIR, "/isolated");
  assert.equal(result.XDG_DATA_HOME, "/extensions");
  assert.equal(result.PATH, "/bin");
});

test("local CI does not mount Docker socket, host network, or personal secret files", () => {
  const { args } = buildCommand(parseArgs([]), paths);
  assert.equal(args[args.indexOf("--container-daemon-socket") + 1], "-");
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  for (const flag of ["--secret-file", "--env-file", "--var-file", "--input-file"]) {
    assert.equal(args[args.indexOf(flag) + 1], join(paths.run, "empty"));
  }
  assert.equal(args.includes("--bind"), false);
  assert.equal(args.includes("--privileged"), false);
  assert.throws(() => buildCommand(parseArgs([]), { ...paths, architecture: "linux/other" }), /architecture/);
});

test("local runner failure, signal, and missing executable cannot report success", () => {
  const execute = (result) => () => result;
  assert.throws(() => checkedProcess("act", [], {}, execute({ status: 17, stderr: "test failed" })), /exited 17.*test failed/);
  assert.throws(() => checkedProcess("act", [], {}, execute({ signal: "SIGTERM" })), /SIGTERM/);
  assert.throws(() => checkedProcess("act", [], {}, execute({ error: new Error("not installed") })), /not installed/);
  assert.equal(checkedProcess("act", [], {}, execute({ status: 0, stdout: " ok\n" })), "ok");
});

test("copied worktree repair restores exact Git objects without replacing modified or untracked source", (t) => {
  const cache = join(process.cwd(), ".local-ci");
  mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(join(cache, "git-repair-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const original = join(fixture, "original");
  const copied = join(fixture, "copied");
  mkdirSync(original);
  mkdirSync(copied);
  const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(original, "init", "--initial-branch=fixture");
  writeFileSync(join(original, "README"), "committed source\n");
  git(original, "add", "README");
  git(original, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const sha = git(original, "rev-parse", "HEAD");
  const bundle = join(fixture, "source.bundle");
  git(original, "bundle", "create", bundle, "HEAD");
  const pointer = "gitdir: /unavailable-host/.git/worktrees/example\n";
  writeFileSync(join(copied, ".git"), pointer);
  writeFileSync(join(copied, "README"), "modified source\n");
  writeFileSync(join(copied, "new.rs"), "untracked source\n");
  assert.throws(() => prepareLocalGit(copied, bundle, "e".repeat(40)), /does not match/);
  assert.equal(readFileSync(join(copied, ".git"), "utf8"), pointer);
  prepareLocalGit(copied, bundle, sha);
  assert.equal(git(copied, "rev-parse", "HEAD"), sha);
  assert.equal(git(copied, "show", "HEAD:README"), "committed source");
  assert.equal(readFileSync(join(copied, "README"), "utf8"), "modified source\n");
  assert.equal(readFileSync(join(copied, "new.rs"), "utf8"), "untracked source\n");
  assert.match(git(copied, "status", "--porcelain"), /M README/);
  assert.match(git(copied, "status", "--porcelain"), /\?\? new.rs/);
  prepareLocalGit(copied, bundle, sha);
  assert.throws(() => prepareLocalGit(copied, bundle, "e".repeat(40)), /HEAD does not match/);
});
