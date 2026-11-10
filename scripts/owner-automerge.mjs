#!/usr/bin/env node
// Metadata-only check. The script does not execute code from a pull request.
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const allowedActions=new Set(["opened","reopened","synchronize","ready_for_review"]);
const repository="Tigon32/miniquad";
const owner="Tigon32";

export function mayEnableAutoMerge(event) {
    if (!event || !allowedActions.has(event.action)) return false;
    if (event.sender?.login !== owner) return false;
    if (event.repository?.full_name !== repository) return false;
    const pr=event.pull_request;
    if (!pr || pr.state !== "open" || pr.draft !== false) return false;
    if (pr.user?.login !== owner || pr.author_association !== "OWNER") return false;
    if (pr.head?.repo?.full_name !== repository) return false;
    if (pr.base?.repo?.full_name !== repository || pr.base?.ref !== "master") return false;
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) return false;
    if (typeof pr.head.sha !== "string" || !/^[0-9a-f]{40}$/u.test(pr.head.sha)) return false;
    return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const filename=process.argv[2];
    if (!filename) {
        console.error("Usage: node scripts/owner-automerge.mjs GITHUB_EVENT_PATH");
        process.exit(2);
    }
    const event=JSON.parse(readFileSync(filename,"utf8"));
    if (!mayEnableAutoMerge(event)) {
        console.error("Auto-merge refused: event is not an authorized owner PR.");
        process.exit(1);
    }
    console.log("Owner PR passed the metadata guard: #"+event.pull_request.number);
}
