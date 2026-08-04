import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import type { IssueType, AttachmentIssue, SortMode } from "../types";
import { ISSUE_TYPE_LABELS, ISSUE_TYPES } from "../types";
import { SCAN_PHASE_LABELS, type ScanPhase } from "../core/scan/scanVault";
import { countByType, sortIssues } from "../core/rules/severity";
import { computeReclaim } from "../core/reclaim/reclaimableSpace";
import { formatBytes } from "../core/utils/sizes";
import { renderResultsList } from "./ResultsList";
import { openHistory } from "./HistoryModal";
import { restorability } from "../core/journal/actionJournal";
import { requirePro } from "./pro/ProGate";
import { PRODUCT_NAME, PRO_PRICE_LABEL, PRO_TAGLINE, PURCHASE_URL } from "../product";

export const VIEW_TYPE_ATTACHMENT_MANAGER = "attachment-audit-dashboard";

type Filter = IssueType | "all";

/**
 * Onboarding promises, as three scannable claims rather than one 45-word
 * sentence. Same information, a third of the height in a ~300px pane — and the
 * safety claim the README sells is now the first thing you read.
 */
const ONBOARDING_POINTS: [icon: string, text: string][] = [
  ["shield-check", "Cross-checks canvas, frontmatter, HTML and CSS before calling anything unused."],
  ["recycle", "Shows exactly how much space you can reclaim before you touch a file."],
  ["undo-2", "Nothing is hard-deleted, and moves and renames keep your links intact."],
];

export class AttachmentManagerView extends ItemView {
  private filter: Filter = "all";
  private sortMode: SortMode = "severity";
  private bulkMode = false;
  private selected = new Set<string>();

  private metaEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressTrackEl: HTMLElement | null = null;
  private selCountEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private selectAllBtn: HTMLButtonElement | null = null;
  private bulkActionButtons: HTMLButtonElement[] = [];
  private lastSyncedScanAt: string | null = null;
  private sortCacheMode: SortMode | null = null;
  private sortCacheSrc: AttachmentIssue[] | null = null;
  private sortCache: AttachmentIssue[] = [];

