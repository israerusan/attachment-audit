import { normalizePath, type App, type TFile } from "obsidian";
import { ISSUE_TYPES } from "../../types";
import { PRODUCT_ID, REPORT_FOLDER } from "../../product";
import type {
  AttachmentIssue,
  ScanConfig,
  IssueType,
  AttachmentManagerSettings,
  ScanProfile,
  RawAttachmentInput,
} from "../../types";
import { buildAttachmentStat } from "./attachmentStats";
import { isAttachment, extensionOf } from "./attachmentFilter";
import { isExcluded, includedByFolders } from "./fileFilters";
import { unusedDetector } from "../detectors/unusedDetector";
import { duplicateDetector } from "../detectors/duplicateDetector";
import { largeDetector } from "../detectors/largeDetector";
import { unnamedDetector } from "../detectors/unnamedDetector";
import { misplacedDetector } from "../detectors/misplacedDetector";
import { sizeCollisionCandidates, groupByHash } from "../dedupe/hashGrouping";
import { extractCanvasFilePaths } from "../safety/mentionScan";
import { isGeneratedReport } from "../reports/reportPaths";
import { findMissingAttachments, describeMissing } from "../detectors/missingDetector";
import { MentionMatcher, fileNameVariants } from "../safety/mentionMatcher";
import { computeReclaim, type ReclaimBreakdown } from "../reclaim/reclaimableSpace";
import { runCustomRules } from "../rules/customRuleEngine";
import { sortIssues } from "../rules/severity";
import { kbToBytes } from "../utils/sizes";
import { issueKey } from "../utils/ids";

export interface ScanResult {
  issues: AttachmentIssue[];
  totalFiles: number;
  reclaim: ReclaimBreakdown;
}

/**
 * Which stage of the scan is running. Reported alongside the counts so the UI can
 * name what is happening — the hashing and reference passes dominate wall-clock on
 * a big vault, and a bar that sits at 0% through both looks like a hang.
 */
export type ScanPhase = "collect" | "hash" | "references" | "analyze";

/** Human labels for {@link ScanPhase}, shown next to the progress bar. */
export const SCAN_PHASE_LABELS: Record<ScanPhase, string> = {
  collect: "Finding attachments",
  hash: "Comparing for duplicates",
  references: "Checking references",
  analyze: "Analyzing",
};

/** Progress callback: units done so far, of total, for the named stage. */
export type ScanProgress = (done: number, total: number, phase: ScanPhase) => void;

/** Files are read in bounded-parallel batches to overlap I/O without flooding it. */
const READ_BATCH = 32;

/**
 * Ceiling on bytes held in flight by one hashing batch. `Promise.all` keeps every
 * buffer alive until the batch resolves, so this — not the file count — is what
 * actually bounds peak memory during duplicate detection.
 */
const HASH_BYTE_BUDGET = 64 * 1024 * 1024;

/**
 * Text-like attachment extensions whose CONTENT can reference another attachment.
 * Every extension missing from this list is a file we will happily trash things
 * on behalf of but never read — so a reference living in it is invisible to the
 * second safety signal and the file it points at looks unused. That is a
 * data-loss hole, so this list errs wide: reading a file that turns out to
 * mention nothing costs a `cachedRead`, while omitting one costs the user a file.
 */
const TEXT_ATTACHMENT_EXTS = new Set([
  "svg",
  "html",
  "htm",
  "css",
  "xml",
  "txt",
  "text",
  "markdown",
  "mdx",
  "org",
  "rst",
  "adoc",
  "asciidoc",
  "tex",
  "latex",
  "bib",
  "opml",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "csv",
  "tsv",
  "js",
  "mjs",
  "cjs",
  "ts",
  "py",
  "rb",
  "sh",
  "excalidraw",
  "drawio",
  "puml",
  "mermaid",
  "mmd",
  "srt",
  "vtt",
  "url",
  "webloc",
  "desktop",
]);

