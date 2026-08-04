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

// Extension-less files and dotfiles are not sources.
assert.ok(!isMentionSourcePath("LICENSE"));
assert.ok(!isMentionSourcePath(".gitignore"), "a dotfile with no real extension is not a source");
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
