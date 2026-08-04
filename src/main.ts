import {
  App,
  type EventRef,
  FuzzySuggestModal,
  Notice,
  Platform,
  type DataAdapter,
  Plugin,
  type TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type {
  AttachmentManagerSettings,
  AttachmentIssue,
  CustomRule,
  ScanProfile,
  SortMode,
  TrashDestination,
} from "./types";
import { DEFAULT_SETTINGS, AttachmentManagerSettingTab } from "./settings";
import { AttachmentManagerView, VIEW_TYPE_ATTACHMENT_MANAGER } from "./ui/DashboardView";
import { ReviewQueueModal } from "./ui/ReviewQueueModal";
import { openHistory } from "./ui/HistoryModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import {
  scanVault,
  resolveScanConfig,
  buildInboundCounts,
  findMentionedAttachments,
  isMentionSourcePath,
  ScanAbortedError,
  type ScanPhase,
} from "./core/scan/scanVault";
import { countByType } from "./core/rules/severity";
import { computeReclaim } from "./core/reclaim/reclaimableSpace";
import { selectDuplicateCopiesToTrash } from "./core/dedupe/duplicateTrashSelection";
import { buildMarkdownReport } from "./core/reports/markdownReport";
import { issueKey, issueKeyPath, issueKeyType, newId } from "./core/utils/ids";
import {
  appendBatch,
  replaceBatch,
  restorability,
  HEAD_HASH_BYTES,
  type CleanupOp,
  type JournalBatch,
  type JournalEntry,
} from "./core/journal/actionJournal";
import {
  couldBeTrashedAs,
  explainOutcome,
  selectTrashCandidate,
  type TrashCandidate,
} from "./core/journal/trashCandidates";
import { formatBytes } from "./core/utils/sizes";
import { moveTargetPath, uniquePath, dirName, splitExtension, joinPath } from "./core/paths/pathRewrite";
import { sanitizeBaseName } from "./core/naming/sanitizeName";
import { migrateRawSettings, normalizeSettings, SCHEMA_VERSION } from "./core/settings/normalize";
import { LicenseManager } from "./core/license/LicenseManager";
import { requirePro } from "./ui/pro/ProGate";
import { ProUpsellModal } from "./ui/pro/ProUpsellModal";
import { PRODUCT_NAME, REPORT_FOLDER } from "./product";

/** Obsidian's internal command runner — not in the public typings. */
interface CommandsApi {
  executeCommandById: (id: string) => boolean;
  commandExists?: (id: string) => boolean;
}
type AppInternals = { commands?: CommandsApi };

/** Obsidian's local trash, relative to the vault root. */
const TRASH_DIR = ".trash";

/** Where a restored file actually landed, or why it could not be put back. */
interface RestoreOutcome {
  /** The path the file now occupies — NOT necessarily its original one. */
  path: string | null;
  /** User-facing explanation when `path` is null. */
  reason?: string;
}

export interface ScanRun {
  issues: AttachmentIssue[];
  totalFiles: number;
  scannedAt: string;
  profileId?: string;
  sortMode: SortMode;
}

export default class AttachmentManagerPlugin extends Plugin {
  settings: AttachmentManagerSettings = safeClone(DEFAULT_SETTINGS);

  /** Pro entitlement, derived from the license key on load / change. */
  isPro = false;
  licenseEmail?: string;
  licenseError?: string;

  /** The most recent scan, held in memory for the dashboard and export. */
  lastResult: ScanRun | null = null;

  /**
   * Why the last scan failed, if it did. A dashboard whose job is deciding what to
   * delete must never present stale results as current, so the view surfaces this
   * instead of silently showing the previous run.
   */
  lastScanError: string | null = null;

  /** In-flight scan state, so the UI can show progress and block re-entry. */
  scanning = false;
  scanDone = 0;
  scanTotal = 0;
  /** Which stage the running scan is in, so the UI can name it. */
  scanPhase: ScanPhase = "collect";

  /** O(1) mirrors of the ignored/reviewed key arrays (rebuilt on load/mutation). */
  private ignoredSet = new Set<string>();
  private reviewedSet = new Set<string>();

  private saveTimer: number | null = null;
  private settleTimer: number | null = null;
  /** Resolver for the in-flight settle wait, so a superseded wait can't hang. */
  private settleResolve: (() => void) | null = null;
  /** One-shot metadata-cache "resolved" listener used while settling. */
  private settleEvtRef: EventRef | null = null;
  private refreshTimer: number | null = null;
  private rescanQueued = false;
  private queuedProfileId?: string;
  /** Set on unload so an in-flight scan stops instead of writing settings afterwards. */
  private unloaded = false;
  /** Cleared on finishSettle so the settle floor timer can't outlive its wait. */
  private settleFloorTimer: number | null = null;
  /**
   * Batch ids with a restore in flight. Obsidian shares one plugin instance
   * across windows, so two history modals can otherwise both start the same
   * restore and the second would pick a different trash candidate.
   */
  private restoringBatches = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.refreshLicense();

    this.registerView(VIEW_TYPE_ATTACHMENT_MANAGER, (leaf) => new AttachmentManagerView(leaf, this));

