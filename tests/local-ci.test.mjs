import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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
  };
  const result = isolatedEnvironment(original, "/isolated", "unix:///docker.sock", "/extensions");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "CARGO_REGISTRY_TOKEN"]) {
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