/**
 * True when `text` contains any non-ASCII character, and therefore might not be
 * in Normalization Form C.
 *
 * Emitting both NFC and NFD patterns covers a reference written wholly in one
 * form, but real text is often in NEITHER: Vietnamese input methods routinely
 * produce `ê` (U+00EA) followed by a combining acute, which is neither the
 * composed form (U+1EBF) nor the fully decomposed one. Such text must still be
 * normalized before scanning.
 *
 * The test is deliberately "is there any non-ASCII byte" rather than a list of
 * combining-mark ranges. An earlier version enumerated the ranges and was WRONG:
 * a sweep of the BMP and SMP found 12,366 composable code points — every Hangul
 * syllable, plus much of Devanagari, Bengali and Gurmukhi — whose decompositions
 * contain no character in any of those ranges, so their partially-composed text
 * would have skipped normalization and failed to match. Non-ASCII is a superset
 * of every such case by construction, and ASCII text (the overwhelming majority
 * of notes) still takes the fast path.
 */
function needsNormalization(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/**
 * Slack on mtime comparisons, covering coarse filesystem timestamps and clock
 * skew. Only ever WIDENS the set of files re-read.
 */
const MTIME_SLACK_MS = 5000;

/** Prepare a source text for scanning: normalize only when it can matter, then fold case. */
function searchable(text: string): string {
  return (needsNormalization(text) ? text.normalize("NFC") : text).toLowerCase();
}

/** Extensions whose content is scanned as a reference SOURCE (never trashed). */
function isMentionSource(ext: string): boolean {
  return ext === "md" || ext === "canvas" || ext === "base" || TEXT_ATTACHMENT_EXTS.has(ext);
}

/**
 * Whether a vault path is read as a reference source. Exported so the plugin's
 * vault-event listeners classify files with exactly the same rule the scan uses —
 * a mismatch would silently drop a changed source from the incremental re-check.
 */
export function isMentionSourcePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  // `extensionOf` treats a leading dot as "dotfile, no extension", but Obsidian's
  // `TFile.extension` reports `md` for a file literally named `.md` — and the scan
  // classifies by TFile.extension. Mirror that, or a changed source could be read
  // by the scan yet never tracked by the listener that feeds the incremental
  // re-check.
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return isMentionSource(ext);
}

/**
 * The single boundary that touches the Obsidian API. It gathers a plain
 * {@link RawAttachmentInput} per attachment, hashes duplicate candidates, runs a
 * conservative "unused" safety scan, then runs the pure detectors over them.
 * `now` is injected so scans are deterministic in tests.
 */
export async function scanVault(
  app: App,
  config: ScanConfig,
  isPro: boolean,
  now: number,
  onProgress?: ScanProgress,
  isAborted?: () => boolean
): Promise<ScanResult> {
  const yielder = makeYielder();
  try {
    return await runScanPasses(app, config, isPro, now, yielder, onProgress, isAborted);
  } finally {
    yielder.dispose();
  }
}

