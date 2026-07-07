import {
  App,
  FuzzySuggestModal,
  Notice,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type {
  AttachmentManagerSettings,
  AttachmentIssue,
  CustomRule,
  ScanProfile,
  SortMode,
} from "./types";
import { DEFAULT_SETTINGS, AttachmentManagerSettingTab } from "./settings";
import { AttachmentManagerView, VIEW_TYPE_ATTACHMENT_MANAGER } from "./ui/DashboardView";
import { ReviewQueueModal } from "./ui/ReviewQueueModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { scanVault, resolveScanConfig, buildInboundCounts } from "./core/scan/scanVault";
import { countByType } from "./core/rules/severity";
import { computeReclaim } from "./core/reclaim/reclaimableSpace";
import { buildMarkdownReport } from "./core/reports/markdownReport";
import { issueKey, issueKeyPath } from "./core/utils/ids";
import { formatBytes } from "./core/utils/sizes";
import { moveTargetPath, uniquePath, dirName, splitExtension, joinPath } from "./core/paths/pathRewrite";
import { LicenseManager } from "./core/license/LicenseManager";
import { requirePro } from "./ui/pro/ProGate";
import { PRODUCT_NAME, REPORT_FOLDER } from "./product";

/** Obsidian's internal command runner — not in the public typings. */
interface CommandsApi {
  executeCommandById: (id: string) => boolean;
  commandExists?: (id: string) => boolean;
}
type AppInternals = { commands?: CommandsApi };

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

  /** In-flight scan state, so the UI can show progress and block re-entry. */
  scanning = false;
  scanDone = 0;
  scanTotal = 0;

  /** O(1) mirrors of the ignored/reviewed key arrays (rebuilt on load/mutation). */
  private ignoredSet = new Set<string>();
  private reviewedSet = new Set<string>();

  private saveTimer: number | null = null;
  private settleTimer: number | null = null;
  /** Resolver for the in-flight settle wait, so a superseded wait can't hang. */
  private settleResolve: (() => void) | null = null;
  private refreshTimer: number | null = null;
  private rescanQueued = false;
  private queuedProfileId?: string;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.refreshLicense();

    this.registerView(VIEW_TYPE_ATTACHMENT_MANAGER, (leaf) => new AttachmentManagerView(leaf, this));

    this.addRibbonIcon("paperclip", "Open Attachment Manager", () => {
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

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.migratePath(oldPath, file.path)) this.scheduleSave();
        if (this.remapLastResult(oldPath, file.path)) this.scheduleRefresh();
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
    const data = (await this.loadData()) as Partial<AttachmentManagerSettings> | null;
    this.settings = Object.assign(safeClone(DEFAULT_SETTINGS), data);
    this.settings.severityWeights = {
      ...DEFAULT_SETTINGS.severityWeights,
      ...(this.settings.severityWeights ?? {}),
    };
    for (const key of [
      "junkNamePatterns",
      "attachmentExtensions",
      "excludedFolders",
      "excludedPaths",
      "ignoredIssueKeys",
      "reviewedIssueKeys",
      "savedProfiles",
      "customRules",
    ] as const) {
      if (!Array.isArray(this.settings[key])) {
        (this.settings as unknown as Record<string, unknown>)[key] = [];
      }
    }
    this.rebuildKeySets();
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
    this.flushPendingSave();
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.settleResolve) {
      this.settleResolve();
      this.settleResolve = null;
    }
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private rebuildKeySets(): void {
    this.ignoredSet = new Set(this.settings.ignoredIssueKeys);
    this.reviewedSet = new Set(this.settings.reviewedIssueKeys);
  }

  /** Drop ignore/reviewed keys only for attachments that no longer exist. */
  private pruneKeys(): void {
    const gone = (key: string): boolean =>
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
    this.refreshViews();

    try {
      const config = resolveScanConfig(this.settings, profile);
      const now = Date.now();
      const { issues, totalFiles } = await scanVault(
        this.app,
        config,
        this.isPro,
        now,
        (done, total) => {
          this.scanDone = done;
          this.scanTotal = total;
          for (const view of this.views()) view.showScanProgress(done, total);
        }
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

      const affected = new Set(outstanding.map((i) => i.attachmentPath)).size;
      const reclaimText = outstandingReclaim.unusedBytes > 0
        ? ` — ${formatBytes(outstandingReclaim.unusedBytes)} reclaimable`
        : "";
      new Notice(
        `${PRODUCT_NAME}: scanned ${totalFiles} ${plural(totalFiles, "attachment")} — ` +
          `${outstanding.length} ${plural(outstanding.length, "issue")} in ${affected} ${plural(affected, "file")}${reclaimText}.`
      );
    } catch (err) {
      console.error("Attachment Manager: scan failed", err);
      new Notice(`${PRODUCT_NAME}: scan failed. See the console for details.`);
    } finally {
      this.scanning = false;
      this.refreshViews();
      if (this.rescanQueued) {
        this.rescanQueued = false;
        const id = this.queuedProfileId;
        this.queuedProfileId = undefined;
        void this.runScan(id);
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
      const undo = f.createEl("a", { text: "Undo", cls: "attachment-manager-inline-link" });
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

  /** Notes that currently reference an attachment, from the resolved link graph. */
  referencingNotes(path: string): string[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    const sources: string[] = [];
    for (const source of Object.keys(resolved)) {
      if (source !== path && resolved[source][path]) sources.push(source);
    }
    return sources;
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
   * Trash attachments flagged unused. Re-validated per file immediately before the
   * trash: the file must still exist AND still have zero inbound references AND
   * still be in the scan's two-signal unused set. Trash obeys the user's "Deleted
   * files" setting.
   */
  async bulkTrashUnused(issues: AttachmentIssue[]): Promise<string[]> {
    const inbound = this.inboundMap();
    const unused = this.unusedPathSet();
    const trashed: string[] = [];
    let skipped = 0;
    let failed = 0;
    for (const path of unique(issues.map((i) => i.attachmentPath))) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      // Skip anything newly referenced or not confirmed unused by the last scan.
      if ((inbound.get(path) ?? 0) > 0 || !unused.has(path)) { skipped++; continue; }
      try {
        await this.app.fileManager.trashFile(file);
        trashed.push(path);
      } catch (err) {
        console.error(`Attachment Manager: could not trash ${path}`, err);
        failed++;
      }
    }
    this.reportBulk("Trashed", trashed.length, skipped, failed);
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
    const inbound = this.inboundMap();
    const unused = this.unusedPathSet();
    // Full cluster membership from the last scan, so "keep one" counts every copy.
    const membersByCluster = new Map<string, string[]>();
    for (const i of this.lastResult?.issues ?? []) {
      if (i.issueType === "duplicate" && i.clusterId) {
        const b = membersByCluster.get(i.clusterId) ?? [];
        if (!b.includes(i.attachmentPath)) b.push(i.attachmentPath);
        membersByCluster.set(i.clusterId, b);
      }
    }
    const selectedByCluster = new Map<string, string[]>();
    for (const i of selected) {
      if (i.issueType !== "duplicate" || !i.clusterId) continue;
      const b = selectedByCluster.get(i.clusterId) ?? [];
      if (!b.includes(i.attachmentPath)) b.push(i.attachmentPath);
      selectedByCluster.set(i.clusterId, b);
    }

    const toTrash: string[] = [];
    for (const [cid, sel] of selectedByCluster) {
      const members = membersByCluster.get(cid) ?? sel;
      // Eligible = selected copies that are two-signal unused AND still unreferenced.
      const eligible = sel.filter((p) => unused.has(p) && (inbound.get(p) ?? 0) <= 0);
      const survivors = members.filter((p) => !eligible.includes(p));
      let trashList = eligible;
      // Never remove the last surviving copy of the content.
      if (survivors.length === 0 && trashList.length > 0) trashList = trashList.slice(1);
      toTrash.push(...trashList);
    }

    if (toTrash.length === 0) {
      new Notice(
        `${PRODUCT_NAME}: no safely-removable duplicate copies (all are referenced or would be the last copy).`
      );
      return [];
    }

    const trashed: string[] = [];
    let skipped = 0;
    let failed = 0;
    for (const path of unique(toTrash)) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      if ((inbound.get(path) ?? 0) > 0 || !unused.has(path)) { skipped++; continue; }
      try {
        await this.app.fileManager.trashFile(file);
        trashed.push(path);
      } catch (err) {
        console.error(`Attachment Manager: could not trash ${path}`, err);
        failed++;
      }
    }
    this.reportBulk("Trashed", trashed.length, skipped, failed);
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
    let skipped = 0;
    let failed = 0;
    for (const path of unique(issues.map((i) => i.attachmentPath))) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) { skipped++; continue; }
      const desired = moveTargetPath(path, normFolder);
      if (desired === path) { skipped++; continue; } // already there
      const target = uniquePath(desired, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
      if (this.app.vault.getAbstractFileByPath(target)) { skipped++; continue; }
      try {
        await this.app.fileManager.renameFile(file, target);
        moved.push(target);
      } catch (err) {
        console.error(`Attachment Manager: could not move ${path}`, err);
        failed++;
      }
    }
    this.reportBulk("Moved", moved.length, skipped, failed);
    return moved;
  }

  /**
   * Rename a single attachment, keeping its extension and updating Markdown/
   * wikilink/embed and canvas references via `fileManager.renameFile`. (Raw HTML
   * `<img src>` and frontmatter plain-string paths are not rewritten by Obsidian.)
   * Returns the new path, or null if it couldn't rename.
   */
  async renameAttachment(path: string, newBasename: string): Promise<string | null> {
    const clean = newBasename.trim().replace(/[\\/:*?"<>|]/g, "");
    if (!clean) {
      new Notice(`${PRODUCT_NAME}: enter a valid name.`);
      return null;
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    const { ext } = splitExtension(path.slice(path.lastIndexOf("/") + 1));
    const fileName = ext ? `${clean}.${ext}` : clean;
    const desired = joinPath(dirName(path), fileName);
    if (desired === path) return path;
    const target = uniquePath(desired, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
    try {
      await this.app.fileManager.renameFile(file, target);
      new Notice(`${PRODUCT_NAME}: renamed to ${attachmentBaseName(target)}.`);
      return target;
    } catch (err) {
      console.error(`Attachment Manager: could not rename ${path}`, err);
      new Notice(`${PRODUCT_NAME}: rename failed. See the console.`);
      return null;
    }
  }

  /** Confirm-modal helper for destructive bulk actions (count + reclaimable size). */
  confirmDestructive(title: string, body: string, confirmText: string, onConfirm: () => void): void {
    new ConfirmModal(this.app, { title, body, confirmText, onConfirm }).open();
  }

  /**
   * Honest one-liner about where trashed files go, per the user's actual "Deleted
   * files" setting — so we never promise recoverability when it's set to permanent.
   */
  trashDestinationNote(): string {
    const opt = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(
      "trashOption"
    );
    if (opt === "none") return "Your 'Deleted files' setting is 'Permanently delete', so this cannot be undone.";
    if (opt === "local") return "They go to the vault's .trash folder and can be restored.";
    if (opt === "system") return "They go to your system trash and can be restored.";
    return "They go to Obsidian's configured trash (see the 'Deleted files' setting).";
  }

  private reportBulk(verb: string, done: number, skipped: number, failed: number): void {
    const parts = [`${verb.toLowerCase()} ${done} file(s)`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (failed > 0) parts.push(`${failed} failed — see console`);
    new Notice(`${PRODUCT_NAME}: ${parts.join(", ")}.`);
  }

  async settleCacheThenRescan(paths: string[]): Promise<void> {
    if (paths.length > 0) {
      // A rapid second call supersedes the first: cancel its timer AND resolve its
      // pending wait, so the earlier await unblocks instead of hanging forever.
      if (this.settleTimer !== null) {
        window.clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      if (this.settleResolve) {
        this.settleResolve();
        this.settleResolve = null;
      }
      await new Promise<void>((resolve) => {
        this.settleResolve = resolve;
        this.settleTimer = window.setTimeout(() => {
          this.settleTimer = null;
          this.settleResolve = null;
          resolve();
        }, 500);
      });
    }
    await this.runScan(this.lastResult?.profileId);
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

  // --- Pro: report export ---------------------------------------------------

  private exportReportCommand(): void {
    requirePro(this, "export", () => void this.exportReport());
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
      console.error("Attachment Manager: report export failed", err);
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
