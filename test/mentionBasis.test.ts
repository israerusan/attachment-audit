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