  /**
   * Memoized result of {@link applyView}. A single render used to call it up to
   * four times and a single row click up to three, each one re-filtering the whole
   * issue list and allocating a fresh array — on a vault with tens of thousands of
   * issues that is measurable jank per checkbox toggle. Invalidated by
   * {@link invalidateView} whenever the inputs change.
   */
  private viewCache: AttachmentIssue[] | null = null;
  private viewCacheKey = "";

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
    return "Attachment Audit";
  }

  getIcon(): string {
    return "paperclip";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  showScanProgress(done: number, total: number, phase: ScanPhase): void {
    if (this.summaryEl) {
      const label = SCAN_PHASE_LABELS[phase];
      this.summaryEl.setText(total > 0 ? `${label} — ${done} / ${total}` : `${label}…`);
    }
    if (this.progressTrackEl) {
      // The role belongs on the TRACK; the fill is a presentational child.
      this.progressTrackEl.setAttribute("role", "progressbar");
      this.progressTrackEl.setAttribute("aria-label", "Scan progress");
      this.progressTrackEl.setAttribute("aria-valuemin", "0");
      this.progressTrackEl.setAttribute("aria-valuenow", String(done));
      this.progressTrackEl.setAttribute("aria-valuemax", String(total));
    }
    if (this.progressEl) {
      // Before the total is known there is nothing honest to show as a
      // percentage — an indeterminate bar reads as "working", a 0% bar as "hung".
      if (total <= 0) {
        this.progressEl.addClass("is-indeterminate");
        this.progressEl.setCssStyles({ width: "" });
        return;
      }
      this.progressEl.removeClass("is-indeterminate");
      const pct = Math.round((done / total) * 100);
      this.progressEl.setCssStyles({ width: `${pct}%` });
    }
  }

  render(): void {
    // Belt and braces: the cache key tracks filter/sort/counts, but a full render
    // is rare and cheap enough that dropping the memo here removes any chance of
    // showing a row the user just acted on.
    this.invalidateView();
    const root = this.contentEl;
    root.empty();
    root.addClass("attachment-audit-view");
    this.metaEl = null;
    this.summaryEl = null;
    this.progressEl = null;
    this.progressTrackEl = null;
    this.selCountEl = null;
    this.resultsEl = null;
    this.selectAllBtn = null;
    // Also drop the button refs: leaving them would have updateBulkEnabled()
    // mutating detached nodes after bulk mode is exited.
    this.bulkActionButtons = [];

    this.renderHeader(root);

    if (this.plugin.scanning && !this.plugin.lastResult) {
      this.metaEl = root.createDiv({ cls: "attachment-audit-meta" });
      this.renderScanningMeta();
      return;
    }

    if (this.plugin.lastScanError && !this.plugin.scanning) this.renderScanError(root);

    if (!this.plugin.lastResult) {
      if (!this.plugin.settings.onboardingDismissed && !this.plugin.lastScanError) {
        this.renderOnboarding(root);
      } else {
        this.metaEl = root.createDiv({ cls: "attachment-audit-meta" });
        this.renderHydratedMeta(root);
        this.renderHistoryLink(root);
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

    this.metaEl = root.createDiv({ cls: "attachment-audit-meta" });
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
        onCountsChanged: () => this.handleRowMutation(),
      });
    }

    this.renderHistoryLink(root);
    if (!this.plugin.isPro) this.renderProCta(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "attachment-audit-header" });
    // No <h2> here on purpose: the pane's tab already shows getDisplayText(), and
    // no native Obsidian sidebar (Backlinks, Outline, Tags) repeats its own title
    // in the body. Repeating it cost ~34px of a ~300px-wide pane and read as
    // non-native.
    const btn = header.createEl("button", {
      text: this.plugin.scanning ? "Scanning…" : "Run scan",
      cls: "mod-cta",
    });
    btn.disabled = this.plugin.scanning;
    btn.addEventListener("click", () => void this.plugin.runScan());

    if (!this.plugin.isPro && this.plugin.settings.proCtaDismissed) {
      header.createEl("a", {
        text: "Upgrade to Pro",
        cls: "attachment-audit-header-upsell",
        href: PURCHASE_URL,
      });
    }

    const profiles = this.plugin.settings.savedProfiles;
    if (this.plugin.isPro && profiles.length > 0) {
      const select = header.createEl("select", { cls: "dropdown attachment-audit-profile-select" });
      select.setAttribute("aria-label", "Run a saved scan profile");
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
    const card = root.createDiv({ cls: "attachment-audit-onboarding" });
    card.createEl("h3", { text: "Reclaim space in your vault" });
    const points = card.createDiv({ cls: "attachment-audit-onboarding-points" });
    for (const [icon, text] of ONBOARDING_POINTS) {
      const point = points.createDiv({ cls: "attachment-audit-onboarding-point" });
      setIcon(point.createSpan({ cls: "attachment-audit-onboarding-icon" }), icon);
      point.createSpan({ text });
    }
    card.createDiv({
      cls: "attachment-audit-onboarding-hint",
      text: "Scanning is free, and so is cleaning up one file at a time.",
    });
    const btn = card.createEl("button", { text: "Run your first scan", cls: "mod-cta" });
    btn.addEventListener("click", () => void this.plugin.runScan());
  }

  private renderScanningMeta(): void {
    const host = this.metaEl;
    if (!host) return;
    host.empty();
    host.createDiv({ cls: "attachment-audit-scanning-title", text: "Scanning your vault…" });
    this.summaryEl = host.createDiv({ cls: "attachment-audit-summary" });
    this.summaryEl.setAttribute("aria-live", "polite");
    this.progressTrackEl = host.createDiv({ cls: "attachment-audit-progress" });
    this.progressEl = this.progressTrackEl.createDiv({ cls: "attachment-audit-progress-bar" });
    this.showScanProgress(this.plugin.scanDone, this.plugin.scanTotal, this.plugin.scanPhase);
    // Skeleton rows so the pane reads as "working" instead of "empty".
    const skeletons = host.createDiv({ cls: "attachment-audit-skeletons" });
    for (let i = 0; i < 4; i++) skeletons.createDiv({ cls: "attachment-audit-skeleton" });
  }

  /**
   * A failed scan must never leave the previous run on screen looking current —
   * the user would be deciding what to delete from stale data.
   */
  private renderScanError(root: HTMLElement): void {
    const card = root.createDiv({ cls: "attachment-audit-error" });
    const head = card.createDiv({ cls: "attachment-audit-error-head" });
    setIcon(head.createSpan({ cls: "attachment-audit-error-icon" }), "alert-triangle");
    head.createSpan({ text: "That scan didn't finish" });
    card.createDiv({
      cls: "attachment-audit-error-body",
      text:
        "Nothing was changed. Any results below are from an earlier scan and may be out of date — " +
        "run a fresh scan before cleaning anything up.",
    });
    const retry = card.createEl("button", { text: "Try again", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.plugin.runScan());
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
    const stat = host.createDiv({ cls: "attachment-audit-stat" });
    stat.createSpan({ cls: "attachment-audit-stat-num", text: String(affected) });
    stat.createSpan({
      cls: "attachment-audit-stat-label",
      text: affected === 1 ? "attachment needs attention" : "attachments need attention",
    });
    if (summary.reclaimableBytes > 0) {
      this.reclaimBanner(host, `${formatBytes(summary.reclaimableBytes)} reclaimable`);
    }
    host
      .createDiv({ cls: "attachment-audit-summary" })
      .setText(`Last scan ${relativeTime(summary.scannedAt)} · run a scan to review`);
    const tiles = host.createDiv({ cls: "attachment-audit-tiles" });
    for (const type of ISSUE_TYPES) {
      const count = summary.byType[type] ?? 0;
      if (count === 0) continue;
      const tile = tiles.createDiv({ cls: "attachment-audit-tile is-static" });
      tile.createDiv({ cls: "attachment-audit-tile-count", text: String(count) });
      tile.createDiv({ cls: "attachment-audit-tile-label", text: ISSUE_TYPE_LABELS[type] });
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

    const stat = host.createDiv({ cls: "attachment-audit-stat" });
    stat.createSpan({ cls: "attachment-audit-stat-num", text: String(affected) });
    stat.createSpan({
      cls: "attachment-audit-stat-label",
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
      this.reclaimBanner(host, `${formatBytes(reclaim.unusedBytes)} reclaimable now${dup}`);
    } else if (reclaim.duplicateExtraBytes > 0) {
      // No safely-reclaimable unused bytes — lead with the duplicate figure so the
      // banner never shows a misleading "0 B reclaimable now".
      this.reclaimBanner(
        host,
        `${formatBytes(reclaim.duplicateExtraBytes)} in duplicate copies (review)`
      );
    }

    this.summaryEl = host.createDiv({ cls: "attachment-audit-summary" });
    this.summaryEl.setAttribute("aria-live", "polite");
    const last = this.plugin.lastResult;
    if (this.plugin.scanning) {
      this.progressTrackEl = host.createDiv({ cls: "attachment-audit-progress" });
      this.progressEl = this.progressTrackEl.createDiv({ cls: "attachment-audit-progress-bar" });
      this.showScanProgress(this.plugin.scanDone, this.plugin.scanTotal, this.plugin.scanPhase);
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
    // No severity legend any more: each row now spells the tier out in words
    // ("High · Unused · 2.1 MB"), so there is nothing left to decode. That also
    // reclaims a line of a pane where vertical space is the scarce resource.
  }

  /**
   * The headline metric. Rendered as a tinted surface with a Lucide icon rather
   * than green text and a `♻` glyph: `--text-success` on `--background-primary`
   * is ~2.6:1 in the light theme (WCAG wants 4.5:1), and `♻` renders as a
   * monochrome dingbat on Windows but a colour emoji on macOS.
   */
  private reclaimBanner(host: HTMLElement, text: string): void {
    const banner = host.createDiv({ cls: "attachment-audit-reclaim" });
    setIcon(banner.createSpan({ cls: "attachment-audit-reclaim-icon" }), "recycle");
    banner.createSpan({ text });
  }

  private renderTiles(host: HTMLElement, issues: AttachmentIssue[]): void {
    const counts = countByType(issues);
    const tiles = host.createDiv({ cls: "attachment-audit-tiles" });
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
    const tile = host.createEl("button", { cls: "attachment-audit-tile" });
    if (active) tile.addClass("is-active");
    // These are toggle filters, not navigation — state must be exposed, not just
    // signalled with a class.
    tile.setAttribute("aria-pressed", String(active));
    tile.createSpan({ cls: "attachment-audit-tile-count", text: String(count) });
    tile.createSpan({ cls: "attachment-audit-tile-label", text: label });
    tile.addEventListener("click", onClick);
  }

  /** Back to "all" — the escape hatch from an empty filtered view. */
  resetFilter(): void {
    this.setFilter("all");
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    this.selected.clear();
    this.invalidateView();
    this.render();
  }

  /**
   * Cheap update after an inline row action removed its own row: prune any
   * now-invisible selection, refresh the meta counts, and only pay for a full
   * re-render when the visible list emptied (to show the empty state / reset the
   * filter). Avoids rebuilding all rows — and collapsing "show more" — per click.
   */
  private handleRowMutation(): void {
    this.invalidateView();
    const visible = this.applyView();
    if (this.selected.size > 0) {
      const visibleIds = new Set(visible.map((i) => i.id));
      for (const id of this.selected) if (!visibleIds.has(id)) this.selected.delete(id);
    }
    if (visible.length === 0) {
      this.render();
      return;
    }
    if (this.metaEl) this.renderMeta(this.plugin.visibleIssues());
    this.updateSelCount();
  }

  private updateSelCount(): void {
    if (this.selCountEl) this.selCountEl.setText(`${this.selected.size} selected`);
    // Keep the select-all/none label truthful even when rows are toggled directly.
    if (this.selectAllBtn) {
      const shown = this.applyView();
      const allSelected = shown.length > 0 && shown.every((i) => this.selected.has(i.id));
      this.selectAllBtn.setText(allSelected ? "Select none" : "Select all");
    }
    this.updateBulkEnabled();
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "attachment-audit-toolbar" });

    const sort = bar.createEl("select", { cls: "dropdown" });
    sort.setAttribute("aria-label", "Sort results");
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

    // Selecting many is FREE. The Pro line sits at bulk MUTATION (see
    // requireBulkMutation), not at the ability to triage your own vault — gating
    // multi-select made review deliberately tedious, which reads as petty rather
    // than as a reason to buy.
    const bulk = bar.createEl("button", { text: this.bulkMode ? "Exit bulk" : "Bulk actions" });
    bulk.setAttribute("aria-pressed", String(this.bulkMode));
    bulk.addEventListener("click", () => {
      this.bulkMode = !this.bulkMode;
      if (!this.bulkMode) this.selected.clear();
      this.render();
    });
  }

  /**
   * A standing link to what this plugin has already changed. Shown whenever there
   * is history — including after a clean scan, because "what did it do last time"
   * is exactly the question a user has when the dashboard shows nothing to do.
   */
  private renderHistoryLink(root: HTMLElement): void {
    const journal = this.plugin.settings.journal;
    if (journal.length === 0) return;
    const restorable = journal.filter((b) => restorability(b).restorable).length;
    const bar = root.createDiv({ cls: "attachment-audit-history-link" });
    const btn = bar.createEl("button", { cls: "attachment-audit-inline-link" });
    setIcon(btn.createSpan({ cls: "attachment-audit-history-link-icon" }), "history");
    btn.createSpan({
      text: restorable > 0
        ? `Cleanup history — ${restorable} action${restorable === 1 ? "" : "s"} can be undone`
        : "Cleanup history",
    });
    btn.addEventListener("click", () => openHistory(this.plugin));
  }

  /**
   * The Pro gate for actions that CHANGE many files at once. Free users get one
   * complete bulk cleanup (`bulkTrialUsed`) so the value is felt before it's
   * charged for; non-destructive bulk actions never reach here.
   */
  private requireBulkMutation(action: () => void): void {
    if (this.plugin.isPro || !this.plugin.settings.bulkTrialUsed) {
      action();
      return;
    }
    const outstanding = this.plugin.visibleIssues().filter((i) => !this.plugin.isReviewed(i));
    const r = computeReclaim(outstanding);
    const unusedCount = outstanding.filter((i) => i.issueType === "unused").length;
    const ctx =
      unusedCount > 0
        ? `Clear all ${unusedCount} unused file${unusedCount === 1 ? "" : "s"} (${formatBytes(r.unusedBytes)}) in one click — plus dedupe and move across many files at once.`
        : undefined;
    requirePro(this.plugin, "bulk", action, ctx);
  }

  private renderBulkBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "attachment-audit-bulk-bar" });
    if (!this.plugin.isPro && !this.plugin.settings.bulkTrialUsed) {
      bar.createSpan({
        cls: "attachment-audit-trial-note",
        text: "Free trial: your first bulk cleanup is on us.",
      });
    }
    this.selCountEl = bar.createSpan({ text: `${this.selected.size} selected` });
    this.bulkActionButtons = [];

    const shown = this.applyView();
    const startAllSelected = shown.length > 0 && shown.every((i) => this.selected.has(i.id));
    const selectAll = bar.createEl("button", {
      text: startAllSelected ? "Select none" : "Select all",
    });
    this.selectAllBtn = selectAll;
    selectAll.addEventListener("click", () => {
      const nowAll = shown.length > 0 && shown.every((i) => this.selected.has(i.id));
      if (nowAll) shown.forEach((i) => this.selected.delete(i.id));
      else shown.forEach((i) => this.selected.add(i.id));
      if (this.resultsEl) {
        this.resultsEl.querySelectorAll("input.attachment-audit-check").forEach((el) => {
          (el as HTMLInputElement).checked = !nowAll;
        });
      }
      selectAll.setText(nowAll ? "Select all" : "Select none");
      this.updateSelCount();
    });

    const selectedIssues = (): AttachmentIssue[] =>
      this.applyView().filter((i) => this.selected.has(i.id));

    // The one action worth a permanent button; everything else goes in the menu.
    // Seven stacked full-width buttons pushed the results below the fold in a
    // ~300px pane, and five of them were disabled most of the time.
    const trashUnused = (): void => {
      const unused = selectedIssues().filter((i) => i.issueType === "unused");
      if (unused.length === 0) {
        new Notice(`${PRODUCT_NAME}: none of the selected items are unused.`);
        return;
      }
      this.requireBulkMutation(() => this.confirmTrashUnused(unused));
    };
    const primary = this.bulkButton(bar, "Trash unused", trashUnused);
    primary.addClass("mod-warning");
    if (!this.plugin.isPro) {
      primary.createSpan({
        cls: "attachment-audit-pro-pill",
        text: this.plugin.settings.bulkTrialUsed ? "Pro" : "Free trial",
      });
    }

    const moreBtn = this.bulkButton(bar, "More…", (evt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Mark reviewed")
          .setIcon("check")
          .onClick(() => void this.plugin.bulkMarkReviewed(selectedIssues()).then(() => this.afterBulk()))
      );
      menu.addItem((item) =>
        item
          .setTitle("Ignore")
          .setIcon("eye-off")
          .onClick(() => void this.plugin.bulkIgnore(selectedIssues()).then(() => this.afterBulk()))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Trash duplicate copies")
          .setIcon("copy-x")
          .onClick(() => {
            const dups = selectedIssues().filter((i) => i.issueType === "duplicate");
            if (dups.length === 0) {
              new Notice(`${PRODUCT_NAME}: none of the selected items are duplicates.`);
              return;
            }
            this.requireBulkMutation(() => this.confirmTrashDuplicates(dups));
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Move to attachment folder")
          .setIcon("folder-input")
          .onClick(() => {
            // A "missing" issue names a file that does not exist; including it
            // would list it in the confirm dialog as about to be moved and then
            // silently count it as skipped.
            const sel = selectedIssues().filter((i) => i.exists !== false);
            if (sel.length === 0) {
              new Notice(`${PRODUCT_NAME}: none of the selected items are movable files.`);
              return;
            }
            if (!this.plugin.settings.attachmentFolder.trim()) {
              new Notice(`${PRODUCT_NAME}: set an attachment folder in settings first.`);
              return;
            }
            this.requireBulkMutation(() => this.confirmMove(sel));
          })
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Export selected as report")
          .setIcon("file-down")
          .onClick(() => void this.plugin.exportReport(selectedIssues()))
      );
      menu.showAtMouseEvent(evt);
    });
    moreBtn.setAttribute("aria-haspopup", "menu");

    this.updateBulkEnabled();
  }

  private confirmTrashUnused(unused: AttachmentIssue[]): void {
    const bytes = computeReclaim(unused).unusedBytes;
    this.plugin.confirmDestructive(
      "Trash unused attachments",
      `Move ${unused.length} unused file${unused.length === 1 ? "" : "s"} to trash, ` +
        `freeing ${formatBytes(bytes)}? ${this.plugin.trashDestinationNote()}`,
      "Trash files",
      () => void this.plugin.bulkTrashUnused(unused).then((c) => this.afterBulkMutate(c)),
      unused.map((i) => i.attachmentPath)
    );
  }

  private confirmTrashDuplicates(dups: AttachmentIssue[]): void {
    this.plugin.confirmDestructive(
      "Trash duplicate copies",
      `Of the ${dups.length} selected duplicate(s), trash only the copies nothing links to? ` +
        "Linked copies are never touched and links are never rewritten — this is not a merge. " +
        "At least one copy of each file is always kept. " +
        this.plugin.trashDestinationNote(),
      "Trash copies",
      () => void this.plugin.bulkTrashDuplicateCopies(dups).then((c) => this.afterBulkMutate(c)),
      dups.map((i) => i.attachmentPath)
    );
  }

  private confirmMove(sel: AttachmentIssue[]): void {
    this.plugin.confirmDestructive(
      "Move to attachment folder",
      this.plugin.describeMoveAction(sel.length),
      "Move files",
      () => void this.plugin.bulkMoveToAttachmentFolder(sel).then((c) => this.afterBulkMutate(c)),
      sel.map((i) => i.attachmentPath)
    );
  }

  private bulkButton(
    bar: HTMLElement,
    label: string,
    onClick: (evt: MouseEvent) => void
  ): HTMLButtonElement {
    const btn = bar.createEl("button", { text: label });
    btn.addEventListener("click", onClick);
    this.bulkActionButtons.push(btn);
    return btn;
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
    // A successful bulk action spends the one-time free trial (for free users).
    if (changed.length > 0 && !this.plugin.isPro && !this.plugin.settings.bulkTrialUsed) {
      this.plugin.settings.bulkTrialUsed = true;
      this.plugin.queueSave();
      new Notice(
        "That was your free bulk cleanup — Attachment Audit Pro unlocks unlimited one-click cleanup."
      );
    }
    if (changed.length === 0) {
      this.render();
      return;
    }
    void this.plugin.settleCacheThenRescan(changed);
  }

  private renderProCta(root: HTMLElement): void {
    if (this.plugin.settings.proCtaDismissed) return;
    const card = root.createDiv({ cls: "attachment-audit-pro-cta" });
    const dismiss = card.createEl("button", { cls: "attachment-audit-cta-dismiss", text: "×" });
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
      card.createEl("strong", { text: `Attachment Audit Pro — ${PRO_PRICE_LABEL}` });
      card.createDiv({ text: PRO_TAGLINE });
    }
    card.createEl("a", {
      text: `Get Pro — ${PRO_PRICE_LABEL}`,
      cls: "attachment-audit-cta-link",
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

  /** Drop the memoized view; call after anything that changes what's visible. */
  private invalidateView(): void {
    this.viewCache = null;
  }

  private applyView(): AttachmentIssue[] {
    const sorted = this.sortedIssues();
    // Ignore/reviewed are Sets on the plugin, so their SIZE is a sufficient
    // change signal alongside the identity of the sorted source and the filter.
    const key = `${this.filter}|${this.sortMode}|${this.plugin.ignoredCount()}|${this.plugin.reviewedCount()}|${sorted.length}`;
    if (this.viewCache !== null && this.viewCacheKey === key) return this.viewCache;
    this.viewCache = sorted.filter(
      (i) =>
        !this.plugin.isIgnored(i) &&
        !this.plugin.isReviewed(i) &&
        (this.filter === "all" || i.issueType === this.filter)
    );
    this.viewCacheKey = key;
    return this.viewCache;
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
