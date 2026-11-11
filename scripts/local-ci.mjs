#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_CACHE_KEY = createHash("sha256").update(readFileSync(join(ROOT, "package-lock.json"))).digest("hex").slice(0, 12);
export const RUNNER_IMAGE = "ghcr.io/catthehacker/ubuntu@sha256:19619a010b204f44c5340bff7d39b68551109fe6a56a53f75201ea91e05d4270";
const LANES = {
  pr: [".github/workflows/integration-ci.yml", "rust-wasm"],
  browser: [".github/workflows/browser-acceptance-matrix.yml", "engines"],
};

export function parseArgs(args) {
  const options = { runner: "act", lane: "pr", list: false, dryrun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--runner" || arg === "--lane") {
      const key = arg.slice(2);
      const value = args[++i];
      if (!(key === "runner" ? ["act", "gh-act"] : Object.keys(LANES)).includes(value)) {
        throw new Error(`Invalid ${arg}: ${value}`);
      }
      options[key] = value;
    } else if (arg === "--list") options.list = true;
    else if (arg === "--dryrun") options.dryrun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function isolatedEnvironment(original, home, dockerHost, dataHome) {
  const environment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "TERM"]) {
    if (original[key] !== undefined) environment[key] = original[key];
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GH_CONFIG_DIR: home,
    XDG_DATA_HOME: dataHome,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    DOCKER_HOST: dockerHost,
  };
}

export function buildCommand(options, { root, run, cache, architecture }) {
  if (!["linux/arm64", "linux/amd64"].includes(architecture)) throw new Error("Unsupported Docker architecture");
  const [workflow, job] = LANES[options.lane] ?? [];
  if (!workflow) throw new Error("Unknown local CI lane");
  const suffix = architecture.replace("/", "-");
  const args = [
    "pull_request",
    "--directory", root,
    "--workflows", join(root, workflow),
    "--job", job,
    "--eventpath", join(run, "event.json"),
    "--actor", "Tigon32",
    "--defaultbranch", "master",
    "--platform", `ubuntu-24.04=${RUNNER_IMAGE}`,
    "--container-architecture", architecture,
    "--container-daemon-socket", "-",
    "--network", "bridge",
    "--concurrent-jobs", "1",
    "--pull=false",
    "--action-offline-mode",
    "--action-cache-path", join(cache, "actions"),
    "--no-cache-server",
    "--secret-file", join(run, "empty"),
    "--env-file", join(run, "empty"),
    "--var-file", join(run, "empty"),
    "--input-file", join(run, "empty"),
    "--env", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "--container-options", [
      `--mount type=volume,source=miniquad-act-v1-${suffix}-cargo,target=/root/.cargo`,
      `--mount type=volume,source=miniquad-act-v1-${suffix}-rustup,target=/root/.rustup`,
      `--mount type=volume,source=miniquad-act-v1-${suffix}-npm,target=/root/.npm`,
      `--mount type=volume,source=miniquad-act-v1-${suffix}-browsers-${BROWSER_CACHE_KEY},target=/ms-playwright`,
    ].join(" "),
    "--rm",
  ];
  if (options.list) args.push("--list");
  if (options.dryrun) args.push("--dryrun");
  if (options.runner === "act") return { command: "act", args };
  if (options.runner === "gh-act") return { command: "gh", args: ["act", ...args] };
  throw new Error("Unknown local CI runner");
}

export function checkedProcess(command, args, options = {}, execute = spawnSync) {
  const result = execute(command, args, { ...options, encoding: "utf8" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.signal) throw new Error(`${command} stopped with signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() ?? "";
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("Usage: node scripts/local-ci.mjs [--runner act|gh-act] [--lane pr|browser] [--list|--dryrun]");
    return;
  }
  if (existsSync(join(ROOT, ".actrc"))) {
    throw new Error("Repository .actrc is not supported by this wrapper. Its explicit flags must remain in control.");
  }
  const git = (...values) => checkedProcess("git", ["-C", ROOT, ...values]);
  const sha = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const workingTreeStatus = git("status", "--porcelain", "--untracked-files=normal");
  const dockerHost = process.env.DOCKER_HOST || checkedProcess("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!/^(unix|npipe):\/\//.test(dockerHost)) throw new Error("Use a local Docker socket, not a remote Docker host.");
  const serverArchitecture = checkedProcess("docker", ["version", "--format", "{{.Server.Arch}}"]);
  const architecture = { arm64: "linux/arm64", amd64: "linux/amd64" }[serverArchitecture];
  if (!architecture) throw new Error(`Unsupported Docker server architecture: ${serverArchitecture}`);
  const cache = join(ROOT, ".local-ci", "cache");
  mkdirSync(join(ROOT, ".local-ci", "runs"), { recursive: true });
  const run = mkdtempSync(join(ROOT, ".local-ci", "runs", "run-"));
  const home = join(run, "home");
  mkdirSync(home);
  writeFileSync(join(run, "empty"), "");
  writeFileSync(join(run, "event.json"), JSON.stringify({
    local_ci: true,
    repository: { full_name: "Tigon32/miniquad", default_branch: "master", owner: { login: "Tigon32" } },
    pull_request: {
      number: 0,
      head: { ref: branch, sha },
      base: { ref: "master" },
    },
  }));
  const environment = isolatedEnvironment(
    process.env, home, dockerHost,
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  );
  const invocation = buildCommand(options, { root: ROOT, run, cache, architecture });
  checkedProcess(invocation.command, [...(options.runner === "gh-act" ? ["act"] : []), "--version"], { env: environment });
  console.log(`Local ${options.lane} lane: ${sha} plus working-tree changes; ${architecture}`);
  console.log(`Runner image: ${RUNNER_IMAGE}`);
  console.log(`Run files: ${run}`);
  const record = { sha, branch, workingTreeStatus, architecture, image: RUNNER_IMAGE, ...options, result: "not tested" };
  try {
    checkedProcess(invocation.command, invocation.args, {
      cwd: ROOT, env: environment, stdio: "inherit", timeout: 45 * 60 * 1000,
    });
    record.result = options.list || options.dryrun ? "not tested" : "passed";
  } catch (error) {
    record.result = "failed";
    record.error = error.message;
    throw error;
  } finally {
    writeFileSync(join(run, "result.json"), JSON.stringify(record, null, 2));
  }
  console.log(options.list || options.dryrun ? "Plan completed. Tests did not run." : "Local CI passed. Hosted required checks still apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { main(); }
  catch (error) {
    console.error(`Local CI failed: ${error.message}`);
    process.exitCode = 1;
  }
}