async function runScanPasses(
  app: App,
  config: ScanConfig,
  isPro: boolean,
  now: number,
  yielder: { yield: () => Promise<void> },
  onProgress?: ScanProgress,
  isAborted?: () => boolean
): Promise<ScanResult> {
  await yielder.yield(); // let the "Scanning…" state paint before the synchronous pre-work

  let lastYield = performance.now();
  const enabled = new Set<IssueType>(config.enabledIssueTypes);
  // 8ms, not a full 16ms frame: blocking for the whole frame budget and only THEN
  // yielding guarantees the paint after every yield point is already late.
  //
  // Every yield point is also an abort point: a scan that keeps walking the vault
  // after the plugin unloaded will finish by writing data.json for a plugin that
  // no longer exists (recreating its data folder if the user just uninstalled).
  const maybeYield = async (): Promise<void> => {
    if (isAborted?.()) throw new ScanAbortedError();
    if (performance.now() - lastYield > 8) {
      await yielder.yield();
      if (isAborted?.()) throw new ScanAbortedError();
      lastYield = performance.now();
    }
  };

  const normPath = (p: string): string => normalizePath(p).replace(/\/$/, "");
  const exclusion = {
    excludedFolders: config.excludedFolders.map(normPath),
    excludedPaths: config.excludedPaths.map(normPath),
    excludedTags: [] as string[], // attachments carry no tags
  };
  const includedFolders = config.includedFolders.map(normPath);

  // --- Pass 1: ONE walk of the vault, partitioned into attachment candidates and
  // mention sources (notes/canvas/base/text-attachments whose content can
  // reference an attachment). A file can be both (e.g. an SVG).
  const candidates: TFile[] = [];
  const sources: TFile[] = [];
  const allFiles = app.vault.getFiles();
  for (let f = 0; f < allFiles.length; f++) {
    const file = allFiles[f];
    if ((f & 1023) === 0) await maybeYield();
    // Skip only the reports WE generated — a user's own note in that folder is a
    // real reference source and must still protect the attachments it embeds.
    if (isGeneratedReport(file.path, REPORT_FOLDER)) continue;
    const ext = file.extension.toLowerCase();
    if (isMentionSource(ext)) sources.push(file);
    if (
      isAttachment(file.path, config.attachmentExtensions) &&
      !isExcluded(file.path, [], exclusion) &&
      includedByFolders(file.path, includedFolders)
    ) {
      candidates.push(file);
    }
  }

  const totalFiles = candidates.length;
  onProgress?.(totalFiles, totalFiles, "collect");

  const inbound = enabled.has("unused") ? buildInboundCounts(app) : new Map<string, number>();
  const inputs: RawAttachmentInput[] = candidates.map((file) => ({
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension.toLowerCase(),
    size: file.stat.size,
    mtime: file.stat.mtime,
    inboundLinks: inbound.get(file.path) ?? 0,
  }));

  // --- Pass 2: duplicate hashing (gated). Only hash files that share a size with
  // another file and are under the memory cap — most files are never read.
  let hashToPaths = new Map<string, string[]>();
  if (enabled.has("duplicate")) {
    // A cap of 0 (or less) disables duplicate hashing entirely — matching the
    // "skip files larger than this" setting, where 0 means "skip everything".
    const cap = kbToBytes(config.duplicateMaxScanKb);
    // Carry the TFile and the input index on the candidate record itself, so the
    // batch loop needs no path->file / path->index lookup maps.
    const collide =
      cap <= 0
        ? []
        : sizeCollisionCandidates(
            candidates.map((file, idx) => ({
              path: file.path,
              size: inputs[idx].size,
              idx,
              file,
            }))
          ).filter((c) => c.size <= cap);

    // Batch by BYTES, not by file count. `Promise.all` keeps every buffer in the
    // batch live until the whole batch resolves, so a fixed count of 32 against
    // the default 50 MB per-file cap could hold 1.6 GB of ArrayBuffers at once
    // (32 large videos are one `cp -r` away). A byte budget keeps concurrency high
    // for the small files that dominate, and drops to one-at-a-time for huge ones.
    let cursor = 0;
    let hashed = 0;
    onProgress?.(0, collide.length, "hash");
    while (cursor < collide.length) {
      const batch: typeof collide = [];
      let budget = 0;
      // Always take at least one file, even if it alone exceeds the budget.
      do {
        batch.push(collide[cursor]);
        budget += collide[cursor].size;
        cursor++;
      } while (
        cursor < collide.length &&
        batch.length < READ_BATCH &&
        budget + collide[cursor].size <= HASH_BYTE_BUDGET
      );

      const hashes = await Promise.all(
        batch.map((c) => hashFile(app, c.file).catch(() => null))
      );
      for (let j = 0; j < batch.length; j++) {
        const h = hashes[j];
        if (h) inputs[batch[j].idx].hash = h;
      }
      hashed += batch.length;
      onProgress?.(hashed, collide.length, "hash");
      await maybeYield();
    }
    hashToPaths = groupByHash(inputs.map((inp) => ({ path: inp.path, hash: inp.hash })));
  }

  // --- Pass 3: unused safety scan (gated). For zero-inbound files, any mention of
  // the filename in a source SUPPRESSES the unused flag. Aho-Corasick scans each
  // source ONCE against ALL candidate filename variants (O(text), not O(text x
  // candidates)), so this stays fast even with thousands of unused candidates.
  if (enabled.has("unused")) {
    const pending: RawAttachmentInput[] = [];
    for (const inp of inputs) {
      if (inp.inboundLinks <= 0) {
        inp.mentionedInContent = false;
        pending.push(inp);
      }
    }
    if (pending.length > 0) {
      const matcher = new MentionMatcher();
      pending.forEach((inp, idx) => {
        for (const variant of fileNameVariants(inp.name)) matcher.addPattern(variant, idx);
      });
      matcher.build();

      let readFailed = false;
      const hits = new Set<number>();
      let scanned = 0;
      onProgress?.(0, sources.length, "references");
      for (let i = 0; i < sources.length; i += READ_BATCH) {
        const batch = sources.slice(i, i + READ_BATCH);
        const texts = await Promise.all(
          batch.map((s) =>
            readSourceText(app, s).catch(() => {
              readFailed = true;
              return "";
            })
          )
        );
        for (const text of texts) {
          if (text) matcher.scanInto(searchable(text), hits);
          await maybeYield();
        }
        scanned += batch.length;
        onProgress?.(scanned, sources.length, "references");
      }
      for (const text of await collectConfigSourceTexts(app, () => {
        readFailed = true;
      })) {
        matcher.scanInto(searchable(text), hits);
        await maybeYield();
      }

      // A source we could not read might hold the only reference to any of these
      // candidates. The action-time re-check has always failed safe here; the scan
      // used to treat an unreadable note as empty and flag its attachments unused.
      if (readFailed) {
        for (const inp of pending) inp.mentionedInContent = true;
      }
      pending.forEach((inp, idx) => {
        if (hits.has(idx)) inp.mentionedInContent = true;
      });
    }
  }

  // --- Pass 4: run the pure detectors over each attachment.
  const issues: AttachmentIssue[] = [];
  const largeThreshold = kbToBytes(config.largeSizeThresholdKb);
  for (let i = 0; i < inputs.length; i++) {
    const stat = buildAttachmentStat(inputs[i]);

    if (enabled.has("unused")) {
      pushHit(issues, stat, "unused", config, unusedDetector(stat));
    }
    if (enabled.has("duplicate")) {
      pushHit(issues, stat, "duplicate", config, duplicateDetector(stat, hashToPaths), stat.hash);
    }
    if (enabled.has("large")) {
      pushHit(issues, stat, "large", config, largeDetector(stat, largeThreshold));
    }
    if (enabled.has("unnamed")) {
      pushHit(issues, stat, "unnamed", config, unnamedDetector(stat, config.junkNamePatterns));
    }
    if (enabled.has("misplaced")) {
      pushHit(issues, stat, "misplaced", config, misplacedDetector(stat, config.attachmentFolder));
    }
    if (isPro && enabled.has("custom") && config.customRules.length > 0) {
      for (const hit of runCustomRules(stat, config.customRules, now)) {
        issues.push({
          id: issueKey(stat.path, "custom", hit.ruleId),
          attachmentPath: stat.path,
          attachmentName: stat.name,
          issueType: "custom",
          severity: hit.severity,
          reason: hit.reason,
          sizeBytes: stat.size,
          sourceRuleId: hit.ruleId,
        });
      }
    }

    if ((i & 511) === 0) {
      onProgress?.(i, totalFiles, "analyze");
      await maybeYield();
    }
  }
  onProgress?.(totalFiles, totalFiles, "analyze");

  // --- Pass 5: broken attachment links. The inverse question — a pointer with no
  // file — answered from `unresolvedLinks`, which Obsidian maintains for free.
  // These issues describe a path that does NOT exist, so they carry `exists: false`.
  if (enabled.has("missing")) {
    const missing = findMissingAttachments(
      app.metadataCache.unresolvedLinks ?? {},
      (source) => isGeneratedReport(source, REPORT_FOLDER) || isExcluded(source, [], exclusion)
    );
    for (const entry of missing) {
      const { reason, details } = describeMissing(entry);
      issues.push({
        id: issueKey(entry.link, "missing"),
        attachmentPath: entry.link,
        attachmentName: entry.name,
        issueType: "missing",
        severity: config.severityWeights.missing,
        reason,
        details,
        sizeBytes: 0,
        exists: false,
        referencedBy: entry.referencedBy,
      });
    }
    await maybeYield();
  }

  const sorted = sortIssues(issues, config.sortMode);
  return { issues: sorted, totalFiles, reclaim: computeReclaim(sorted) };
}

