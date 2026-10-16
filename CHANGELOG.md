# Changelog

All notable changes to Attachment Audit are documented here. This project adheres to [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-10-15

A hardening release. Five independent adversarial reviews plus two outside models
went at this plugin looking for ways to lose a file, mis-report one, or freeze
Obsidian. This is what they found, and the numbers below are measured, not
estimated.

Nothing here changes how you use Attachment Audit. Several things change what it
refuses to do.

### Fixed — data loss

- **An interrupted bulk cleanup no longer loses its undo.** The cleanup history
  was written once, after the whole batch finished. Force-quit Obsidian (or let
  mobile kill it in the background) partway through trashing 2,000 attachments and
  900 files were in the trash with *no record of where any of them came from* —
  and because Obsidian's `.trash` is flat, their original folders were
  unrecoverable by any means. History is now written as the cleanup proceeds.
- **A file that becomes referenced *during* a cleanup is no longer trashed.** The
  two-signal safety verdict was established once per batch, then used for a loop
  that can run for minutes. A note arriving from Obsidian Sync, or an embed you
  typed, was invisible to the rest of that batch. The verdict is now
  re-established whenever anything in the vault changes mid-cleanup.
- **A cleanup stops when the plugin unloads.** Disabling or uninstalling
  Attachment Audit mid-batch kept deleting files on its behalf.
- **Undo can no longer hand two files each other's contents.** When one batch
  trashed two files sharing a name (`a/logo.png` and `b/logo.png`), restoring
  gave one entry the unsuffixed trash file and the other whatever was left — both
  paths restored with the wrong content, reported as success. Without a content
  hash to tell them apart, Attachment Audit now refuses rather than guesses.
- **Undoing a move verifies content, not just size.** If you deleted a moved file
  and left a different file of the same size at that path, the undo relocated the
  stranger and rewrote every link in your vault to point at it.
- **A failed write no longer hides a completed cleanup.** If recording the
  history failed (full disk, read-only vault), the error travelled out past the
  completion notice *and* the dashboard refresh: the dialog closed, nothing
  happened, and the attachments were gone. Likewise a rename that succeeded but
  failed to record reported "rename failed" about a file that had been renamed.

### Fixed — files wrongly reported as unused

Each of these was a path to trashing something you were still using.

- **Code and config files are now read.** The list of formats scanned for
  references was an allowlist that carried `js` and `py` but not `tsx`, `jsx`,
  `vue`, `svelte`, `scss`, `php`, `lua`, `sql`, `log`, `conf` or `plist` — so a
  component containing `<img src="../assets/hero.png" />` was never read and
  `hero.png` looked like an orphan. The rule is now a binary *denylist*: an
  unknown format costs one wasted read instead of one lost file.
- **An unreadable folder is treated as "we are blind", not "it is empty".** A
  directory listing that failed — routine for a vault under OneDrive or Dropbox
  on Windows, or a sandboxed iCloud path — silently hid every CSS snippet, so an
  image used only by `background-image: url(...)` was offered for trash.
- **A case-mismatched excluded folder now excludes.** Typing `templates` for a
  folder named `Templates` excluded nothing while the settings UI showed the
  exclusion as configured.

### Fixed — wrong results

- **Dotted note links are no longer reported as broken attachments.** `[[2024.01.15]]`,
  `[[v1.2 plan]]` and `[[Dr. Smith notes]]` all count as having a "file extension"
  if the rule is just "has a dot", so every vault using dotted daily notes
  collected a broken-attachment issue per link, on every scan.
- **`Screenshot workflow diagram.png` is not junk, and neither is `Untitled Symphony No. 5`.**
  Two default junk-name patterns had no right-hand anchor, so deliberately named
  files were flagged on a free-tier default nobody had edited.
- **A case-mismatched attachment folder no longer flags your whole vault.** With
  `assets` configured against a folder named `Assets`, every attachment in the
  vault was reported as misplaced.
- **Custom rules that cannot work are now refused when you write them.** An
  unsafe or malformed regex was accepted by the rule editor, saved, and listed as
  enabled — then matched nothing, forever, with no message anywhere.
- **Realistic naming rules are no longer rejected.** `^IMG_\d+_\d+_\d+_\d+$`,
  `^Screenshot \d+-\d+-\d+ at \d+$` and `^[a-z]+-[0-9]+-[a-z]+-[0-9]+$` were all
  refused as "too many repeats". They are strictly linear — the repeats are
  separated by characters they cannot match — and the screen now proves that
  instead of counting.
- **Report links survive awkward filenames.** A path containing `|`, `#`, `[` or
  `]` produced a broken or silently aliased wikilink in the exported report.
- **A size threshold typed into settings now survives a restart.** The settings
  box accepted a value 1024x above what the loader would keep, which left a
  threshold no file could exceed — so large-file detection quietly reported
  nothing for the rest of the session.
- **Hand-edited or sync-conflicted settings are handled.** A negative "older
  than N days" in a custom rule made it match every attachment in the vault; a
  `..` in the attachment folder was passed through to the filesystem; and the
  schema version could be silently downgraded by opening an older build once.

### Fixed — freezes and memory

Measured on a 50,000-note vault with 20,000 attachments.

- **One large text file no longer takes down the window.** Reference sources were
  read 32 at a time by *count*, with no byte budget — so a single 50 MB CSV became
  ~200 MB of live strings, and 32 of them was unbounded. Reads are now budgeted by
  bytes, and a file too large to read safely is treated as unread (fail-safe)
  rather than as empty.
- **Undo is no longer quadratic.** Restoring re-scanned the entire `.trash` for
  every entry in the batch: 5,000 entries against a 50,000-file trash measured
  **145 seconds** of frozen UI. The trash is now indexed once per batch.
- **The reference scan no longer freezes mid-pass.** Building the search automaton
  for 20,000 candidates was ~230 ms of unbroken work on desktop and 1–3 s on
  mobile, with the progress bar stuck at 0 and no way to cancel.
- **A huge duplicate cluster no longer stalls the dashboard.** Page limits applied
  to the list but not inside a cluster, so one folder copied twice could put
  thousands of rows on screen at once.
- **Restoring a very large file no longer risks the window.** It was read entirely
  into memory and then written out again; above 64 MB the bytes are now moved.
- **Cleanup history can no longer grow without bound.** The newest batch was
  exempt from the entry cap, and settings are re-serialized on routine clicks, so
  one vault-wide cleanup made every later click a multi-megabyte write.
- **A crash in cleanup history no longer breaks the feature permanently.** Listing
  a very large `.trash` could throw, which degraded history to a permanent "the
  vault's trash is empty or unreadable".
- **The plugin is 44% smaller: 283 KB to 157 KB.** The release build was not being
  minified. This is startup cost every user pays, and it matters most on mobile.

### Changed

- **A cleanup whose destination was not recorded can now be undone.** Obsidian's
  "Deleted files" setting is not a public API, so any failure to read it marked a
  batch permanently unrestorable — while the files sat in the vault's trash, with
  the "Done with this" button hidden too. Attachment Audit now looks, says that it
  is looking, and tells you if they are not there.
- **"Done with this" is always available** on a batch that can be searched. It was
  hidden unless something had already come back, which is the opposite of when you
  need it.
- **The move confirmation is honest about everything it can break.** It warned
  about raw HTML and frontmatter paths but not CSS snippets, themes, other
  plugins' settings, or paths inside SVG, HTML and drawing files — all of which
  the safety scan treats as real references and Obsidian does not rewrite.

### Added

- `ARCHITECTURE.md`, stating the three invariants that hold this plugin together.
  Two of the three had already been broken once while living only as a comment.
- Continuous integration. The test suite, the Obsidian review ruleset, and the
  `src/core` purity boundary now run on every push instead of when someone
  remembers.
- A property test asserting that every pattern the regex screen accepts actually
  runs fast on adversarial input. It immediately found a pattern costing 51 ms
  *per attachment* — about 17 minutes across a 20,000-attachment vault — and the
  budget was recalibrated against that measurement.
- A contract test pinning the product id across `manifest.json`, the source, and
  the license signer. A drift between any two silently invalidates every license
  key ever issued, with a message indistinguishable from a forgery.

## [1.2.1] - 2026-08-04

Two fixes found by testing against a real vault rather than by review.

### Fixed

- **Attachment Audit no longer suppresses its own detection.** Since 1.1.0 the scan has read `.obsidian/plugins/*/data.json`, because other plugins legitimately reference vault images there — but that included *this plugin's own* data file, which records every path it touches (ignored results, excluded paths, and from 1.2.0 the cleanup journal). The reference scan found those filenames and concluded the files were still in use, so they were never reported again. Most visible after restoring something from the history: the file came back but stopped appearing in scans. Our own bookkeeping is not evidence about your vault, and is now excluded.
- **A restored file is visible to Obsidian immediately.** Restoring from the trash moved the bytes with a raw filesystem call that bypassed Obsidian's file index, so the file was on disk while the very next scan could not see it. Files are now written back through the vault, and the original modification time is preserved.

### Verified

The `.trash` layout, collision naming and restore round trip were tested against a real vault for the first time. Trashing preserves file contents and flattens folder structure, and restoring two same-named files from different folders returns each to its own folder with its own content.

## [1.2.0] - 2026-08-04

Cleanup history — see everything Attachment Audit changed, and put it back.

Until now, everything backing the claim that this plugin is safe enough to trust with bulk delete was *prose*: a README section, a confirm dialog, a two-signal safety contract you had to take on faith. This release makes it evidence.

### Added

- **Cleanup history.** Every trash, move and rename is recorded — which files, from where, to where, how big, and when. Open it from the dashboard, the command palette, or settings.
- **Restore.** Put a whole action back in one click. **Free, at any size** — Pro is for doing cleanup at scale; recovering from it is safety, not scale.
- Reversing a move or rename goes back through Obsidian, so every link it updated on the way out is updated again on the way back.
- **Honest about what it cannot do.** Only files sent to the vault's `.trash` folder can be restored by a plugin. A batch that went to your system trash says so and points you there; one that was permanently deleted says that plainly. Anything the plugin cannot verify fails closed rather than offering an undo that would not work.
- Where trashed files went is recorded **at the time of the action**, so changing your "Deleted files" setting afterwards can never make the history offer an impossible restore.
- A "Cleanup history entries" setting controls how much is kept (0 records nothing).

### Changed

- The trash confirmation now says Attachment Audit itself can put local-trash files back, rather than only that they are recoverable.

### Internal

- Settings schema version 3, with a migration from 2. Vaults upgrading from 1.1.0 start with an empty history — actions taken before there was anywhere to record them cannot be reconstructed, and inventing entries would offer restores that cannot work.
- `trashDestinationNote()` now derives from a typed `trashDestination()` accessor, retiring one of the untyped internal-API casts.

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
