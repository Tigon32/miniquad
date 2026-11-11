#!/usr/bin/env node
// Check project-owned Markdown paths and architecture decision metadata.
// This check does not validate ASD-STE100 grammar or document semantics.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set([".git", "target", "node_modules", ".external", ".local-ci", "test-results"]);
const statusSet = new Set(["Proposed", "Accepted", "Deprecated", "Superseded"]);

export function markdownLinks(content) {
    const links = [];
    let fenced = false;
    for (const [n, line] of content.split(/\r?\n/u).entries()) {
        if (/^\s*(?:\x60{3,}|~{3,})/u.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
            let target = match[1].trim();
            if (target.startsWith("<") && target.endsWith(">")) {
                target = target.slice(1, -1);
            }
            target = target.split(/\s+["']/u)[0];
            if (target && !/^(?:https?:|mailto:|data:|#)/iu.test(target)) {
                links.push({line:n + 1,target});
            }
        }
    }
    return links;
}

export function checkLink(path, target, folder = root) {
    const local = target.split(/[?#]/u)[0];
    if (!local) return null;
    let decoded;
    try { decoded = decodeURIComponent(local); }
    catch { return "Invalid link encoding: " + target; }
    const destination = resolve(local.startsWith("/") ? folder : dirname(path),
        decoded.replace(/^\//u,""));
    if (!destination.startsWith(folder + sep) && destination !== folder) {
        return "Link outside repository: " + target;
    }
    return existsSync(destination) ? null : "Missing link target: " + target;
}

function walk(directory) {
    const files = [];
    for (const item of readdirSync(directory,{withFileTypes:true})) {
        if (skip.has(item.name)) continue;
        const path = join(directory,item.name);
        if (item.isDirectory()) files.push(...walk(path));
        else if (item.isFile() && extname(path) === ".md") files.push(path);
    }
    return files;
}

export function audit(rootDir = root) {
    const errors = [];
    for (const path of walk(rootDir)) {
        const text = readFileSync(path,"utf8");
        for (const link of markdownLinks(text)) {
            const error = checkLink(path,link.target,rootDir);
            if (error) errors.push(relative(rootDir,path)+":"+link.line+": "+error);
        }
    }

    const adrFolder = join(rootDir,"docs/adr");
    const adrIndex = readFileSync(join(adrFolder,"README.md"),"utf8");
    for (const file of readdirSync(adrFolder)) {
        if (!/^\d{4}-[\w-]+\.md$/u.test(file)) continue;
        const doc = readFileSync(join(adrFolder,file),"utf8");
        const status = doc.match(/\*\s*Status:\s*\*\*(Proposed|Accepted|Deprecated|Superseded)\*\*/u)?.[1];
        if (!status || !statusSet.has(status)) errors.push("ADR has no valid status: "+file);
        const lines = adrIndex.split(/\r?\n/u).filter(line=>
            /^\s*\*\s*\[\d{4}\s/u.test(line) && line.includes("]("+file+")"));
        if (lines.length !== 1) errors.push("ADR index must contain exactly one entry: "+file);
        else if (status && !lines[0].includes("**"+status+"**")) errors.push("ADR index status differs: "+file);
    }

    const agents = readFileSync(join(rootDir,"AGENTS.md"),"utf8");
    const required = ["docs/adr/README.md", "docs/glossary.md",
                      "docs/adr/0003-use-asd-ste100-for-communication.md",
                      ".github/skills/miniquad-verified-delivery/SKILL.md"];
    for (const key of required) if (!agents.includes(key)) errors.push("AGENTS.md missing reference: "+key);

    const skillsFolder = join(rootDir,".github/skills");
    for (const entry of readdirSync(skillsFolder,{withFileTypes:true})) {
        if (!entry.isDirectory()) continue;
        const filename = join(skillsFolder,entry.name,"SKILL.md");
        if (!existsSync(filename)) errors.push("Canonical skill missing: "+entry.name);
        const pointer = join(rootDir,".cursor/skills",entry.name,"SKILL.md");
        if (!existsSync(pointer)) errors.push("Skill discovery pointer missing: "+entry.name);
        else if (!readFileSync(pointer,"utf8").includes(".github/skills/"+entry.name+"/SKILL.md")) {
            errors.push("Skill discovery pointer does not link to canonical source: "+entry.name);
        }
    }
    return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const errors = audit();
    for (const error of errors) console.error("Documentation: "+error);
    if (errors.length) process.exitCode = 1;
    else console.log("Documentation paths, decision statuses, and skill pointers passed.");
}