/**
 * Which of the given attachments are currently mentioned anywhere in the vault's
 * source content (note bodies incl. frontmatter, canvas `file` values, text
 * attachments). This is the SECOND unused-safety signal, re-checkable at
 * action time — because a canvas/HTML/frontmatter reference added after the last
 * scan never appears in `resolvedLinks`, destructive actions call this to avoid
 * trashing a file that became referenced since the scan. If any source can't be
 * read, every candidate is reported as mentioned (fail safe: don't trash).
 *
 * `changedSources` makes the re-check INCREMENTAL: the scan that produced these
 * candidates already proved none of them was mentioned by any source as it stood
 * then, so only sources touched since can have introduced a new reference.
 *
 * It must be a set of paths collected from Obsidian's OWN vault events. An
 * earlier version of this used file mtimes instead, which is unsound: sync
 * clients (Obsidian Sync, Syncthing, Dropbox, iCloud, `rsync -a`, restore from
 * backup) write remote files with their ORIGINAL mtime, so a note that gained an
 * `<img src>` on another device lands with a timestamp older than the local scan
 * and would be skipped — and the file it references gets trashed. Vault events
 * fire regardless of what the timestamp says.
 *
 * Pass `undefined` to force a full scan. Callers MUST do that whenever they
 * cannot prove the set is complete.
 */