    this.addRibbonIcon("paperclip", "Open Attachment Audit", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "run-attachment-scan",
      name: "Run attachment scan",
      callback: () => void this.runScanAndReveal(),
    });
    this.addCommand({
      id: "open-dashboard",
      name: "Open dashboard",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "review-flagged-attachments",
      name: "Review flagged attachments",
      callback: () => this.openReviewQueue(),
    });
    this.addCommand({
      id: "run-saved-scan-profile",
      name: "Run saved scan profile",
      callback: () => this.runSavedProfileCommand(),
    });
    this.addCommand({
      id: "export-scan-report",
      name: "Export scan report",
      callback: () => this.exportReportCommand(),
    });
    this.addCommand({
      id: "open-cleanup-history",
      name: "Open cleanup history",
      callback: () => openHistory(this),
    });

    // Source-change tracking for the incremental live safety re-check. These
    // events are authoritative in a way file mtimes are not: a sync client writes
    // remote files with their ORIGINAL timestamp, so a note that gained an
    // `<img src>` on another device arrives looking older than the local scan —
    // but Obsidian still fires `modify` for it.
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.noteSourceChanged(file.path))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.noteSourceChanged(file.path))
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.migratePath(oldPath, file.path)) this.scheduleSave();
        const remapped = this.remapLastResult(oldPath, file.path);
        if (remapped) this.scheduleRefresh();
        this.noteSourceChanged(file.path);
        // ALWAYS force a full re-check after a rename. Two distinct holes close here:
        //
        //  - A FOLDER rename fires ONE event, not one per descendant, so every
        //    basis entry beneath it silently becomes a path that no longer exists
        //    and is never re-read. (`migratePath` and `remapLastResult` both handle
        //    that case with a `startsWith(oldPath + "/")` prefix test; this one
        //    can't, because the basis holds source paths, not attachment paths.)
        //  - A file rename can make a path "unused" that the mention pass never
        //    evaluated under that name: renaming `Pasted image 1.png` to `hero.png`
        //    inherits the old row's unused verdict, while a note may have
        //    referenced `hero.png` all along via a dangling HTML embed.
        //
        // Renames are rare and the cost is one full re-read on the next destructive
        // action, so this is not worth being clever about.
        this.invalidateMentionBasis();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.dropPath(file.path)) this.scheduleSave();
        if (this.dropLastResult(file.path)) this.scheduleRefresh();
      })
    );

    this.addSettingTab(new AttachmentManagerSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    // A truncated data.json (crash mid-write, sync conflict) must not stop the
    // plugin from loading — fall back to defaults rather than failing onload.
    let stored: unknown = null;
    try {
      stored = await this.loadData();
    } catch (err) {
      console.error("Attachment Audit: could not read settings, using defaults", err);
      new Notice(`${PRODUCT_NAME}: settings could not be read — defaults restored.`);
    }
    const raw = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
      string,
      unknown
    >;

    // Read the version from the RAW blob, BEFORE merging defaults: a merged object
    // would inherit the current version number and skip its own migration forever.
    const { raw: migrated, fromVersion } = migrateRawSettings(raw);
    if (fromVersion > SCHEMA_VERSION) {
      console.warn(
        `Attachment Audit: settings were written by a newer version (${fromVersion}); ` +
          "loading them conservatively."
      );
    }

    this.settings = normalizeSettings(
      Object.assign(safeClone(DEFAULT_SETTINGS), migrated),
      DEFAULT_SETTINGS
    );
    this.rebuildKeySets();
    // Persist the upgrade once, so the migration doesn't re-run on every load.
    if (fromVersion !== SCHEMA_VERSION && fromVersion <= SCHEMA_VERSION) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.materializeKeys();
    await this.saveData(this.settings);
  }

  private materializeKeys(): void {
    this.settings.ignoredIssueKeys = [...this.ignoredSet];
    this.settings.reviewedIssueKeys = [...this.reviewedSet];
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.materializeKeys();
      void this.saveData(this.settings);
    }, 400);
  }

  flushPendingSave(): void {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.materializeKeys();
    void this.saveData(this.settings);
  }

  onunload(): void {
    // Stop any in-flight scan FIRST: without this it keeps walking the vault and
    // then writes data.json for a plugin that no longer exists.
    this.unloaded = true;
    this.rescanQueued = false;
    this.flushPendingSave();
    this.finishSettle();
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private rebuildKeySets(): void {
    this.ignoredSet = new Set(this.settings.ignoredIssueKeys);
    this.reviewedSet = new Set(this.settings.reviewedIssueKeys);
  }

  /**
   * Drop ignore/reviewed keys only for attachments that no longer exist.
   *
   * "missing" issues are exempt: their path names a file that by definition does
   * NOT exist, so pruning them would silently forget the user's choice to ignore
   * a broken link on every single scan.
   */
  private pruneKeys(): void {
    const gone = (key: string): boolean =>
      issueKeyType(key) !== "missing" &&
      this.app.vault.getAbstractFileByPath(issueKeyPath(key)) === null;
    for (const k of [...this.ignoredSet]) if (gone(k)) this.ignoredSet.delete(k);
    for (const k of [...this.reviewedSet]) if (gone(k)) this.reviewedSet.delete(k);
  }

  refreshLicense(): void {
    const key = this.settings.licenseKey?.trim();
    if (!key) {
      this.isPro = false;
      this.licenseEmail = undefined;
      this.licenseError = undefined;
      this.settings.licenseStatus = "free";
      return;
    }
    const result = LicenseManager.verify(key);
    this.isPro = result.valid;
    this.licenseEmail = result.valid ? result.email : undefined;
    this.licenseError = result.valid ? undefined : result.error;
    this.settings.licenseStatus = result.valid ? "valid-pro" : "invalid";
  }

  // --- Views ----------------------------------------------------------------

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(VIEW_TYPE_ATTACHMENT_MANAGER)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_ATTACHMENT_MANAGER, active: true });
    }
    if (leaf) void workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    for (const view of this.views()) view.render();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews();
    }, 50);
  }

  private views(): AttachmentManagerView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_ATTACHMENT_MANAGER)
      .map((leaf) => leaf.view)
      .filter((v): v is AttachmentManagerView => v instanceof AttachmentManagerView);
  }

  // --- Scanning -------------------------------------------------------------

  async runScan(profileId?: string): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      this.queuedProfileId = profileId;
      return;
    }
    const profile = profileId
      ? this.settings.savedProfiles.find((p) => p.id === profileId)
      : undefined;
    if (profileId && !profile) {
      new Notice(`${PRODUCT_NAME}: saved profile not found.`);
      return;
    }

    this.scanning = true;
    this.scanDone = 0;
    this.scanTotal = 0;
    this.scanPhase = "collect";
    this.lastScanError = null;
    // Start collecting source changes from BEFORE the mention pass runs, so
    // anything edited while the scan is in flight is still re-checked afterwards.
    // Installed here (not on success) so in-flight edits land in it — but a scan
    // that does NOT complete must not leave this fresh set guarding the OLDER
    // results that are still on screen, so the catch below invalidates it.
    this.mentionBasis = new Set<string>();
    this.refreshViews();

    try {
      const config = resolveScanConfig(this.settings, profile);
      const now = Date.now();
      const { issues, totalFiles } = await scanVault(
        this.app,
        config,
        this.isPro,
        now,
        (done, total, phase) => {
          this.scanDone = done;
          this.scanTotal = total;
          this.scanPhase = phase;
          for (const view of this.views()) view.showScanProgress(done, total, phase);
        },
        () => this.unloaded
      );
      const scannedAt = new Date(now).toISOString();

      this.lastResult = { issues, totalFiles, scannedAt, profileId, sortMode: config.sortMode };
      const outstanding = issues.filter(
        (i) => !this.ignoredSet.has(i.id) && !this.reviewedSet.has(i.id)
      );
      const outstandingReclaim = computeReclaim(outstanding);
      this.settings.lastScanSummary = {
        scannedAt,
        totalFiles,
        totalIssues: outstanding.length,
        affectedAttachments: new Set(outstanding.map((i) => i.attachmentPath)).size,
        byType: countByType(outstanding),
        reclaimableBytes: outstandingReclaim.unusedBytes,
        profileId,
      };
      this.settings.onboardingDismissed = true;
      if (!profileId) this.pruneKeys();
      await this.saveSettings();

      if (config.enabledIssueTypes.length === 0) {
        new Notice(`${PRODUCT_NAME}: no detectors are enabled — turn some on in settings.`);
      } else {
        const affected = new Set(outstanding.map((i) => i.attachmentPath)).size;
        const reclaimText = outstandingReclaim.unusedBytes > 0
          ? ` — ${formatBytes(outstandingReclaim.unusedBytes)} reclaimable`
          : "";
        new Notice(
          `${PRODUCT_NAME}: scanned ${totalFiles} ${plural(totalFiles, "attachment")} — ` +
            `${outstanding.length} ${plural(outstanding.length, "issue")} in ${affected} ${plural(affected, "file")}${reclaimText}.`
        );
      }
    } catch (err) {
      // The results still on screen came from an EARLIER scan, but the basis was
      // reset for this one — leaving a near-empty set guarding stale results, so a
      // trash click would re-read almost nothing. Force a full re-check.
      this.invalidateMentionBasis();
      // An aborted scan is not a failure: the plugin unloaded mid-pass. Say
      // nothing, record nothing, and let the finally block skip the UI work.
      if (!(err instanceof ScanAbortedError)) {
        console.error("Attachment Audit: scan failed", err);
        this.lastScanError = err instanceof Error ? err.message : String(err);
        new Notice(`${PRODUCT_NAME}: scan failed. See the console for details.`);
      }
    } finally {
      this.scanning = false;
      // No `return` in a finally block — it would swallow any in-flight throw.
      if (!this.unloaded) {
        this.refreshViews();
        if (this.rescanQueued) {
          this.rescanQueued = false;
          const id = this.queuedProfileId;
          this.queuedProfileId = undefined;
          void this.runScan(id);
        }
      }
    }
  }

  private async runScanAndReveal(): Promise<void> {
    await this.activateView();
    await this.runScan();
  }

  /** Issues from the last scan minus the ones the user has ignored. */
  visibleIssues(): AttachmentIssue[] {
    if (!this.lastResult) return [];
    return this.lastResult.issues.filter((i) => !this.ignoredSet.has(i.id));
  }

  // --- Ignore / reviewed / exclude ------------------------------------------

  isIgnored(issue: AttachmentIssue): boolean {
    return this.ignoredSet.has(issue.id);
  }

  isReviewed(issue: AttachmentIssue): boolean {
    return this.reviewedSet.has(issue.id);
  }

  async setIgnored(issue: AttachmentIssue, ignored: boolean): Promise<void> {
    this.applyKey(this.ignoredSet, issue.id, ignored);
    this.scheduleSave();
  }

  async setReviewed(issue: AttachmentIssue, reviewed: boolean): Promise<void> {
    this.applyKey(this.reviewedSet, issue.id, reviewed);
    this.scheduleSave();
  }

  private applyKey(set: Set<string>, key: string, on: boolean): void {
    if (on) set.add(key);
    else set.delete(key);
  }

  /** Exclude an attachment's path from all future scans. */
  async excludeAttachment(path: string): Promise<void> {
    const wasNew = !this.settings.excludedPaths.includes(path);
    if (wasNew) this.settings.excludedPaths = [...this.settings.excludedPaths, path];
    if (this.lastResult) {
      this.lastResult.issues = this.lastResult.issues.filter((i) => i.attachmentPath !== path);
    }
    await this.saveSettings();
    const frag = createFragment((f) => {
      f.appendText(`Excluded "${path}" from future scans. `);
      const undo = f.createEl("button", { text: "Undo", cls: "attachment-audit-inline-link" });
      undo.addEventListener("click", () => void this.unexcludeAttachment(path));
    });
    new Notice(frag, 6000);
  }

  async unexcludeAttachment(path: string): Promise<void> {
    this.settings.excludedPaths = this.settings.excludedPaths.filter((p) => p !== path);
    await this.saveSettings();
    await this.runScan(this.lastResult?.profileId);
  }

  private migratePath(oldPath: string, newPath: string): boolean {
    const remap = (p: string): string =>
      p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
    const remapKey = (key: string): string => {
      const p = issueKeyPath(key);
      return remap(p) + key.slice(p.length);
    };
    const remapSet = (set: Set<string>): boolean => {
      let changed = false;
      const next = new Set<string>();
      for (const k of set) {
        const nk = remapKey(k);
        if (nk !== k) changed = true;
        next.add(nk);
      }
      if (changed) {
        set.clear();
        for (const k of next) set.add(k);
      }
      return changed;
    };

    let changed = remapSet(this.ignoredSet);
    changed = remapSet(this.reviewedSet) || changed;
    const nextEx = this.settings.excludedPaths.map(remap);
    if (nextEx.some((p, i) => p !== this.settings.excludedPaths[i])) {
      this.settings.excludedPaths = nextEx;
      changed = true;
    }
    return changed;
  }

  private remapLastResult(oldPath: string, newPath: string): boolean {
    if (!this.lastResult) return false;
    let changed = false;
    this.lastResult.issues = this.lastResult.issues.map((issue) => {
      const p = issue.attachmentPath;
      const np =
        p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
      if (np === p) return issue;
      changed = true;
      return {
        ...issue,
        attachmentPath: np,
        attachmentName: attachmentBaseName(np),
        id: issueKey(np, issue.issueType, issue.sourceRuleId),
      };
    });
    return changed;
  }

  private dropLastResult(path: string): boolean {
    if (!this.lastResult) return false;
    const before = this.lastResult.issues.length;
    this.lastResult.issues = this.lastResult.issues.filter(
      (i) => i.attachmentPath !== path && !i.attachmentPath.startsWith(path + "/")
    );
    return this.lastResult.issues.length !== before;
  }

  private dropPath(path: string): boolean {
    const affected = (p: string): boolean => p === path || p.startsWith(path + "/");
    let changed = false;
    for (const k of [...this.ignoredSet]) if (affected(issueKeyPath(k))) { this.ignoredSet.delete(k); changed = true; }
    for (const k of [...this.reviewedSet]) if (affected(issueKeyPath(k))) { this.reviewedSet.delete(k); changed = true; }
    const nextEx = this.settings.excludedPaths.filter((p) => !affected(p));
    if (nextEx.length !== this.settings.excludedPaths.length) {
      this.settings.excludedPaths = nextEx;
      changed = true;
    }
    return changed;
  }

  // --- Navigation -----------------------------------------------------------

  /** Open an attachment (image/PDF/etc.) in the main area. */
  async openAttachment(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  async revealAttachment(path: string): Promise<void> {
    await this.openAttachment(path);
    if (Platform.isMobile) return;
    try {
      const commands = (this.app as unknown as AppInternals).commands;
      if (!commands) return;
      const id = "file-explorer:reveal-active-file";
      const available = commands.commandExists ? commands.commandExists(id) : true;
      if (available) commands.executeCommandById(id);
    } catch {
      /* reveal is optional */
    }
  }

  // --- Review queue ---------------------------------------------------------

  openReviewQueue(issues?: AttachmentIssue[]): void {
    const list = issues ?? this.visibleIssues();
    if (list.length === 0) {
      new Notice(`${PRODUCT_NAME}: no flagged attachments. Run a scan first.`);
      return;
    }
    new ReviewQueueModal(this.app, this, list).open();
  }

  // --- Pro: profiles --------------------------------------------------------

  async saveProfile(profile: ScanProfile): Promise<void> {
    const idx = this.settings.savedProfiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) this.settings.savedProfiles[idx] = profile;
    else this.settings.savedProfiles.push(profile);
    await this.saveSettings();
  }

  async deleteProfile(id: string): Promise<void> {
    this.settings.savedProfiles = this.settings.savedProfiles.filter((p) => p.id !== id);
    await this.saveSettings();
  }

  runSavedProfileCommand(): void {
    requirePro(this, "profiles", () => {
      const profiles = this.settings.savedProfiles;
      if (profiles.length === 0) {
        new Notice(`${PRODUCT_NAME}: no saved profiles yet. Create one in settings.`);
        return;
      }
      const run = (id: string): void =>
        void (async () => {
          await this.activateView();
          await this.runScan(id);
        })();
      if (profiles.length === 1) {
        run(profiles[0].id);
        return;
      }
      new ProfileSuggestModal(this.app, profiles, (p) => run(p.id)).open();
    });
  }

  // --- Pro: custom rules ----------------------------------------------------

  async saveRule(rule: CustomRule): Promise<void> {
    const idx = this.settings.customRules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.settings.customRules[idx] = rule;
    else this.settings.customRules.push(rule);
    await this.saveSettings();
  }

  async deleteRule(id: string): Promise<void> {
    this.settings.customRules = this.settings.customRules.filter((r) => r.id !== id);
    await this.saveSettings();
  }

  // --- Pro: non-destructive bulk actions ------------------------------------

  async bulkIgnore(issues: AttachmentIssue[]): Promise<void> {
    for (const issue of issues) this.ignoredSet.add(issue.id);
    await this.saveSettings();
    this.refreshViews();
    new Notice(`${PRODUCT_NAME}: ignored ${issues.length} result(s).`);
  }

  async bulkMarkReviewed(issues: AttachmentIssue[]): Promise<void> {
    for (const issue of issues) this.reviewedSet.add(issue.id);
    await this.saveSettings();
    this.refreshViews();
    new Notice(`${PRODUCT_NAME}: marked ${issues.length} result(s) reviewed.`);
  }

  // --- Safe destructive actions (single-file is free; bulk is UI-gated to Pro) --

  /** Inbound reference count per path, built ONCE from resolvedLinks per action. */
  private inboundMap(): Map<string, number> {
    return buildInboundCounts(this.app);
  }

  /**
   * Resolve a folder by path, case-insensitively. `getAbstractFileByPath` is
   * case-sensitive, so a configured attachment folder of `assets` would not find
   * an actual `Assets/` — and the collision check below would then silently pass
   * for every target inside it, defeating its own purpose.
   */
  private folderCI(dir: string): TFolder | null {
    if (!dir) return this.app.vault.getRoot();
    const exact = this.app.vault.getAbstractFileByPath(dir);
    if (exact instanceof TFolder) return exact;
    let current: TFolder | null = this.app.vault.getRoot();
    for (const segment of dir.split("/")) {
      if (!segment || !current) return null;
      const lower = segment.toLowerCase();
      const next: TAbstractFile | undefined = current.children.find(
        (c) => c.name.toLowerCase() === lower
      );
      current = next instanceof TFolder ? next : null;
    }
    return current;
  }

  /**
   * Case-insensitive path existence check. `getAbstractFileByPath` is case-
   * sensitive, but macOS/Windows filesystems are not — so a move/rename target
   * that differs only in case from an existing sibling must count as a collision.
   *
   * `ignorePath` excludes the file being moved/renamed from the sibling scan.
   * Without it a case-only rename (`Photo.png` → `photo.png`) matches ITSELF,
   * reports a collision, and silently produces `photo (2).png` instead — which
   * broke case normalization for every file in the vault.
   */
  private pathExistsCI(target: string, ignorePath?: string): boolean {
    // The EXACT-path check runs first. Short-circuiting on the case-insensitive
    // comparison would hide a real, distinct file: on a case-sensitive filesystem
    // (Linux, Android) `img/Photo.png` and `img/photo.png` coexist, so renaming
    // the first to the second must still report a collision.
    if (target !== ignorePath && this.app.vault.getAbstractFileByPath(target)) return true;
    const ignoreLower = ignorePath?.toLowerCase();
    if (target.toLowerCase() === ignoreLower) return false;
    const slash = target.lastIndexOf("/");
    const dir = slash === -1 ? "" : target.slice(0, slash);
    const nameLower = target.slice(slash + 1).toLowerCase();
    const folder = this.folderCI(dir);
    if (!folder) return false;
    return folder.children.some(
      (c) => c.name.toLowerCase() === nameLower && c.path.toLowerCase() !== ignoreLower
    );
  }

  /**
   * Paths the last scan flagged "unused" — i.e. that passed the full two-signal
   * safety check (no resolved inbound link AND no filename mention in any note,
   * canvas, frontmatter, or text-attachment source). Only these are ever
   * trash-eligible; a copy referenced only via canvas/HTML/frontmatter is NOT
   * here, so it can never be trashed.
   */
  private unusedPathSet(): Set<string> {
    const set = new Set<string>();
    for (const i of this.lastResult?.issues ?? []) {
      if (i.issueType === "unused") set.add(i.attachmentPath);
    }
    return set;
  }

  /**
   * The set of source files that may have changed since the scan behind
   * `lastResult` — the basis for an incremental live re-check.
   *
   * Returns `undefined` (meaning "re-read everything") whenever the set cannot be
   * trusted: no scan yet, or something happened that could have made a path
   * "unused" without the mention pass ever having evaluated it. Being wrong here
   * deletes a file the user still references, so every uncertain case falls back
   * to the full scan.
   */
  private changedSourcesSince(): ReadonlySet<string> | undefined {
    if (!this.lastResult) return undefined;
    return this.mentionBasis ?? undefined;
  }

  /**
   * When the scan behind `lastResult` started, as a SECOND change signal unioned
   * with the event-derived set above. Vault events are authoritative for writes
   * that go through the `Vault` API (including sync), but a plugin writing via
   * `vault.adapter.write()` bypasses that emitter entirely — and such a write does
   * update the file's mtime. Neither signal alone covers both cases; a source is
   * only skipped when both say it is untouched.
   */
  private scanStartedMs(): number | undefined {
    const at = this.lastResult?.scannedAt;
    if (!at) return undefined;
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? undefined : ms;
  }

  /**
   * Paths of mention sources modified since the last scan started, or `null` when
   * the tracking is known to be incomplete and a full re-read is required.
   */
  private mentionBasis: Set<string> | null = null;

  /** Force the next live re-check to read every source. */
  private invalidateMentionBasis(): void {
    this.mentionBasis = null;
  }

  /** Record a source file whose content may now reference something new. */
  private noteSourceChanged(path: string): void {
    if (this.mentionBasis === null) return; // already doing a full re-read
    if (isMentionSourcePath(path)) this.mentionBasis.add(path);
  }

  /**
   * Trash attachments flagged unused. Re-validated per file immediately before the
   * trash: the file must still exist AND still have zero inbound references AND
   * still be in the scan's two-signal unused set. Trash obeys the user's "Deleted
   * files" setting.
   */
  async bulkTrashUnused(issues: AttachmentIssue[], single = false): Promise<string[]> {
    if (this.scanning) {
      new Notice(`${PRODUCT_NAME}: a scan is running — try again in a moment.`);
      return [];
    }
    const inbound = this.inboundMap();
    const unused = this.unusedPathSet();
    const bytesByPath = new Map(issues.map((i) => [i.attachmentPath, i.sizeBytes]));
    const nameByPath = new Map(issues.map((i) => [i.attachmentPath, i.attachmentName]));
    // Re-check the SECOND signal (content mention) live, so a canvas/HTML/
    // frontmatter reference added since the scan can't get a file trashed.
    const candidatePaths = unique(issues.map((i) => i.attachmentPath)).filter(
      (p) => this.app.vault.getFileByPath(p) !== null && (inbound.get(p) ?? 0) <= 0 && unused.has(p)
    );
    const mentioned = await findMentionedAttachments(
      this.app,
      candidatePaths.map((p) => ({ path: p, name: nameByPath.get(p) ?? attachmentBaseName(p) })),
      this.changedSourcesSince(),
      this.scanStartedMs()
    );
    const trashed: string[] = [];
    const journalEntries: JournalEntry[] = [];
    // Read ONCE, before anything is trashed: a user changing "Deleted files"
    // mid-batch must not leave earlier files recorded with the wrong destination.
    const destination = this.trashDestination();
    let skipped = 0;
    let failed = 0;
    for (const path of unique(issues.map((i) => i.attachmentPath))) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      // Skip anything newly referenced (by link OR content) or not confirmed unused.
      if ((inbound.get(path) ?? 0) > 0 || !unused.has(path) || mentioned.has(path)) { skipped++; continue; }
      try {
        // Size and mtime as they are NOW, not as the scan saw them. These are the
        // identity gate when finding the file again in `.trash`, and a file edited
        // between the scan and the trash would otherwise be unidentifiable.
        const sizeBytes = file.stat.size;
        const mtime = file.stat.mtime;
        // Read BEFORE the trash: afterwards the file is somewhere we would have
        // to guess at, which is the whole problem this hash exists to remove.
        const headHash = await this.hashFileHead(file);
        await this.app.fileManager.trashFile(file);
        trashed.push(path);
        journalEntries.push({ from: path, sizeBytes, mtime, headHash });
      } catch (err) {
        console.error(`Attachment Audit: could not trash ${path}`, err);
        failed++;
      }
    }
    const reclaimed = trashed.reduce((s, p) => s + (bytesByPath.get(p) ?? 0), 0);
    await this.recordBatch("trash", journalEntries, destination);
    this.reportBulk("Trashed", trashed.length, skipped, failed, reclaimed);
    await this.recordTrashOutcome(trashed.length, reclaimed, single);
    return trashed;
  }

  /**
   * Trash redundant duplicate copies safely. A copy is eligible ONLY if it is in
   * the scan's two-signal unused set (no inbound link AND no content mention of any
   * kind) — so a copy referenced by a canvas embed, HTML <img>, or frontmatter path
   * is never trashed, even though those references don't appear in resolvedLinks.
   * At least one copy of every cluster is always kept.
   */
  async bulkTrashDuplicateCopies(selected: AttachmentIssue[]): Promise<string[]> {
    if (this.scanning) {
      new Notice(`${PRODUCT_NAME}: a scan is running — try again in a moment.`);
      return [];
    }
    const inbound = this.inboundMap();
    const unused = this.unusedPathSet();
    const bytesByPath = new Map(selected.map((i) => [i.attachmentPath, i.sizeBytes]));
    const toTrash = selectDuplicateCopiesToTrash(
      selected,
      this.lastResult?.issues ?? [],
      unused,
      inbound,
      (p) => this.app.vault.getFileByPath(p) !== null
    );

    if (toTrash.length === 0) {
      new Notice(
        `${PRODUCT_NAME}: no safely-removable duplicate copies (all are referenced or would be the last copy).`
      );
      return [];
    }

    const nameByPath = new Map(selected.map((i) => [i.attachmentPath, i.attachmentName]));
    // Live second-signal re-check before trashing any copy.
    const mentioned = await findMentionedAttachments(
      this.app,
      unique(toTrash).map((p) => ({ path: p, name: nameByPath.get(p) ?? attachmentBaseName(p) })),
      this.changedSourcesSince(),
      this.scanStartedMs()
    );
    const trashed: string[] = [];
    const journalEntries: JournalEntry[] = [];
    const destination = this.trashDestination();
    let skipped = 0;
    let failed = 0;
    for (const path of unique(toTrash)) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      if ((inbound.get(path) ?? 0) > 0 || !unused.has(path) || mentioned.has(path)) { skipped++; continue; }
      try {
        const sizeBytes = file.stat.size;
        const mtime = file.stat.mtime;
        // Read BEFORE the trash: afterwards the file is somewhere we would have
        // to guess at, which is the whole problem this hash exists to remove.
        const headHash = await this.hashFileHead(file);
        await this.app.fileManager.trashFile(file);
        trashed.push(path);
        journalEntries.push({ from: path, sizeBytes, mtime, headHash });
      } catch (err) {
        console.error(`Attachment Audit: could not trash ${path}`, err);
        failed++;
      }
    }
    const reclaimed = trashed.reduce((s, p) => s + (bytesByPath.get(p) ?? 0), 0);
    await this.recordBatch("trash", journalEntries, destination);
    this.reportBulk("Trashed", trashed.length, skipped, failed, reclaimed);
    await this.recordTrashOutcome(trashed.length, reclaimed, false);
    return trashed;
  }

  /**
   * Move attachments into the configured attachment folder. Uses
   * `fileManager.renameFile`, which updates Markdown/wikilink/embed and canvas
   * references. (Raw HTML `<img src>` and frontmatter plain-string paths are not
   * rewritten by Obsidian — a documented limitation.) Collisions get a " (2)"
   * suffix; a file already in place is skipped.
   */
  async bulkMoveToAttachmentFolder(issues: AttachmentIssue[]): Promise<string[]> {
    if (this.scanning) {
      new Notice(`${PRODUCT_NAME}: a scan is running — try again in a moment.`);
      return [];
    }
    const folder = this.settings.attachmentFolder.trim();
    if (!folder) {
      new Notice(`${PRODUCT_NAME}: set an attachment folder in settings first.`);
      return [];
    }
    const normFolder = normalizePath(folder);
    if (!this.app.vault.getAbstractFileByPath(normFolder)) {
      try {
        await this.app.vault.createFolder(normFolder);
      } catch {
        /* may already exist from a concurrent op */
      }
    }
    const moved: string[] = [];
    // Both endpoints, so the move can be reversed. `moved` alone only carries the
    // destination, which is not enough to put anything back.
    const journalEntries: JournalEntry[] = [];
    const inSubfolder: string[] = [];
    let skipped = 0;
    let failed = 0;
    const folderPrefix = normFolder + "/";
    for (const path of unique(issues.map((i) => i.attachmentPath))) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      // A file already SOMEWHERE under the attachment folder is left alone.
      // `moveTargetPath` always targets `<folder>/<basename>`, so moving
      // `assets/2024/photo.png` would flatten it to `assets/photo.png` and destroy
      // the user's subfolder organisation — for a file the misplaced detector
      // never even flagged (it accepts any descendant).
      if (path.startsWith(folderPrefix)) {
        if (path.slice(folderPrefix.length).includes("/")) inSubfolder.push(path);
        skipped++;
        continue;
      }
      const desired = moveTargetPath(path, normFolder);
      if (desired === path) { skipped++; continue; } // already there
      const target = uniquePath(desired, (p) => this.pathExistsCI(p, path));
      if (this.pathExistsCI(target, path)) { skipped++; continue; }
      try {
        const sizeBytes = file.stat.size;
        const mtime = file.stat.mtime;
        await this.app.fileManager.renameFile(file, target);
        moved.push(target);
        journalEntries.push({ from: path, to: target, sizeBytes, mtime });
      } catch (err) {
        console.error(`Attachment Audit: could not move ${path}`, err);
        failed++;
      }
    }
    await this.recordBatch("move", journalEntries);
    this.reportBulk("Moved", moved.length, skipped, failed);
    if (inSubfolder.length > 0) {
      new Notice(
        `${PRODUCT_NAME}: left ${inSubfolder.length} file${inSubfolder.length === 1 ? "" : "s"} ` +
          `in ${inSubfolder.length === 1 ? "its" : "their"} subfolder under "${folder}" — ` +
          "moving would have flattened your folder structure."
      );
    }
    return moved;
  }

  /**
   * Rename a single attachment, keeping its extension and updating Markdown/
   * wikilink/embed and canvas references via `fileManager.renameFile`. (Raw HTML
   * `<img src>` and frontmatter plain-string paths are not rewritten by Obsidian.)
   * Returns the new path, or null if it couldn't rename.
   */
  async renameAttachment(path: string, newBasename: string): Promise<string | null> {
    if (this.scanning) {
      new Notice(`${PRODUCT_NAME}: a scan is running — try again in a moment.`);
      return null;
    }
    const { name: clean, reason } = sanitizeBaseName(newBasename);
    if (!clean) {
      new Notice(`${PRODUCT_NAME}: ${reason ?? "enter a valid name."}`);
      return null;
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    const { ext } = splitExtension(path.slice(path.lastIndexOf("/") + 1));
    const fileName = ext ? `${clean}.${ext}` : clean;
    const desired = joinPath(dirName(path), fileName);
    if (desired === path) return path;
    // Exclude the file being renamed from the collision scan, so a case-only
    // rename doesn't collide with itself and get a " (2)" suffix.
    const target = uniquePath(desired, (p) => this.pathExistsCI(p, path));
    // Never rename onto an existing file (case-insensitive; uniquePath can return a
    // colliding path only in the pathological exhaustion case).
    if (this.pathExistsCI(target, path)) {
      new Notice(`${PRODUCT_NAME}: a file named "${attachmentBaseName(target)}" already exists.`);
      return null;
    }
    try {
      const sizeBytes = file.stat.size;
      const mtime = file.stat.mtime;
      await this.app.fileManager.renameFile(file, target);
      await this.recordBatch("rename", [{ from: path, to: target, sizeBytes, mtime }]);
      new Notice(`${PRODUCT_NAME}: renamed to ${attachmentBaseName(target)}.`);
      return target;
    } catch (err) {
      console.error(`Attachment Audit: could not rename ${path}`, err);
      new Notice(`${PRODUCT_NAME}: rename failed. See the console.`);
      return null;
    }
  }

  // --- Cleanup history ------------------------------------------------------

  /**
   * Record one completed action. Called AFTER the mutation, with only the files
   * that actually changed, so the history can never claim something that didn't
   * happen. A `journalLimit` of 0 turns recording off entirely.
   */
  private async recordBatch(
    op: CleanupOp,
    entries: JournalEntry[],
    trashDestination?: TrashDestination
  ): Promise<void> {
    if (entries.length === 0 || this.settings.journalLimit <= 0) return;
    const batch: JournalBatch = {
      id: newId("batch"),
      at: new Date().toISOString(),
      op,
      trashDestination,
      entries,
    };
    this.settings.journal = appendBatch(this.settings.journal, batch, this.settings.journalLimit);
    await this.saveSettings();
  }

  /**
   * Put a recorded batch back. Returns what was restored and what could not be.
   *
   * Deliberately best-effort per file rather than all-or-nothing: a partial
   * restore beats refusing to restore anything because one file has since moved,
   * and the caller is told exactly which ones failed.
   */
  async restoreBatch(batchId: string): Promise<{ restored: string[]; failed: string[] }> {
    const batch = this.settings.journal.find((b) => b.id === batchId);
    const restored: string[] = [];
    const failed: string[] = [];
    if (!batch) return { restored, failed };

    // Same guard every other vault-mutating action carries: a restore racing a
    // scan would have its results immediately superseded by stale ones.
    if (this.scanning) {
      new Notice(`${PRODUCT_NAME}: a scan is running — try again in a moment.`);
      return { restored, failed };
    }
    // Obsidian shares one plugin instance across windows, so two open history
    // modals can both pass the restorability check before either writes
    // `revertedAt` — and the second pass would restore a DIFFERENT trash
    // candidate over the first one's work.
    if (this.restoringBatches.has(batchId)) {
      new Notice(`${PRODUCT_NAME}: that restore is already running.`);
      return { restored, failed };
    }

    const verdict = restorability(batch);
    if (!verdict.restorable) {
      new Notice(`${PRODUCT_NAME}: ${verdict.reason ?? "this cannot be restored."}`);
      return { restored, failed };
    }

    this.restoringBatches.add(batchId);
    const landedAt: string[] = [];
    const reasons: string[] = [];
    // Per-entry results, so re-running a partial restore does not search for —
    // or pull a second file out of the trash for — an entry already put back.
    const restoredTo = new Map<string, string>();
    let alreadyDone = 0;
    try {
      // Reverse order, so a batch that moved A onto B's old path undoes B first.
      for (const entry of [...batch.entries].reverse()) {
        if (entry.restoredTo) {
          alreadyDone++;
          continue;
        }
        try {
          const outcome =
            batch.op === "trash"
              ? await this.restoreFromLocalTrash(entry)
              : await this.reverseMove(entry);
          if (outcome.path) {
            restored.push(entry.from);
            landedAt.push(outcome.path);
            restoredTo.set(entry.from, outcome.path);
          } else {
            failed.push(entry.from);
            if (outcome.reason && !reasons.includes(outcome.reason)) reasons.push(outcome.reason);
          }
        } catch (err) {
          console.error(`Attachment Audit: could not restore ${entry.from}`, err);
          failed.push(entry.from);
        }
      }
    } finally {
      this.restoringBatches.delete(batchId);
    }

    // Persist per-entry outcomes, and retire the batch only when every entry has
    // been put back — across runs, not just this one. Marking it reverted after a
    // partial restore stripped the button and stranded the rest; NOT recording
    // the successes meant a re-run reported them as failures and searched the
    // trash for them again.
    if (restoredTo.size > 0 || alreadyDone > 0) {
      const complete = failed.length === 0;
      this.settings.journal = replaceBatch(this.settings.journal, batchId, (b) => ({
        ...b,
        entries: b.entries.map((e) =>
          restoredTo.has(e.from) ? { ...e, restoredTo: restoredTo.get(e.from) } : e
        ),
        revertedAt: complete ? new Date().toISOString() : b.revertedAt,
      }));
      await this.saveSettings();
    }

    // Report where files ACTUALLY landed. An occupied original path gets a unique
    // name, and saying "restored" while pointing at a path holding something else
    // would send the user to the wrong file.
    const renamed = landedAt.filter((p, i) => p !== restored[i]);
    const parts = [`restored ${restored.length} file${restored.length === 1 ? "" : "s"}`];
    if (alreadyDone > 0) parts.push(`${alreadyDone} were already back`);
    if (renamed.length > 0) {
      parts.push(
        `${renamed.length} could not keep ${renamed.length === 1 ? "its" : "their"} original name, so ` +
          `${renamed.length === 1 ? "it is" : "they are"} at ${renamed.slice(0, 2).join(", ")}`
      );
    }
    if (failed.length > 0) {
      const why = reasons.length > 0 ? ` (${reasons.join("; ")})` : " — see the console";
      parts.push(`${failed.length} could not be put back${why}`);
    }
    new Notice(`${PRODUCT_NAME}: ${parts.join(", ")}.`, failed.length > 0 ? 10000 : undefined);
    if (landedAt.length > 0) await this.settleCacheThenRescan(landedAt);
    else this.refreshViews();
    return { restored, failed };
  }

  /**
   * Reverse a move or rename by renaming the file back where it came from.
   *
   * Verifies identity by size first. The path alone is not proof: the user may
   * have deleted the moved file and dropped a DIFFERENT file with the same name
   * in its place, and relocating that one would be a silent data move.
   */
  private async reverseMove(entry: JournalEntry): Promise<RestoreOutcome> {
    if (!entry.to) return { path: null, reason: "the record is missing where the file went" };
    const file = this.app.vault.getFileByPath(entry.to);
    if (!file) return { path: null, reason: "the file is no longer where it was put" };
    if (file.stat.size !== entry.sizeBytes) {
      return { path: null, reason: "the file there has changed since, so it was left alone" };
    }
    // Its original home may be occupied now; never overwrite something to undo.
    const target = uniquePath(entry.from, (p) => this.pathExistsCI(p, entry.to));
    if (this.pathExistsCI(target, entry.to)) {
      return { path: null, reason: "no free name was available at the original location" };
    }
    await this.ensureParentFolder(target);
    await this.app.fileManager.renameFile(file, target);
    return { path: target };
  }

  /**
   * Move a file back out of the vault's local `.trash`.
   *
   * Obsidian does not report where it put the file and renames on collision, so
   * we search: exact filename first, then the numbered variants, preferring a
   * size match. Only ever reached when the batch recorded `local` — the system
   * recycle bin is not addressable from a plugin, and a permanent delete leaves
   * nothing to find.
   */
  private async restoreFromLocalTrash(entry: JournalEntry): Promise<RestoreOutcome> {
    const adapter = this.app.vault.adapter;
    if (!adapter) return { path: null, reason: "the vault storage is unavailable" };

    let listing: string[];
    try {
      if (!(await adapter.exists(TRASH_DIR))) {
        return { path: null, reason: "the vault's trash folder is gone" };
      }
      listing = await this.listTrashRecursive(adapter);
    } catch {
      return { path: null, reason: "the vault's trash could not be read" };
    }

    // Stat every name-plausible candidate, then hash the ones whose size matches
    // and let the pure selector decide. It identifies or refuses — it never picks
    // a "best guess", because a wrong choice writes a stranger's bytes to a path
    // the user trusts AND consumes the real file from the trash.
    const wantedName = attachmentBaseName(entry.from);
    const candidates: TrashCandidate[] = [];
    for (const path of listing) {
      if (!couldBeTrashedAs(attachmentBaseName(path), wantedName)) continue;
      try {
        const stat = await adapter.stat(path);
        if (!stat || stat.type !== "file") continue;
        // Hash only size-matching candidates: it is the decisive check, but it
        // reads bytes, so it is not worth paying for a file already excluded.
        const headHash =
          stat.size === entry.sizeBytes && entry.headHash !== undefined
            ? await this.hashHead(adapter, path)
            : undefined;
        candidates.push({ path, size: stat.size, mtime: stat.mtime, headHash });
      } catch {
        /* unreadable: cannot be identified, so it cannot be a match */
      }
    }

    const outcome = selectTrashCandidate(candidates, {
      from: entry.from,
      sizeBytes: entry.sizeBytes,
      mtime: entry.mtime,
      headHash: entry.headHash,
    });
    if (!outcome.found) return { path: null, reason: explainOutcome(outcome.reason) };

    const target = uniquePath(entry.from, (p) => this.pathExistsCI(p));
    if (this.pathExistsCI(target)) {
      return { path: null, reason: "no free name was available at the original location" };
    }
    await this.ensureParentFolder(target);
    await adapter.rename(outcome.found.path, target);
    return { path: target };
  }

  /**
   * Every file under `.trash`, at any depth.
   *
   * Obsidian's local trash layout is undocumented, and it could not be verified
   * here whether a trashed `assets/logo.png` lands at `.trash/logo.png` or
   * `.trash/assets/logo.png`. `adapter.list` is NOT recursive, so a flat listing
   * would silently find nothing for every attachment in a subfolder — the
   * feature would appear to work and never restore anything. Walking handles
   * both layouts without needing to know which one is real.
   */
  private async listTrashRecursive(
    adapter: DataAdapter,
    dir: string = TRASH_DIR,
    depth = 0
  ): Promise<string[]> {
    if (depth > 8) return []; // pathological nesting guard
    const out: string[] = [];
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await adapter.list(dir);
    } catch {
      return out;
    }
    out.push(...listing.files);
    for (const folder of listing.folders) {
      out.push(...(await this.listTrashRecursive(adapter, folder, depth + 1)));
    }
    return out;
  }

  /**
   * SHA-256 of a file's leading bytes — the identity check that does not depend
   * on anything undocumented. See {@link JournalEntry.headHash}.
   */
  private async hashHead(adapter: DataAdapter, path: string): Promise<string | undefined> {
    try {
      const buf = await adapter.readBinary(path);
      const head = buf.byteLength > HEAD_HASH_BYTES ? buf.slice(0, HEAD_HASH_BYTES) : buf;
      const digest = await crypto.subtle.digest("SHA-256", head);
      const bytes = new Uint8Array(digest);
      let hex = "";
      for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
      return hex;
    } catch {
      return undefined;
    }
  }

  /** Head hash of a vault file, for recording identity before a mutation. */
  private async hashFileHead(file: TFile): Promise<string | undefined> {
    return this.hashHead(this.app.vault.adapter, file.path);
  }

  /** Recreate the folder a restored file used to live in, if it has since gone. */
  private async ensureParentFolder(path: string): Promise<void> {
    const dir = dirName(path);
    if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      /* may already exist, or be created concurrently */
    }
  }

  async clearJournal(): Promise<void> {
    this.settings.journal = [];
    await this.saveSettings();
    this.refreshViews();
  }

  /**
   * Confirm-modal helper for destructive actions. `files` lists the exact paths
   * about to be touched — without it "Move 14 file(s) to trash" gives the user no
   * way to spot the one they didn't mean to select.
   */
  confirmDestructive(
    title: string,
    body: string,
    confirmText: string,
    onConfirm: () => void,
    files?: string[]
  ): void {
    new ConfirmModal(this.app, { title, body, confirmText, onConfirm, files }).open();
  }

  /**
   * The single source of truth for the move action's confirm copy. It used to be
   * written out twice — in the bulk bar and in the row menu — with different
   * wording, so the two surfaces described the same operation differently.
   */
  describeMoveAction(count: number): string {
    const folder = this.settings.attachmentFolder.trim();
    const what = count === 1 ? "this file" : `${count} selected files`;
    return (
      `Move ${what} into "${folder}"? ` +
      "Markdown, wikilink, and canvas links are updated; raw HTML <img src> and " +
      "frontmatter path strings are not. Files already in that folder — including " +
      "in its subfolders — are left where they are."
    );
  }

  /** Reset every open dashboard back to the unfiltered view. */
  clearDashboardFilter(): void {
    for (const view of this.views()) view.resetFilter();
  }

  /**
   * Honest one-liner about where trashed files go, per the user's actual "Deleted
   * files" setting — so we never promise recoverability when it's set to permanent.
   */
  /**
   * Where a trashed file will go, per the user's "Deleted files" setting. Only
   * `local` is reachable from a plugin, so this is what decides whether the
   * cleanup history can offer a restore.
   */
  trashDestination(): TrashDestination {
    const opt = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(
      "trashOption"
    );
    switch (opt) {
      case "local":
        return "local";
      case "system":
        return "system";
      case "none":
        return "permanent";
      default:
        return "unknown"; // older API, or a value we don't recognise
    }
  }

  trashDestinationNote(): string {
    switch (this.trashDestination()) {
      case "permanent":
        return "Your 'Deleted files' setting is 'Permanently delete', so this cannot be undone.";
      case "local":
        return "They go to the vault's .trash folder, and Attachment Audit can put them back.";
      case "system":
        return "They go to your system trash and can be restored from there.";
      default:
        // Don't promise recoverability we can't verify — point at the setting.
        return "They go to Obsidian's configured trash — check your 'Deleted files' setting, as it may not be reversible.";
    }
  }

  private reportBulk(verb: string, done: number, skipped: number, failed: number, bytes = 0): void {
    // Reinforce the reclaimed space on a successful trash — the product's payoff
    // moment. Other verbs keep the plain report.
    if (verb === "Trashed" && done > 0) {
      const extra: string[] = [];
      if (skipped > 0) extra.push(`${skipped} skipped`);
      if (failed > 0) extra.push(`${failed} failed — see console`);
      const tail = extra.length ? ` (${extra.join(", ")})` : "";
      const space = bytes > 0 ? `Reclaimed ${formatBytes(bytes)} — ` : "";
      new Notice(`${PRODUCT_NAME}: ♻ ${space}${done} file${done === 1 ? "" : "s"} moved to trash${tail}.`);
      return;
    }
    const parts = [`${verb.toLowerCase()} ${done} file(s)`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (failed > 0) parts.push(`${failed} failed — see console`);
    new Notice(`${PRODUCT_NAME}: ${parts.join(", ")}.`);
  }

  /**
   * Track reclaim progress and surface two well-timed, once-only, non-blocking
   * nudges: a bulk-Pro offer after the user has trashed several files one at a
   * time, and a review ask after they've reclaimed a meaningful amount.
   */
  private async recordTrashOutcome(count: number, bytes: number, single: boolean): Promise<void> {
    if (count <= 0) return;
    this.settings.reclaimedTotalBytes += bytes;
    if (single) this.settings.singleTrashCount += count;
    await this.saveSettings();

    // Behavioral bulk upsell: they're doing Pro's job by hand. Offer once.
    if (
      single &&
      !this.isPro &&
      !this.settings.proCtaDismissed &&
      this.settings.singleTrashCount >= 3 &&
      this.settings.singleTrashCount - count < 3
    ) {
      const frag = createFragment((f) => {
        f.appendText("You've trashed several files one at a time. ");
        // A <button> (not a bare <a>) so it's keyboard- and screen-reader-operable.
        const b = f.createEl("button", {
          text: "Clear every unused file in one click with Pro →",
          cls: "attachment-audit-inline-link",
        });
        b.addEventListener("click", () =>
          new ProUpsellModal(
            this.app,
            "bulk",
            "Pro clears every unused file — plus dedupe, move, and rename — in one click. $9 one-time, no subscription."
          ).open()
        );
      });
      new Notice(frag, 8000);
    }
  }

  /**
   * After trashing files, drop them from the in-memory results and refresh —
   * WITHOUT a full rescan. Trashing an unused file doesn't change any other file's
   * status, so a rescan would be a needless multi-second pass on a large vault
   * (the vault "delete" event also prunes keys). Used for the single-file trash
   * hot path the free tier encourages.
   */
  handleTrashed(paths: string[]): void {
    let changed = false;
    for (const p of paths) if (this.dropLastResult(p)) changed = true;
    if (changed) this.refreshViews();
  }

  async settleCacheThenRescan(paths: string[]): Promise<void> {
    if (paths.length > 0) {
      this.finishSettle(); // supersede any in-flight wait (resolves it, no hang)
      await new Promise<void>((resolve) => {
        this.settleResolve = resolve;
        // Rescan right after Obsidian finishes re-resolving links, with a short
        // floor (let the writes flush) and a ceiling (never hang the UI) — more
        // reliable than a blind fixed delay on large vaults.
        let floorPassed = false;
        this.settleFloorTimer = window.setTimeout(() => {
          this.settleFloorTimer = null;
          floorPassed = true;
        }, 300);
        this.settleEvtRef = this.app.metadataCache.on("resolved", () => {
          if (floorPassed) this.finishSettle();
        });
        this.settleTimer = window.setTimeout(() => this.finishSettle(), 2500);
      });
    }
    await this.runScan(this.lastResult?.profileId);
  }

  /** Resolve and tear down the in-flight settle wait (idempotent). */
  private finishSettle(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.settleFloorTimer !== null) {
      window.clearTimeout(this.settleFloorTimer);
      this.settleFloorTimer = null;
    }
    if (this.settleEvtRef) {
      this.app.metadataCache.offref(this.settleEvtRef);
      this.settleEvtRef = null;
    }
    const r = this.settleResolve;
    this.settleResolve = null;
    if (r) r();
  }

  queueSave(): void {
    this.scheduleSave();
  }

  async clearIgnored(): Promise<void> {
    this.ignoredSet.clear();
    await this.saveSettings();
    this.refreshViews();
  }

  ignoredCount(): number {
    return this.ignoredSet.size;
  }

  reviewedCount(): number {
    return this.reviewedSet.size;
  }

  // --- Pro: report export ---------------------------------------------------

  /**
   * Report export is FREE. It is non-destructive, it is the most shareable proof
   * that the plugin works, and paywalling it made the free tier feel deliberately
   * tedious rather than genuinely useful. Pro is for acting at scale, not for
   * looking at your own vault.
   */
  private exportReportCommand(): void {
    void this.exportReport();
  }

  async exportReport(issues?: AttachmentIssue[]): Promise<void> {
    if (!this.lastResult) {
      new Notice(`${PRODUCT_NAME}: run a scan before exporting a report.`);
      return;
    }
    const list = issues ?? this.visibleIssues().filter((i) => !this.isReviewed(i));
    const profile = this.lastResult.profileId
      ? this.settings.savedProfiles.find((p) => p.id === this.lastResult?.profileId)
      : undefined;

    const markdown = buildMarkdownReport({
      scannedAt: new Date(this.lastResult.scannedAt).toLocaleString(),
      profileName: profile?.name,
      totalFiles: this.lastResult.totalFiles,
      issues: list,
    });

    try {
      const folder = normalizePath(REPORT_FOLDER);
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const path = this.uniqueReportPath(folder);
      const file = await this.app.vault.create(path, markdown);
      await this.app.workspace.getLeaf(false).openFile(file);
      new Notice(`${PRODUCT_NAME}: report exported.`);
    } catch (err) {
      console.error("Attachment Audit: report export failed", err);
      new Notice(`${PRODUCT_NAME}: could not write the report. See the console for details.`);
    }
  }

  private uniqueReportPath(folder: string): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    let path = normalizePath(`${folder}/Report ${stamp}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/Report ${stamp} (${n}).md`);
      n++;
    }
    return path;
  }
}

/** Palette/dashboard picker for choosing which saved profile to run. */
class ProfileSuggestModal extends FuzzySuggestModal<ScanProfile> {
  constructor(
    app: App,
    private profiles: ScanProfile[],
    private onChoose: (profile: ScanProfile) => void
  ) {
    super(app);
    this.setPlaceholder("Run which scan profile?");
  }

  getItems(): ScanProfile[] {
    return this.profiles;
  }

  getItemText(profile: ScanProfile): string {
    return profile.name;
  }

  onChooseItem(profile: ScanProfile): void {
    this.onChoose(profile);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** Basename of a vault path, keeping the extension (attachment display name). */
function attachmentBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Deep clone with a JSON fallback for the oldest mobile webviews (no structuredClone). */
function safeClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
