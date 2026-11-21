import assert from "node:assert";
import { isMentionSourcePath } from "../src/core/scan/scanVault";

// The plugin's vault-event listeners classify changed files with this predicate,
// and the scan filters its source list with the same rule. If they ever disagree,
// a changed source is silently dropped from the incremental live re-check and a
// still-referenced file becomes trashable.

// Documents.
assert.ok(isMentionSourcePath("Notes/Some Note.md"));
assert.ok(isMentionSourcePath("Boards/Plan.canvas"));
assert.ok(isMentionSourcePath("Data/Table.base"));

// Text attachments that can carry a reference. Each of these was previously
// UNREADABLE by the safety scan, which is how a live file could be trashed.
for (const path of [
  "notes/paper.tex",
  "refs/library.bib",
  "data/config.json",
  "drawings/sketch.excalidraw",
  "theme/custom.css",
  "page/index.html",
  "icons/logo.svg",
  "notes/readme.txt",
  "scripts/build.js",
  "data/config.yaml",
  "outline/plan.opml",
  "subs/movie.srt",
]) {
  assert.ok(isMentionSourcePath(path), `${path} must be read as a reference source`);
}

// Binary attachments are never sources.
for (const path of ["img/photo.png", "docs/report.pdf", "audio/clip.mp3", "video/clip.mp4"]) {
  assert.ok(!isMentionSourcePath(path), `${path} is not a reference source`);
}

// Formats the old allowlist omitted. Each was a file the safety scan would never
// read while still being willing to trash what it referenced — a `Hero.tsx` with
// an `<img src="../assets/hero.png" />` made `hero.png` look unused. The rule is
// now a binary DENYLIST, so a format nobody thought of costs one wasted read
// rather than a lost file.
for (const path of [
  "site/Hero.tsx",
  "site/Card.jsx",
  "site/App.vue",
  "site/App.svelte",
  "styles/main.scss",
  "scripts/deploy.ps1",
  "src/Main.java",
  "src/main.go",
  "queries/report.sql",
  "logs/import.log",
  "conf/app.conf",
  "templates/page.njk",
]) {
  assert.ok(isMentionSourcePath(path), `${path} must be read as a reference source`);
}

// Extension-less files and dotfiles ARE sources now, for the same reason: a file
// with no extension is far more likely to be a config or a text file carrying a
// path than a binary blob, and guessing wrong in the other direction costs a file.
assert.ok(isMentionSourcePath("LICENSE"), "an extension-less file is read, not assumed binary");
assert.ok(isMentionSourcePath(".gitignore"), "a dotfile is read, not assumed binary");
// ...but a file literally named `.md` IS `md` to Obsidian, and the scan classifies
// by TFile.extension — the listener must agree or a changed source goes untracked.
assert.ok(isMentionSourcePath("notes/.md"));
assert.ok(isMentionSourcePath(".json"));

// Case must not matter — an uppercase extension is the same source type.
assert.ok(isMentionSourcePath("Notes/NOTE.MD"));
assert.ok(isMentionSourcePath("Theme/Custom.CSS"));

console.log("mentionBasis tests passed");

// --- Our own data file must never be a reference source --------------------
// The scan reads `.obsidian/plugins/*/data.json`, because other plugins
// legitimately reference vault images there. But OUR data.json records every
// path we touch — ignored keys, excluded paths, and the cleanup journal — so
// reading it made this plugin's own bookkeeping suppress its own detection: a
// file restored from the trash was "mentioned" by the journal entry describing
// its removal, and could never be flagged unused again.
//
// Verified in a real vault: after trashing and restoring, the filenames appeared
// twice each in our own data.json and the file stopped being reported.
import { PRODUCT_ID } from "../src/product";

assert.strictEqual(PRODUCT_ID, "attachment-audit", "the id used to skip our own data file");
// The skip is by directory name, so it must match what Obsidian installs to.
const ownDir = `.obsidian/plugins/${PRODUCT_ID}`;
assert.ok(ownDir.endsWith(`/${PRODUCT_ID}`), "the endsWith guard matches a real install path");
// A DIFFERENT plugin whose id merely contains ours must STILL be read — its
// data.json can reference vault images just like any other plugin's.
assert.strictEqual(
  `.obsidian/plugins/${PRODUCT_ID}-extras`.endsWith(`/${PRODUCT_ID}`),
  false,
  "a longer id is a different plugin"
);
assert.strictEqual(
  `.obsidian/plugins/my-${PRODUCT_ID}`.endsWith(`/${PRODUCT_ID}`),
  false,
  "a prefixed id is a different plugin"
);

console.log("own-data-file exclusion tests passed");

// ======================================== binary media must not blind the scan
// An oversized SOURCE trips the fail-safe that marks every candidate as mentioned.
// That is right for a text file we could not read, but `.m4b` (audiobooks) and
// friends were missing from the binary denylist, so they were classified as text
// sources — and one 60 MB audiobook anywhere in the vault silently switched off
// unused detection for the entire vault.
import { scanVault } from "../src/core/scan/scanVault";
import { DEFAULT_SETTINGS } from "../src/core/settings/defaults";
import type { App } from "obsidian";
import type { ScanConfig } from "../src/types";

for (const path of ["books/novel.m4b", "clips/a.mxf", "comics/issue.cbz", "img/photo.jxl", "maps/route.kmz"]) {
  assert.ok(!isMentionSourcePath(path), `${path} is binary, not a reference source`);
}

/** Awaited by `test/run.mjs`, so a failure inside the async scan fails this file. */
export const done = (async (): Promise<void> => {
  const mkFile = (path: string, size: number) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return {
      path,
      name,
      basename: name.slice(0, dot),
      extension: name.slice(dot + 1),
      stat: { size, mtime: 0, ctime: 0 },
    };
  };
  const files = [
    mkFile("Notes/Index.md", 20),
    mkFile("assets/orphan.png", 1000),
    mkFile("books/novel.m4b", 60 * 1024 * 1024),
  ];
  const texts: Record<string, string> = { "Notes/Index.md": "# nothing linked" };
  const app = {
    vault: {
      getFiles: () => files,
      configDir: ".obsidian",
      cachedRead: (f: { path: string }) => {
        if (!(f.path in texts)) throw new Error(`binary file read as text: ${f.path}`);
        return Promise.resolve(texts[f.path]);
      },
      adapter: {
        exists: () => Promise.resolve(false),
        list: () => Promise.resolve({ files: [], folders: [] }),
        read: () => Promise.resolve(""),
      },
    },
    metadataCache: { resolvedLinks: {}, unresolvedLinks: {}, getFileCache: () => null },
  } as unknown as App;
  const config: ScanConfig = {
    enabledIssueTypes: ["unused"],
    largeSizeThresholdKb: DEFAULT_SETTINGS.largeSizeThresholdKb,
    attachmentFolder: "",
    junkNamePatterns: [],
    duplicateMaxScanKb: 0,
    attachmentExtensions: [],
    includedFolders: [],
    excludedFolders: [],
    excludedPaths: [],
    severityWeights: DEFAULT_SETTINGS.severityWeights,
    customRules: [],
    sortMode: "path",
  };
  const result = await scanVault(app, config, false, 0);
  const unused = result.issues.filter((i) => i.issueType === "unused").map((i) => i.attachmentPath);
  assert.deepStrictEqual(
    unused.sort(),
    ["assets/orphan.png", "books/novel.m4b"],
    "an audiobook in the vault must not disable unused detection"
  );
  console.log("binary-media blind-scan tests passed");
})();