export async function findMentionedAttachments(
  app: App,
  candidates: { path: string; name: string }[],
  changedSources?: ReadonlySet<string>,
  changedSinceMs?: number
): Promise<Set<string>> {
  const mentioned = new Set<string>();
  if (candidates.length === 0) return mentioned;

  const matcher = new MentionMatcher();
  candidates.forEach((c, idx) => {
    for (const variant of fileNameVariants(c.name)) matcher.addPattern(variant, idx);
  });
  matcher.build();

  // Two independent "this file changed" signals, UNIONED. Neither alone is
  // sufficient:
  //  - Vault events catch a sync client writing a file with an OLD mtime from the
  //    originating device, which a timestamp comparison would miss entirely.
  //  - The mtime catches a write that never reached the event bus, such as
  //    another plugin using `vault.adapter.write()` directly.
  // A file only gets skipped when BOTH say it is untouched.
  const cutoff = changedSinceMs === undefined ? null : changedSinceMs - MTIME_SLACK_MS;
  const sources = app.vault
    .getFiles()
    .filter(
      (f) =>
        !isGeneratedReport(f.path, REPORT_FOLDER) &&
        isMentionSource(f.extension.toLowerCase()) &&
        (changedSources === undefined ||
          changedSources.has(f.path) ||
          (cutoff !== null && f.stat.mtime >= cutoff))
    );

  // This runs on the UI thread on every trash click, so yield like the scan does
  // rather than freezing Obsidian for the length of the pass.
  const yielder = makeYielder();
  let lastYield = performance.now();
  const maybeYield = async (): Promise<void> => {
    if (performance.now() - lastYield > 8) {
      await yielder.yield();
      lastYield = performance.now();
    }
  };

  try {
    const hits = new Set<number>();
    let readFailed = false;
    for (let i = 0; i < sources.length; i += READ_BATCH) {
      const batch = sources.slice(i, i + READ_BATCH);
      const texts = await Promise.all(
        batch.map((s) =>
          readSourceText(app, s).catch(() => {
            readFailed = true;
            return "";
          })
        )
      );
      for (const text of texts) {
        if (text) matcher.scanInto(searchable(text), hits);
        await maybeYield();
      }
    }
    // Config-dir sources (CSS snippets, plugin data) carry no mtime we can compare
    // against, so they are always re-read — there are only a handful of them.
    for (const text of await collectConfigSourceTexts(app, () => {
      readFailed = true;
    })) {
      matcher.scanInto(searchable(text), hits);
      await maybeYield();
    }

    // A source we couldn't read might contain the only reference — never trash then.
    if (readFailed) {
      for (const c of candidates) mentioned.add(c.path);
      return mentioned;
    }
    candidates.forEach((c, idx) => {
      if (hits.has(idx)) mentioned.add(c.path);
    });
    return mentioned;
  } finally {
    yielder.dispose();
  }
}

/**
 * Text from Obsidian's own config directory that can reference an attachment:
 * CSS snippets (`background-image: url(...)`) and plugin data files (banner
 * paths, custom icons, per-note image settings). `vault.getFiles()` never returns
 * anything under `.obsidian/`, so without this a snippet-referenced image reads as
 * unused and one click trashes it.
 *
 * Best-effort by design: this is coverage the plugin previously did not have at
 * all, so a config dir we cannot enumerate degrades to the old behaviour rather
 * than disabling unused detection outright. Individual read failures are folded
 * into `onReadFailure` so the caller can still fail safe.
 */
