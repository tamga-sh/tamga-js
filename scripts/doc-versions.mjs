#!/usr/bin/env node
// Keeps the version strings in this repo's docs honest against package.json.
//
//   node scripts/doc-versions.mjs --check   fail if a doc pins a stale version
//   node scripts/doc-versions.mjs --write    rewrite annotated versions
//
// Why both halves exist, since they look redundant:
//
// --write handles versions that are *annotated*. It is the same contract the
// release-please repositories in this fleet use, down to the marker spelling,
// so a contributor moving between them meets one convention rather than eight.
// release-please does not run here -- changesets does -- but the annotation is
// the part a human reads, so it is the part worth keeping identical.
//
// --check handles versions that are NOT annotated, which is the failure this
// repo can actually have today. Nothing here pins a version on purpose: the
// install line is `npm install @tamga/sdk`, the Deno example imports
// `npm:@tamga/sdk` and the browser example `https://esm.sh/@tamga/sdk`, all
// unpinned so they resolve whatever is current. That is a deliberate choice,
// and it is one edit away from being lost -- pinning an example is a normal,
// reasonable thing for someone to do, and an un-annotated pin is invisible to
// --write forever after. --check is what notices.
//
// So: annotate it and it updates itself; forget to annotate it and CI says so.
//
// Found the hard way across this fleet -- four SDKs had a pinned version in
// their README and all four were stale by exactly the release that had just
// shipped. Nothing was watching, in any of them.

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG = "@tamga/sdk";

// Same markers release-please's Generic updater recognises, so the annotation
// means the same thing in every repository in this fleet.
const BLOCK_START = /x-release-please-start-version/;
const BLOCK_END = /x-release-please-end/;
const INLINE = /x-release-please-version/;

// A full semver core. Deliberately not a looser pattern: prose like "Node 18"
// or "v2 of the format" must never be mistaken for a package version.
const SEMVER = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/;

// The shapes an actual dependency on this package takes in documentation:
// an npm/JSR-style specifier (`@tamga/sdk@0.4.1`, also what esm.sh and Deno's
// `npm:` take), or a manifest entry (`"@tamga/sdk": "0.4.1"`).
const PINNED = new RegExp(
  `${PKG.replace("/", "\\/")}(?:@|"\\s*:\\s*"[\\^~]?)(${SEMVER.source})`,
  "g",
);

const DOC_ROOTS = ["README.md", "docs"];
const DOC_EXTENSIONS = [".md", ".ts", ".js", ".mjs", ".html", ".json"];

function docFiles() {
  const out = [];
  const walk = (path) => {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (DOC_EXTENSIONS.some((ext) => path.endsWith(ext))) out.push(path);
  };
  for (const root of DOC_ROOTS) walk(root);
  return out;
}

function currentVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

/** Rewrite annotated versions. Returns the files it changed. */
function write(version) {
  const changed = [];
  for (const file of docFiles()) {
    const before = readFileSync(file, "utf8");
    let inBlock = false;
    const after = before
      .split("\n")
      .map((line) => {
        if (inBlock) {
          if (BLOCK_END.test(line)) inBlock = false;
          else return line.replace(SEMVER, version);
          return line;
        }
        if (BLOCK_START.test(line)) {
          inBlock = true;
          return line;
        }
        // An inline marker annotates its own line, so replacing the version
        // there would also rewrite the marker if it ever carried digits. It
        // does not, but replace only the first match to keep that true.
        return INLINE.test(line) ? line.replace(SEMVER, version) : line;
      })
      .join("\n");
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(file);
    }
  }
  return changed;
}

/** Find pins that disagree with package.json. Returns the offenders. */
function check(version) {
  const stale = [];
  for (const file of docFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PINNED)) {
        if (match[1] !== version) {
          stale.push({ file, line: index + 1, found: match[1], text: line.trim() });
        }
      }
    });
  }
  return stale;
}

const mode = process.argv[2];
const version = currentVersion();

if (mode === "--write") {
  const changed = write(version);
  console.log(
    changed.length
      ? `doc-versions: wrote ${version} into ${changed.join(", ")}`
      : `doc-versions: no annotated versions to update (nothing in this repo pins one)`,
  );
} else if (mode === "--check") {
  const stale = check(version);
  if (stale.length === 0) {
    console.log(`doc-versions: no stale pins against ${version}`);
  } else {
    console.error(`doc-versions: ${stale.length} stale pin(s); package.json is ${version}\n`);
    for (const s of stale) {
      console.error(`  ${s.file}:${s.line}  pins ${s.found}\n    ${s.text}`);
    }
    console.error(
      `\nEither drop the pin so the example resolves what is current, or wrap it in` +
        `\n<!-- x-release-please-start-version --> ... <!-- x-release-please-end --> so` +
        `\n\`--write\` keeps it in step with every release.`,
    );
    process.exit(1);
  }
} else {
  console.error("usage: doc-versions.mjs --check | --write");
  process.exit(2);
}
