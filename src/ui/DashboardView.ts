import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import type { IssueType, AttachmentIssue, SortMode } from "../types";
import { ISSUE_TYPE_LABELS, ISSUE_TYPES } from "../types";
import { countByType, sortIssues } from "../core/rules/severity";
import { computeReclaim } from "../core/reclaim/reclaimableSpace";
import { formatBytes } from "../core/utils/sizes";
import { renderResultsList } from "./ResultsList";
import { requirePro } from "./pro/ProGate";
import { PRO_PRICE_LABEL, PRO_TAGLINE, PURCHASE_URL } from "../product";

export const VIEW_TYPE_ATTACHMENT_MANAGER = "attachment-manager-dashboard";

type Filter = IssueType | "all";

const CHECK_BLURB =
  "Attachment Manager scans for unused files, duplicates, oversized files, junk names, and misplaced attachments — then helps you reclaim space safely.";

export class AttachmentManagerView extends ItemView {
  private filter: Filter = "all";
  private sortMode: SortMode = "severity";
  private bulkMode = false;
  private selected = new Set<string>();

  private metaEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private selCountEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private bulkActionButtons: HTMLButtonElement[] = [];
  private lastSyncedScanAt: string | null = null;
  private sortCacheMode: SortMode | null = null;
  private sortCacheSrc: AttachmentIssue[] | null = null;
  private sortCache: AttachmentIssue[] = [];

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  constructor(leaf: WorkspaceLeaf, private plugin: AttachmentManagerPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ATTACHMENT_MANAGER;
  }

  getDisplayText(): string {
    return "Attachment Manager";
  }

  getIcon(): string {
    return "paperclip";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  showScanProgress(done: number, total: number): void {
    if (this.summaryEl) {
      this.summaryEl.setText(total > 0 ? `${done} / ${total} attachments` : "");
    }
    if (this.progressEl) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      this.progressEl.setCssStyles({ width: `${pct}%` });
      this.progressEl.setAttribute("role", "progressbar");
      this.progressEl.setAttribute("aria-valuemin", "0");
      this.progressEl.setAttribute("aria-valuenow", String(done));
      this.progressEl.setAttribute("aria-valuemax", String(total));
    }
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("attachment-manager-view");
    this.metaEl = null;
    this.summaryEl = null;
    this.progressEl = null;
    this.selCountEl = null;
    this.resultsEl = null;

    this.renderHeader(root);

    if (this.plugin.scanning && !this.plugin.lastResult) {
      this.metaEl = root.createDiv({ cls: "attachment-manager-meta" });
      this.renderScanningMeta();
      return;
    }

    if (!this.plugin.lastResult) {
      if (!this.plugin.settings.onboardingDismissed) {
        this.renderOnboarding(root);
      } else {
        this.metaEl = root.createDiv({ cls: "attachment-manager-meta" });
        this.renderHydratedMeta(root);
        if (!this.plugin.isPro) this.renderProCta(root);
      }
      return;
    }

    const last = this.plugin.lastResult;
    if (last && last.scannedAt !== this.lastSyncedScanAt) {
      this.sortMode = last.sortMode;
      this.lastSyncedScanAt = last.scannedAt;
      this.sortCacheSrc = last.issues;
      this.sortCacheMode = last.sortMode;
      this.sortCache = last.issues;
    }

    // A rename between renders rebuilds issue ids; drop any selection that no
    // longer exists so the bulk bar's count and actions can't reference stale ids.
    if (this.selected.size > 0) {
      const validIds = new Set((this.plugin.lastResult?.issues ?? []).map((i) => i.id));
      for (const id of this.selected) if (!validIds.has(id)) this.selected.delete(id);
    }

    const issues = this.plugin.visibleIssues();
    const outstandingCounts = countByType(issues.filter((i) => !this.plugin.isReviewed(i)));
    if (this.filter !== "all" && (outstandingCounts[this.filter] ?? 0) === 0) {
      this.filter = "all";
    }

    this.metaEl = root.createDiv({ cls: "attachment-manager-meta" });
    this.renderMeta(issues);
    this.renderToolbar(root);
    if (this.bulkMode) this.renderBulkBar(root);

    if (issues.length > 0 || this.filter !== "all") {
      this.resultsEl = root.createDiv();
      renderResultsList(this.resultsEl, this.plugin, this.applyView(), {
        bulkMode: this.bulkMode,
        selected: this.selected,
        showBadge: this.filter === "all",
        onSelectionChange: () => this.updateSelCount(),
        onCountsChanged: () => this.refreshMeta(),
      });
    }

    if (!this.plugin.isPro) this.renderProCta(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "attachment-manager-header" });
    header.createEl("h2", { text: "Attachment Manager" });
    const btn = header.createEl("button", {
      text: this.plugin.scanning ? "Scanning…" : "Run scan",
      cls: "mod-cta",
    });
    btn.disabled = this.plugin.scanning;
    btn.addEventListener("click", () => void this.plugin.runScan());

