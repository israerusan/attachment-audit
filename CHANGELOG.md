# Changelog

All notable changes to Attachment Audit are documented here. This project adheres to [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-03

A safety, performance and interface release. **If you use the unused detector, update.**

### Fixed — data safety

- **Widened the reference corpus.** The "is anything mentioning this file?" check only read `md`, `canvas`, `base`, `svg`, `html`, `css` and `xml`. A file referenced from a `.txt`, `.tex`, `.json`, `.excalidraw`, `.opml`, `.bib` or code file was invisible to it, so the file could be reported unused and trashed. Roughly forty text formats are now read.
- **Obsidian's config folder is now scanned too.** `vault.getFiles()` never returns anything under `.obsidian/`, so an image referenced only from a CSS snippet (`background-image: url(...)`) or from another plugin's `data.json` looked unused. Snippets and plugin data are now part of the check.
- **Notes kept in the reports folder are honoured again.** Only the timestamped reports this plugin generates are discounted from the safety signals. Previously the whole folder was ignored, so an attachment embedded from your own note in that folder could be trashed.
- **A failed read can no longer cause a false "unused".** If any source file cannot be read, the scan now declines to flag anything unused, matching what the action-time re-check already did.
- **More reference encodings recognised**: decomposed Unicode (macOS `café`), percent-encoded decomposed paths (`cafe%CC%81.png`), partially-composed text (common from Vietnamese input methods and pasted web content), and HTML-entity `&amp;`.
- **Saved scan profiles are validated.** A corrupt profile could disable every detector for its runs, or crash the scan outright.
- **Empty files are no longer treated as duplicates of each other.** Every zero-byte file shares one hash, so a folder of failed downloads formed a single "identical" cluster spanning unrelated file types.
- **Duplicate cleanup checks the filesystem.** "At least one copy always survives" previously trusted the last scan; a copy deleted outside Obsidian could leave a phantom survivor.
- **Catastrophic regex patterns are refused.** A junk-name or custom-rule pattern like `^(\w+\s?)+$` could hang Obsidian indefinitely, and did so again on every restart. Such patterns are now screened out and reported in settings.
- **Case-only renames work.** `Photo.png` → `photo.png` silently produced `photo (2).png`.
- **Move no longer flattens subfolders.** Files already inside your attachment folder — including in its subfolders — are left alone and reported.
- **Reserved Windows names are caught with any extension** (`nul.old` was allowed through).
- **Corrupt settings can no longer silently disable every detector.** A malformed `enabledIssueTypes` made scans report "0 issues", which reads as a clean vault. Settings are now validated, versioned and migrated.
- **Scans stop when the plugin unloads** instead of running on and writing settings for a plugin that no longer exists.

### Added

- **Broken link detection.** A sixth detector for links pointing at attachments that no longer exist, with the notes to fix listed per entry.
- **Image previews** in the results list and review queue (toggleable in settings).
- **Duplicate copies are grouped** into one cluster showing how much is recoverable, instead of appearing as unrelated rows.
- **Trash and Move in the review queue** (`t` and `m`) — previously you had to leave the queue to act.
- **Destructive confirmations list the exact files** they will touch.
- **A scan-failure state**, so stale results are never presented as current.
- Named scan phases and honest progress for the hashing and reference passes.

### Changed

- **More is free.** Report export, bulk ignore and bulk mark-reviewed no longer require Pro. The Pro line is now bulk *mutation* (trash, dedupe, move) plus profiles, custom rules and severity tuning. The one-time free bulk cleanup remains.
- **The results row was rebuilt.** In a 300px sidebar the filename previously got about five characters; it now gets the full row width, with severity as a colour rail, a preview, a single meta line, and actions revealed on hover.
- Sidebar chrome trimmed: no duplicated title, filter pills instead of stacked tiles, and a two-control toolbar.

### Performance

- The live safety re-check is **incremental**: single-file trash used to re-read and re-scan the entire vault on every click. It now re-reads only the sources Obsidian reported as changed since the scan, and falls back to a full pass whenever that record cannot be trusted — deliberately *not* using file timestamps, which sync clients preserve from the originating device.
- Duplicate hashing is **bounded by bytes, not file count** — the previous batching could hold ~1.6 GB of file buffers at once.
- The reference matcher is roughly **40% faster with ~17% less memory per pattern**, and no longer freezes the UI during action-time checks.
- Duplicate reporting no longer allocates a sibling list per cluster member.

### Internal

- `src/core` purity is now enforced by lint, not by comment.
- New tested modules for regex screening, filename sanitizing, settings normalization, report identification and broken-link detection; the test runner reports all failures instead of stopping at the first.

## [1.0.0] - 2026-07-06

Initial release.

### Added
- Attachment scan with five detectors: unused, duplicates, large files, poorly named, and misplaced.
- Two-signal unused detection (resolved links + raw-content mention scan across notes, frontmatter, and canvas files) to avoid false positives.
- Duplicate detection via size-bucketed SHA-256 hashing.
- Dashboard with a reclaimable-space total, per-type tiles, and a one-at-a-time review queue.
- Free per-attachment actions: open, reveal, link-safe rename, ignore, exclude, mark reviewed.
- Pro ($9 one-time): safe bulk actions (trash unused, trash duplicate copies, move to attachment folder), saved scan profiles, custom rules, severity tuning, and Markdown report export.
- Offline Ed25519 license verification (no account, no server).