async function collectConfigSourceTexts(
  app: App,
  onReadFailure: () => void
): Promise<string[]> {
  const adapter = app.vault.adapter;
  const configDir = app.vault.configDir;
  const texts: string[] = [];
  if (!adapter || !configDir) return texts;

  const listFiles = async (dir: string): Promise<string[]> => {
    try {
      if (!(await adapter.exists(dir))) return [];
      return (await adapter.list(dir)).files;
    } catch {
      return []; // an unreadable directory is not evidence about any attachment
    }
  };

  const targets: string[] = [];
  // Snippets AND themes: a theme's CSS can reference a vault image by `url(...)`
  // just as a snippet can, which would leave that image looking unused.
  for (const dir of ["snippets", "themes"]) {
    for (const f of await listFiles(`${configDir}/${dir}`)) {
      if (f.toLowerCase().endsWith(".css")) targets.push(f);
    }
  }
  try {
    if (await adapter.exists(`${configDir}/themes`)) {
      for (const themeDir of (await adapter.list(`${configDir}/themes`)).folders) {
        targets.push(`${themeDir}/theme.css`);
      }
    }
  } catch {
    /* no themes readable — fall through */
  }
  try {
    if (await adapter.exists(`${configDir}/plugins`)) {
      // Skip OUR OWN data file. It records every path we touch — ignored keys,
      // excluded paths, and the cleanup journal — so reading it as a reference
      // source makes this plugin's own bookkeeping suppress its own detection.
      // A file restored from the trash was found "mentioned" by the journal
      // entry describing its removal, and could never be flagged unused again.
      // Same shape as the exported-reports bug: our output is not evidence about
      // the vault.
      const own = `${configDir}/plugins/${PRODUCT_ID}`;
      for (const dir of (await adapter.list(`${configDir}/plugins`)).folders) {
        if (dir === own || dir.endsWith(`/${PRODUCT_ID}`)) continue;
        targets.push(`${dir}/data.json`);
      }
    }
  } catch {
    /* no plugin data readable — fall through with whatever we have */
  }
  for (const name of ["appearance.json", "app.json"]) targets.push(`${configDir}/${name}`);

  for (const path of targets) {
    try {
      if (await adapter.exists(path)) texts.push(await adapter.read(path));
    } catch {
      // We KNOW this file exists and references may hide in it — fail safe.
      onReadFailure();
    }
  }
  return texts;
}

