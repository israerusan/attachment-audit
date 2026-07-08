import { normalizePath, type App, type TFile } from "obsidian";
import { ISSUE_TYPES } from "../../types";
import { REPORT_FOLDER } from "../../product";
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

/** Progress callback: how many attachments have been processed so far, of total. */
export type ScanProgress = (done: number, total: number) => void;

/** Files are read in bounded-parallel batches to overlap I/O without flooding it. */
const READ_BATCH = 32;

/** Text-like attachment extensions that may reference other attachments. */
const TEXT_ATTACHMENT_EXTS = new Set(["svg", "html", "htm", "css", "xml"]);

/** Extensions whose content is scanned as a reference SOURCE (never trashed). */
function isMentionSource(ext: string): boolean {
  return ext === "md" || ext === "canvas" || ext === "base" || TEXT_ATTACHMENT_EXTS.has(ext);
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
  onProgress?: ScanProgress
): Promise<ScanResult> {
  const yielder = makeYielder();
  await yielder(); // let the "Scanning…" state paint before the synchronous pre-work

  let lastYield = performance.now();
  const enabled = new Set<IssueType>(config.enabledIssueTypes);
  const maybeYield = async (): Promise<void> => {
    if (performance.now() - lastYield > 16) {
      await yielder();
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
  const inReports = (p: string): boolean => p === REPORT_FOLDER || p.startsWith(REPORT_FOLDER + "/");

  // --- Pass 1: ONE walk of the vault, partitioned into attachment candidates and
  // mention sources (notes/canvas/base/text-attachments whose content can
  // reference an attachment). A file can be both (e.g. an SVG).
  const candidates: TFile[] = [];
  const sources: TFile[] = [];
  const allFiles = app.vault.getFiles();
  for (let f = 0; f < allFiles.length; f++) {
    const file = allFiles[f];
    if ((f & 1023) === 0) await maybeYield();
    if (inReports(file.path)) continue; // never scan our own exported reports
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
  onProgress?.(0, totalFiles);

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
    const collide =
      cap <= 0
        ? []
        : sizeCollisionCandidates(
            inputs.map((inp, idx) => ({ path: inp.path, size: inp.size, idx }))
          ).filter((c) => c.size <= cap);
    const idxByPath = new Map(collide.map((c) => [c.path, c.idx]));
    const fileByPath = new Map(candidates.map((f) => [f.path, f]));

    for (let i = 0; i < collide.length; i += READ_BATCH) {
      const batch = collide.slice(i, i + READ_BATCH);
      const hashes = await Promise.all(
        batch.map((c) => {
          const file = fileByPath.get(c.path);
          return file ? hashFile(app, file).catch(() => null) : Promise.resolve(null);
        })
      );
      batch.forEach((c, j) => {
        const h = hashes[j];
        if (h) inputs[idxByPath.get(c.path) as number].hash = h;
      });
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

      const hits = new Set<number>();
      for (let i = 0; i < sources.length; i += READ_BATCH) {
        const batch = sources.slice(i, i + READ_BATCH);
        const texts = await Promise.all(batch.map((s) => readSourceText(app, s).catch(() => "")));
        for (const text of texts) {
          if (text) matcher.scanInto(text.normalize("NFC").toLowerCase(), hits);
          await maybeYield();
        }
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
      onProgress?.(i, totalFiles);
      await maybeYield();
    }
  }
  onProgress?.(totalFiles, totalFiles);

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
 */
export async function findMentionedAttachments(
  app: App,
  candidates: { path: string; name: string }[]
): Promise<Set<string>> {
  const mentioned = new Set<string>();
  if (candidates.length === 0) return mentioned;

  const matcher = new MentionMatcher();
  candidates.forEach((c, idx) => {
    for (const variant of fileNameVariants(c.name)) matcher.addPattern(variant, idx);
  });
  matcher.build();

  const inReports = (p: string): boolean => p === REPORT_FOLDER || p.startsWith(REPORT_FOLDER + "/");
  const sources = app.vault
    .getFiles()
    .filter((f) => !inReports(f.path) && isMentionSource(f.extension.toLowerCase()));

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
    for (const text of texts) if (text) matcher.scanInto(text.normalize("NFC").toLowerCase(), hits);
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

/** A reusable macrotask yield via MessageChannel (no 4ms setTimeout clamp). */
function makeYielder(): () => Promise<void> {
  const channel = new MessageChannel();
  let resolveCurrent: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const r = resolveCurrent;
    resolveCurrent = null;
    if (r) r();
  };
  return () =>
    new Promise<void>((resolve) => {
      resolveCurrent = resolve;
      channel.port2.postMessage(0);
    });
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
  const inReports = (p: string): boolean => p === REPORT_FOLDER || p.startsWith(REPORT_FOLDER + "/");
  for (const source of Object.keys(resolved)) {
    if (inReports(source)) continue;
    const targets = resolved[source];
    for (const target of Object.keys(targets)) {
      if (target === source) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + targets[target]);
    }
  }
  return inbound;
}

// Re-exported for callers that only need the attachment predicate.
export { extensionOf };