    if (!this.plugin.isPro && this.plugin.settings.proCtaDismissed) {
      header.createEl("a", {
        text: "Upgrade to Pro",
        cls: "attachment-manager-header-upsell",
        href: PURCHASE_URL,
      });
    }

    const profiles = this.plugin.settings.savedProfiles;
    if (this.plugin.isPro && profiles.length > 0) {
      const select = header.createEl("select", { cls: "dropdown attachment-manager-profile-select" });
      select.createEl("option", { text: "Run a profile…", value: "" });
      for (const p of profiles) select.createEl("option", { text: p.name, value: p.id });
      const activeId = this.plugin.lastResult?.profileId;
      if (activeId && profiles.some((p) => p.id === activeId)) select.value = activeId;
      select.disabled = this.plugin.scanning;
      select.addEventListener("change", () => {
        if (select.value) void this.plugin.runScan(select.value);
      });
    }
  }

  private renderOnboarding(root: HTMLElement): void {
    const card = root.createDiv({ cls: "attachment-manager-onboarding" });
    card.createEl("h3", { text: "Reclaim space in your vault" });
    card.createDiv({ cls: "attachment-manager-onboarding-blurb", text: CHECK_BLURB });
    card.createDiv({
      cls: "attachment-manager-onboarding-hint",
      text: "Free to scan — and you can trash or move files one at a time at no cost. We show how much space you can reclaim before you touch anything.",
    });
    const btn = card.createEl("button", { text: "Run your first scan", cls: "mod-cta" });
    btn.addEventListener("click", () => void this.plugin.runScan());
  }

  private renderScanningMeta(): void {
    const host = this.metaEl;
    if (!host) return;
    host.empty();
    const stat = host.createDiv({ cls: "attachment-manager-stat" });
    stat.createSpan({ cls: "attachment-manager-stat-label", text: "Scanning your vault…" });
    this.summaryEl = host.createDiv({ cls: "attachment-manager-summary" });
    const track = host.createDiv({ cls: "attachment-manager-progress" });
    this.progressEl = track.createDiv({ cls: "attachment-manager-progress-bar" });
    this.showScanProgress(this.plugin.scanDone, this.plugin.scanTotal);
  }

  private renderHydratedMeta(root: HTMLElement): void {
    const host = this.metaEl;
    const summary = this.plugin.settings.lastScanSummary;
    if (!host || !summary) {
      this.renderOnboarding(root);
      return;
    }
    host.empty();
    const affected = summary.affectedAttachments ?? summary.totalIssues;
    const stat = host.createDiv({ cls: "attachment-manager-stat" });
    stat.createSpan({ cls: "attachment-manager-stat-num", text: String(affected) });
    stat.createSpan({
      cls: "attachment-manager-stat-label",
      text: affected === 1 ? "attachment needs attention" : "attachments need attention",
    });
    if (summary.reclaimableBytes > 0) {
      host.createDiv({
        cls: "attachment-manager-reclaim",
        text: `♻ ${formatBytes(summary.reclaimableBytes)} reclaimable`,
      });
    }
    host
      .createDiv({ cls: "attachment-manager-summary" })
      .setText(`Last scan ${relativeTime(summary.scannedAt)} · run a scan to review`);
    const tiles = host.createDiv({ cls: "attachment-manager-tiles" });
    for (const type of ISSUE_TYPES) {
      const count = summary.byType[type] ?? 0;
      if (count === 0) continue;
      const tile = tiles.createDiv({ cls: "attachment-manager-tile is-static" });
      tile.createDiv({ cls: "attachment-manager-tile-count", text: String(count) });
      tile.createDiv({ cls: "attachment-manager-tile-label", text: ISSUE_TYPE_LABELS[type] });
    }
  }

  private renderMeta(issues: AttachmentIssue[]): void {
    const host = this.metaEl;
    if (!host) return;
    host.empty();

    const outstanding = issues.filter((i) => !this.plugin.isReviewed(i));
    const affected = new Set(outstanding.map((i) => i.attachmentPath)).size;
    const reviewedCount = issues.length - outstanding.length;
    const reclaim = computeReclaim(outstanding);

    const stat = host.createDiv({ cls: "attachment-manager-stat" });
    stat.createSpan({ cls: "attachment-manager-stat-num", text: String(affected) });
    stat.createSpan({
      cls: "attachment-manager-stat-label",
      text:
        affected === 0
          ? issues.length === 0
            ? "your attachments are tidy"
            : "all reviewed — nicely done"
          : affected === 1
            ? "attachment needs attention"
            : "attachments need attention",
    });

    if (reclaim.unusedBytes > 0) {
      const dup =
        reclaim.duplicateExtraBytes > 0
          ? ` · ${formatBytes(reclaim.duplicateExtraBytes)} in duplicate copies (review)`
          : "";
      host.createDiv({
        cls: "attachment-manager-reclaim",
        text: `♻ ${formatBytes(reclaim.unusedBytes)} reclaimable now${dup}`,
      });
    } else if (reclaim.duplicateExtraBytes > 0) {
      // No safely-reclaimable unused bytes — lead with the duplicate figure so the
      // banner never shows a misleading "0 B reclaimable now".
      host.createDiv({
        cls: "attachment-manager-reclaim",
        text: `♻ ${formatBytes(reclaim.duplicateExtraBytes)} in duplicate copies (review)`,
      });
    }

    this.summaryEl = host.createDiv({ cls: "attachment-manager-summary" });
    const last = this.plugin.lastResult;
    if (this.plugin.scanning) {
      this.summaryEl.setText(
        this.plugin.scanTotal > 0
          ? `Scanning ${this.plugin.scanDone} / ${this.plugin.scanTotal}…`
          : "Scanning…"
      );
      const track = host.createDiv({ cls: "attachment-manager-progress" });
      this.progressEl = track.createDiv({ cls: "attachment-manager-progress-bar" });
      this.showScanProgress(this.plugin.scanDone, this.plugin.scanTotal);
    } else if (last) {
      const issueWord = issues.length === 1 ? "issue" : "issues";
      const reviewed = reviewedCount > 0 ? ` · ${reviewedCount} reviewed` : "";
      const filtered =
        this.filter !== "all" ? ` · showing ${ISSUE_TYPE_LABELS[this.filter]}` : "";
      const profile = last.profileId
        ? this.plugin.settings.savedProfiles.find((p) => p.id === last.profileId)
        : undefined;
      const via = profile ? ` · via ${profile.name}` : "";
      this.summaryEl.setText(
        `${issues.length} ${issueWord}${reviewed} · scanned ${relativeTime(last.scannedAt)}${via}${filtered}`
      );
    }

    this.renderTiles(host, outstanding);

    if (outstanding.length > 0) {
      host.createDiv({
        cls: "attachment-manager-legend",
        text: "Severity: H high · M medium · L low",
      });
    }
  }

  private renderTiles(host: HTMLElement, issues: AttachmentIssue[]): void {
    const counts = countByType(issues);
    const tiles = host.createDiv({ cls: "attachment-manager-tiles" });
    this.tile(tiles, "All", issues.length, this.filter === "all", () => {
      this.setFilter("all");
    });
    for (const type of ISSUE_TYPES) {
      if (counts[type] === 0) continue;
      this.tile(tiles, ISSUE_TYPE_LABELS[type], counts[type], this.filter === type, () => {
        this.setFilter(type);
      });
    }
  }

  private tile(
    host: HTMLElement,
    label: string,
    count: number,
    active: boolean,
    onClick: () => void
  ): void {
    const tile = host.createEl("button", { cls: "attachment-manager-tile" });
    if (active) tile.addClass("is-active");
    tile.createDiv({ cls: "attachment-manager-tile-count", text: String(count) });
    tile.createDiv({ cls: "attachment-manager-tile-label", text: label });
    tile.addEventListener("click", onClick);
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    this.selected.clear();
    this.render();
  }

  private refreshMeta(): void {
    if (this.metaEl) this.renderMeta(this.plugin.visibleIssues());
  }

  private updateSelCount(): void {
    if (this.selCountEl) this.selCountEl.setText(`${this.selected.size} selected`);
    this.updateBulkEnabled();
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "attachment-manager-toolbar" });

    const sort = bar.createEl("select", { cls: "dropdown" });
    for (const [value, text] of [
      ["severity", "Sort: severity"],
      ["size", "Sort: size"],
      ["name", "Sort: name"],
      ["path", "Sort: path"],
    ] as [SortMode, string][]) {
      const opt = sort.createEl("option", { text, value });
      if (value === this.sortMode) opt.selected = true;
    }
    sort.addEventListener("change", () => {
      this.sortMode = sort.value as SortMode;
      this.plugin.settings.sortMode = this.sortMode;
      this.plugin.queueSave();
      this.render();
    });

    const scoped = this.filter !== "all";
    const review = bar.createEl("button", {
      text: scoped ? `Review ${ISSUE_TYPE_LABELS[this.filter as IssueType]}` : "Review flagged",
    });
    review.addEventListener("click", () => this.plugin.openReviewQueue(this.applyView()));

    const bulk = bar.createEl("button", { text: this.bulkMode ? "Exit bulk" : "Bulk actions" });
    if (!this.bulkMode && !this.plugin.isPro) {
      bulk.createSpan({ cls: "attachment-manager-pro-pill", text: "Pro" });
    }
    bulk.addEventListener("click", () => {
      if (this.bulkMode) {
        this.bulkMode = false;
        this.selected.clear();
        this.render();
        return;
      }
      const outstanding = this.plugin.visibleIssues().filter((i) => !this.plugin.isReviewed(i));
      const r = computeReclaim(outstanding);
      const unusedCount = outstanding.filter((i) => i.issueType === "unused").length;
      const ctx =
        unusedCount > 0
          ? `Clear all ${unusedCount} unused file${unusedCount === 1 ? "" : "s"} (${formatBytes(r.unusedBytes)}) in one click — plus dedupe, move, and rename across many files at once.`
          : undefined;
      requirePro(
        this.plugin,
        "bulk",
        () => {
          this.bulkMode = true;
          this.render();
        },
        ctx
      );
    });
  }

  private renderBulkBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "attachment-manager-bulk-bar" });
    this.selCountEl = bar.createSpan({ text: `${this.selected.size} selected` });
    this.bulkActionButtons = [];

    const shown = this.applyView();
    const startAllSelected = shown.length > 0 && shown.every((i) => this.selected.has(i.id));
    const selectAll = bar.createEl("button", {
      text: startAllSelected ? "Select none" : "Select all",
    });
    selectAll.addEventListener("click", () => {
      const nowAll = shown.length > 0 && shown.every((i) => this.selected.has(i.id));
      if (nowAll) shown.forEach((i) => this.selected.delete(i.id));
      else shown.forEach((i) => this.selected.add(i.id));
      if (this.resultsEl) {
        this.resultsEl.querySelectorAll("input.attachment-manager-check").forEach((el) => {
          (el as HTMLInputElement).checked = !nowAll;
        });
      }
      selectAll.setText(nowAll ? "Select all" : "Select none");
      this.updateSelCount();
    });

    const selectedIssues = (): AttachmentIssue[] =>
      this.applyView().filter((i) => this.selected.has(i.id));

    this.bulkButton(bar, "Ignore", () =>
      void this.plugin.bulkIgnore(selectedIssues()).then(() => this.afterBulk())
    );
    this.bulkButton(bar, "Mark reviewed", () =>
      void this.plugin.bulkMarkReviewed(selectedIssues()).then(() => this.afterBulk())
    );

    this.bulkButton(bar, "Trash unused", () => {
      const unused = selectedIssues().filter((i) => i.issueType === "unused");
      if (unused.length === 0) {
        new Notice("Attachment Manager: none of the selected items are unused.");
        return;
      }
      const bytes = computeReclaim(unused).unusedBytes;
      this.plugin.confirmDestructive(
        "Trash unused attachments",
        `Move ${unused.length} unused file(s) to trash, freeing ${formatBytes(bytes)}? ` +
          this.plugin.trashDestinationNote(),
        "Trash files",
        () => void this.plugin.bulkTrashUnused(unused).then((c) => this.afterBulkMutate(c))
      );
    });
    this.bulkButton(bar, "Trash duplicate copies", () => {
      const dups = selectedIssues().filter((i) => i.issueType === "duplicate");
      if (dups.length === 0) {
        new Notice("Attachment Manager: none of the selected items are duplicates.");
        return;
      }
      this.plugin.confirmDestructive(
        "Trash duplicate copies",
        `Trash redundant unused copies among ${dups.length} selected duplicate(s)? ` +
          "At least one copy of each file is always kept, and any referenced copy is never touched. " +
          this.plugin.trashDestinationNote(),
        "Trash copies",
        () => void this.plugin.bulkTrashDuplicateCopies(dups).then((c) => this.afterBulkMutate(c))
      );
    });
    this.bulkButton(bar, "Move to folder", () => {
      const sel = selectedIssues();
      if (sel.length === 0) return;
      const folder = this.plugin.settings.attachmentFolder.trim();
      if (!folder) {
        new Notice("Attachment Manager: set an attachment folder in settings first.");
        return;
      }
      this.plugin.confirmDestructive(
        "Move to attachment folder",
        `Move ${sel.length} selected file(s) into "${folder}"? Links in notes are updated; ` +
          "files already there are skipped.",
        "Move files",
        () => void this.plugin.bulkMoveToAttachmentFolder(sel).then((c) => this.afterBulkMutate(c))
      );
    });
    this.bulkButton(bar, "Export selected", () => void this.plugin.exportReport(selectedIssues()));
    this.updateBulkEnabled();
  }

  private bulkButton(bar: HTMLElement, label: string, onClick: () => void): void {
    const btn = bar.createEl("button", { text: label });
    btn.addEventListener("click", onClick);
    this.bulkActionButtons.push(btn);
  }

  private updateBulkEnabled(): void {
    const enabled = this.selected.size > 0;
    for (const btn of this.bulkActionButtons) btn.disabled = !enabled;
  }

  private afterBulk(): void {
    this.selected.clear();
    this.render();
  }

  private afterBulkMutate(changed: string[]): void {
    this.selected.clear();
    this.bulkMode = false;
    if (changed.length === 0) {
      this.render();
      return;
    }
    void this.plugin.settleCacheThenRescan(changed);
  }

  private renderProCta(root: HTMLElement): void {
    if (this.plugin.settings.proCtaDismissed) return;
    const card = root.createDiv({ cls: "attachment-manager-pro-cta" });
    const dismiss = card.createEl("button", { cls: "attachment-manager-cta-dismiss", text: "×" });
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", () => {
      this.plugin.settings.proCtaDismissed = true;
      this.plugin.queueSave();
      this.render();
    });

    // Quantify the pitch with what THIS vault can reclaim — far more motivating
    // than a generic feature list. Fall back to the generic copy when clean.
    const outstanding = this.plugin.visibleIssues().filter((i) => !this.plugin.isReviewed(i));
    const reclaim = computeReclaim(outstanding);
    const unusedCount = outstanding.filter((i) => i.issueType === "unused").length;
    if (unusedCount > 0 && reclaim.unusedBytes > 0) {
      card.createEl("strong", { text: `Reclaim ${formatBytes(reclaim.unusedBytes)} in one click` });
      card.createDiv({
        text:
          `${unusedCount} unused file${unusedCount === 1 ? "" : "s"} to clear. Trashing them one at a time is slow — ` +
          `Pro clears them all (plus dedupe, move, and rename) in a single action. ${PRO_PRICE_LABEL}, no subscription.`,
      });
    } else {
      card.createEl("strong", { text: `Attachment Manager Pro — ${PRO_PRICE_LABEL}` });
      card.createDiv({ text: PRO_TAGLINE });
    }
    card.createEl("a", {
      text: `Get Pro — ${PRO_PRICE_LABEL}`,
      cls: "attachment-manager-cta-link",
      href: PURCHASE_URL,
    });
  }

  private sortedIssues(): AttachmentIssue[] {
    const src = this.plugin.lastResult?.issues ?? null;
    if (this.sortCacheSrc !== src || this.sortCacheMode !== this.sortMode) {
      this.sortCache = sortIssues(src ?? [], this.sortMode);
      this.sortCacheSrc = src;
      this.sortCacheMode = this.sortMode;
    }
    return this.sortCache;
  }

  private applyView(): AttachmentIssue[] {
    return this.sortedIssues().filter(
      (i) =>
        !this.plugin.isIgnored(i) &&
        !this.plugin.isReviewed(i) &&
        (this.filter === "all" || i.issueType === this.filter)
    );
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
