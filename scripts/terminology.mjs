#!/usr/bin/env node
// Project terminology validation and glossary generation.
// The ASD-STE100 dictionary is not embedded in this tool.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = ["docs/terminology/core.json", "docs/terminology/miniquad.json"];
const load = (file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const registries = paths.map(load);

export function validate(registries) {
    const errors = [];
    const concepts = new Map();
    const labels = new Map();
    for (const group of registries) {
        if (!/^[a-z][a-z0-9-]*$/.test(group.namespace ?? "")) errors.push("Invalid namespace");
        if (!/^\d+\.\d+\.\d+$/.test(group.version ?? "")) errors.push("Invalid version in " + group.namespace);
        if (!Array.isArray(group.concepts) || group.concepts.length === 0) {
            errors.push("Missing concepts in " + group.namespace);
            continue;
        }
        for (const c of group.concepts) {
            if (typeof c.id !== "string" || !c.id.startsWith(group.namespace + ":")) errors.push("Invalid ID " + c.id);
            if (concepts.has(c.id)) errors.push("Duplicate ID " + c.id);
            if (typeof c.term !== "string" || c.term.trim().length < 2) errors.push("Missing term " + c.id);
            if (typeof c.definition !== "string" || c.definition.trim().length < 10) errors.push("Missing definition " + c.id);
            if (!["technical-noun", "technical-verb"].includes(c.kind)) errors.push("Invalid kind " + c.id);
            concepts.set(c.id, c);
            for (const label of [c.term, ...(c.aliases ?? [])]) {
                if (typeof label !== "string" || !label.trim()) {
                    errors.push("Empty label " + c.id);
                    continue;
                }
                const key = label.toLocaleLowerCase("en-US").trim();
                if (labels.has(key) && labels.get(key) !== c.id) errors.push("Ambiguous label: " + label);
                labels.set(key, c.id);
            }
        }
    }
    for (const c of concepts.values()) {
        const refs = [...(c.related ?? []), ...(c.broader ? [c.broader] : [])];
        if (new Set(refs).size !== refs.length) errors.push("Repeated relation " + c.id);
        for (const ref of refs) {
            if (ref === c.id) errors.push("Self relation " + c.id);
            if (!concepts.has(ref)) errors.push("Unknown concept " + ref + " from " + c.id);
        }
        // A parent hierarchy must not have a cycle.
        const seen = new Set([c.id]);
        let parent = c.broader;
        while (parent && concepts.has(parent)) {
            if (seen.has(parent)) { errors.push("Parent cycle at " + c.id); break; }
            seen.add(parent);
            parent = concepts.get(parent).broader;
        }
    }
    // Shared terms must not depend on a project-specific concept.
    for (const c of registries.find(g => g.namespace === "core")?.concepts ?? []) {
        for (const ref of [...(c.related ?? []), ...(c.broader ? [c.broader] : [])]) {
            if (!ref.startsWith("core:")) errors.push("Core depends on project: " + c.id);
        }
    }
    return errors;
}

export function render(registries) {
    const lines = [
        "# Miniquad technical glossary",
        "",
        "Use the preferred terms in this glossary.",
        "Do not change the meaning of an existing concept ID.",
        "The JSON files are the sources for these definitions.",
        "Other projects can reuse `docs/terminology/core.json` without Miniquad-specific terms.",
        "",
        "This glossary is a project technical noun and verb list.",
        "It is not a copy of the ASD-STE100 dictionary.",
        "The terms are **STE-aligned drafts** until a full dictionary review is complete.",
        "See [MADR 0003](adr/0003-use-asd-ste100-for-communication.md).",
        "",
    ];
    for (const group of registries) {
        lines.push("## " + (group.namespace === "core" ? "Reusable engineering terms" : "Miniquad-specific terms"), "");
        lines.push("| Preferred term | Definition | Concept ID |", "| --- | --- | --- |");
        for (const c of group.concepts) {
            const safe = s => s.replaceAll("|", "\\|").replaceAll("\n", " ");
            lines.push("| " + safe(c.term) + " | " + safe(c.definition) + " | `" + c.id + "` |");
        }
        lines.push("");
    }
    lines.push("## Term rules", "",
        "1. Add or change a term in the JSON registry.",
        "2. Give a new concept a stable ID and one definition.",
        "3. Put general terms in `core.json`. Put library terms in `miniquad.json`.",
        "4. Do not change the meaning of an existing ID. Add a new ID for a new meaning.",
        "5. Use an alias only when the context cannot cause confusion.",
        "6. Use the same term in issues, PRs, tests, and documents.",
        "7. Run `node scripts/terminology.mjs --write` to update this file.",
        "8. Run `node scripts/terminology.mjs --check` before you send a PR.",
        "",
        "**Writing review state:** STE-aligned draft. Full dictionary review not done.", "");
    return lines.join("\n");
}

const errors = validate(registries);
if (errors.length) {
    for (const error of errors) console.error("Terminology: " + error);
    process.exitCode = 1;
} else {
    const output = render(registries);
    const target = resolve(root, "docs/glossary.md");
    if (process.argv.includes("--write")) {
        writeFileSync(target, output, "utf8");
        console.log("Updated docs/glossary.md");
    } else if (process.argv.includes("--check")) {
        if (readFileSync(target, "utf8") !== output) {
            console.error("The glossary is not current. Run: node scripts/terminology.mjs --write");
            process.exitCode = 1;
        } else {
            console.log("Terminology validated: " + registries.reduce((n,g)=>n+g.concepts.length,0) + " concepts");
        }
    } else {
        console.log(output);
    }
}