/** SHA-256 hex of a file's bytes, via the Web Crypto API (available at runtime). */
async function hashFile(app: App, file: TFile): Promise<string> {
  const buf = await app.vault.readBinary(file);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Read a source file's searchable text. Markdown/base/text attachments contribute
 * their raw content (frontmatter included). Canvas files contribute their embedded
 * `file` paths plus raw JSON. Notes also contribute their resolved frontmatter
 * link targets.
 */
async function readSourceText(app: App, file: TFile): Promise<string> {
  const ext = file.extension.toLowerCase();
  const raw = await app.vault.cachedRead(file);
  if (ext === "canvas") {
    return raw + "\n" + extractCanvasFilePaths(raw).join("\n");
  }
  const fmLinks = app.metadataCache.getFileCache(file)?.frontmatterLinks;
  if (fmLinks && fmLinks.length > 0) {
    return raw + "\n" + fmLinks.map((l) => l.link).join("\n");
  }
  return raw;
}

/**
 * A reusable macrotask yield via MessageChannel (no 4ms setTimeout clamp).
 * Returns the yield function plus a `dispose` that closes both ports — without it
 * every scan leaked a live channel and its message handler for the lifetime of
 * the process.
 */
function makeYielder(): { yield: () => Promise<void>; dispose: () => void } {
  const channel = new MessageChannel();
  let resolveCurrent: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const r = resolveCurrent;
    resolveCurrent = null;
    if (r) r();
  };
  return {
    yield: () =>
      new Promise<void>((resolve) => {
        resolveCurrent = resolve;
        channel.port2.postMessage(0);
      }),
    dispose: () => {
      // Resolve any pending waiter first, so an aborted scan can't hang forever.
      const r = resolveCurrent;
      resolveCurrent = null;
      if (r) r();
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** Thrown when a scan is aborted (plugin unload, or a newer scan superseding it). */
export class ScanAbortedError extends Error {
  constructor() {
    super("Attachment Audit: scan aborted");
    this.name = "ScanAbortedError";
  }
}

/**
 * Resolve the effective scan configuration from base settings, optionally
 * overridden by a saved profile (Pro). The attachment folder is normalized here
 * (leading/trailing slashes stripped) so the detector and the mover agree.
 */
export function resolveScanConfig(
  settings: AttachmentManagerSettings,
  profile?: ScanProfile
): ScanConfig {
  const cleanFolder = (f: string): string => f.trim().replace(/^\/+|\/+$/g, "");
  const base: ScanConfig = {
    enabledIssueTypes: settings.enabledIssueTypes ?? [...ISSUE_TYPES],
    largeSizeThresholdKb: settings.largeSizeThresholdKb,
    attachmentFolder: cleanFolder(settings.attachmentFolder),
    junkNamePatterns: settings.junkNamePatterns,
    duplicateMaxScanKb: settings.duplicateMaxScanKb,
    attachmentExtensions: settings.attachmentExtensions,
    includedFolders: [],
    excludedFolders: settings.excludedFolders,
    excludedPaths: settings.excludedPaths,
    severityWeights: settings.severityWeights,
    customRules: settings.customRules,
    sortMode: settings.sortMode ?? "severity",
  };
  if (!profile) return base;

  const ruleIds = new Set(profile.customRuleIds ?? []);
  return {
    ...base,
    enabledIssueTypes: profile.enabledIssueTypes ?? base.enabledIssueTypes,
    largeSizeThresholdKb: profile.largeSizeThresholdKb ?? base.largeSizeThresholdKb,
    attachmentFolder:
      profile.attachmentFolder != null ? cleanFolder(profile.attachmentFolder) : base.attachmentFolder,
    junkNamePatterns: profile.junkNamePatterns ?? base.junkNamePatterns,
    includedFolders: profile.includedFolders ?? [],
    excludedFolders: profile.excludedFolders?.length
      ? profile.excludedFolders
      : base.excludedFolders,
    customRules:
      profile.customRuleIds && profile.customRuleIds.length > 0
        ? base.customRules.filter((r) => ruleIds.has(r.id))
        : base.customRules,
    sortMode: profile.sortMode ?? base.sortMode,
  };
}

function pushHit(
  issues: AttachmentIssue[],
  stat: { path: string; name: string; size: number },
  type: IssueType,
  config: ScanConfig,
  hit: { reason: string; details?: string } | null,
  clusterId?: string
): void {
  if (!hit) return;
  issues.push({
    id: issueKey(stat.path, type),
    attachmentPath: stat.path,
    attachmentName: stat.name,
    issueType: type,
    severity: config.severityWeights[type],
    reason: hit.reason,
    details: hit.details,
    sizeBytes: stat.size,
    clusterId: type === "duplicate" ? clusterId : undefined,
  });
}

/**
 * Per-attachment inbound reference count from the resolved link graph. Links FROM
 * our own exported reports are ignored — a report lists each unused attachment as
 * a `[[wikilink]]`, which would otherwise resolve and permanently suppress that
 * file's "unused" flag on every subsequent scan.
 */
export function buildInboundCounts(app: App): Map<string, number> {
  const inbound = new Map<string, number>();
  const resolved = app.metadataCache.resolvedLinks;
  // `for...in` avoids materializing a key array per source — on a 30k-note vault
  // `Object.keys` allocated 30k throwaway arrays per call, and this runs once per
  // scan AND once per destructive action.
  for (const source in resolved) {
    // Discount only the reports we generated: each one wikilinks every unused
    // attachment it names, which would otherwise suppress that file's flag
    // forever. A note the user wrote in that folder is a genuine reference.
    if (isGeneratedReport(source, REPORT_FOLDER)) continue;
    const targets = resolved[source];
    for (const target in targets) {
      if (target === source) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + targets[target]);
    }
  }
  return inbound;
}

// Re-exported for callers that only need the attachment predicate.
export { extensionOf };
