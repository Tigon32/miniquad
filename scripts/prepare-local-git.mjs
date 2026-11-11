#!/usr/bin/env node
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { checkedProcess } from "./local-ci.mjs";

export function prepareLocalGit(root, bundle, sha) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("Missing or invalid local source SHA");
  const probe = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (probe.error) throw probe.error;
  if (probe.status === 0) {
    if (probe.stdout.trim() !== sha) throw new Error("Container Git HEAD does not match the local source");
    return;
  }
  const pointer = join(root, ".git");
  if (!lstatSync(pointer).isFile() || !readFileSync(pointer, "utf8").startsWith("gitdir: ")) {
    throw new Error("Expected an inaccessible copied worktree Git pointer");
  }
  const head = checkedProcess("git", ["-C", dirname(bundle), "bundle", "list-heads", bundle, "HEAD"]);
  if (head !== `${sha} HEAD`) throw new Error("Local Git bundle does not match the source SHA");
  unlinkSync(pointer);
  const git = (...args) => checkedProcess("git", ["-C", root, ...args]);
  git("init", "--initial-branch=local-act");
  git("fetch", "--no-tags", bundle, "HEAD");
  git("update-ref", "HEAD", sha);
  git("read-tree", sha);
  git("remote", "add", "origin", "https://github.com/Tigon32/miniquad.git");
  console.log(`Restored isolated worktree Git metadata at ${sha}; source files were not checked out.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    if (process.env.ACT !== "true") throw new Error("This repair is only for the local act container");
    prepareLocalGit(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "/miniquad-source.bundle", process.env.MINIQUAD_LOCAL_SHA);
  } catch (error) {
    console.error(`Local Git preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
