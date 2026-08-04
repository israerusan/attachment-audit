import { App, Modal, Notice, setIcon } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import type { AttachmentIssue } from "../types";
import { ISSUE_TYPE_LABELS } from "../types";
import { formatBytes } from "../core/utils/sizes";
import { PRODUCT_NAME } from "../product";

/**
 * Work through flagged attachments one at a time. Arrow keys move between issues;
 * r = mark reviewed, i = ignore, e = exclude, o = open the attachment.
 */
export class ReviewQueueModal extends Modal {
  private index = 0;

  constructor(
    app: App,
    private plugin: AttachmentManagerPlugin,
    private queue: AttachmentIssue[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Review flagged attachments");
    this.modalEl.addClass("attachment-audit-review-modal");
    this.registerKeys();
    this.renderCurrent();
  }

  onClose(): void {
    this.contentEl.empty();
    this.plugin.flushPendingSave();
    this.plugin.refreshViews();
  }

  private registerKeys(): void {
    this.scope.register([], "ArrowRight", () => this.move(1));
    this.scope.register([], "ArrowLeft", () => this.move(-1));
    this.scope.register([], "r", () => void this.toggleReviewed());
    this.scope.register([], "i", () => void this.ignoreCurrent());
    this.scope.register([], "e", () => void this.excludeCurrent());
    this.scope.register([], "o", () => void this.openCurrent());
    this.scope.register([], "t", () => this.trashCurrent());
    this.scope.register([], "m", () => this.moveCurrent());
  }

  /** Trash the current attachment — only ever offered for two-signal unused files. */
  private trashCurrent(): void {
    const issue = this.current();
    if (!issue || issue.issueType !== "unused") return;
    this.plugin.confirmDestructive(
      "Trash unused attachment",
      `No note links to or mentions "${issue.attachmentName}", so removing it won't break anything. ` +
        `Move it to trash, freeing ${formatBytes(issue.sizeBytes)}? ${this.plugin.trashDestinationNote()}`,
      "Trash file",
      () =>
        void this.plugin.bulkTrashUnused([issue], true).then((changed) => {
          if (changed.length) {
            this.plugin.handleTrashed(changed);
            this.dropIssue(issue);
          }
        }),
      [issue.attachmentPath]
    );
  }

  private moveCurrent(): void {
    const issue = this.current();
    if (!issue || issue.exists === false) return;
    if (!this.plugin.settings.attachmentFolder.trim()) return;
    this.plugin.confirmDestructive(
      "Move to attachment folder",
      this.plugin.describeMoveAction(1),
      "Move file",
      () =>
        void this.plugin.bulkMoveToAttachmentFolder([issue]).then((changed) => {
          if (changed.length) {
            this.dropIssue(issue);
            void this.plugin.settleCacheThenRescan(changed);
          }
        }),
      [issue.attachmentPath]
    );
  }

  private current(): AttachmentIssue | null {
    return this.queue[this.index] ?? null;
  }

  private move(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.queue.length) return;
    this.index = next;
    this.renderCurrent();
  }

  private renderCurrent(): void {
    const { contentEl } = this;
    contentEl.empty();
    const issue = this.current();
    if (!issue) {
      this.close();
      return;
    }

    contentEl.createDiv({
      cls: "attachment-audit-review-count",
      text: `${this.index + 1} of ${this.queue.length}`,
    });

    const header = contentEl.createDiv({ cls: "attachment-audit-review-header" });
    header.createSpan({
      cls: `attachment-audit-badge is-${issue.issueType}`,
      text: ISSUE_TYPE_LABELS[issue.issueType],
    });
    if (this.plugin.isReviewed(issue)) {
      header.createSpan({ cls: "attachment-audit-reviewed-tag", text: "Reviewed" });
    }

    contentEl.createEl("h3", { text: issue.attachmentName, cls: "attachment-audit-review-title" });
    contentEl.createDiv({
      cls: "attachment-audit-review-reason",
      text: `${issue.details ?? issue.reason} · ${formatBytes(issue.sizeBytes)}`,
    });
    contentEl.createDiv({ cls: "attachment-audit-review-path", text: issue.attachmentPath });

    const actions = contentEl.createDiv({ cls: "attachment-audit-review-actions" });
    this.actionButton(actions, "file-search", "Open (o)", () => void this.openCurrent());
    this.actionButton(
      actions,
      "check",
      this.plugin.isReviewed(issue) ? "Mark not reviewed (r)" : "Mark reviewed (r)",
      () => void this.toggleReviewed()
    );

    // Trash and Move were missing entirely, so a user working the queue had to
    // abandon it, find the row in the sidebar, and act there — for the two actions
    // the whole plugin exists to perform.
    if (issue.issueType === "unused") {
      const trash = this.actionButton(actions, "trash-2", "Trash file (t)", () =>
        this.trashCurrent()
      );
      trash.addClass("mod-warning");
    }
    if (this.plugin.settings.attachmentFolder.trim() && issue.exists !== false) {
      this.actionButton(actions, "folder-input", "Move to folder (m)", () => this.moveCurrent());
    }

    this.actionButton(actions, "eye-off", "Ignore (i)", () => void this.ignoreCurrent());
    this.actionButton(actions, "ban", "Exclude (e)", () => void this.excludeCurrent());

    contentEl.createDiv({
      cls: "attachment-audit-review-legend",
      text: "← → navigate · r review · t trash · m move · i ignore · e exclude · o open",
    });

    const nav = contentEl.createDiv({ cls: "attachment-audit-review-nav" });
    const prev = nav.createEl("button", { text: "Previous" });
    prev.disabled = this.index === 0;
    prev.addEventListener("click", () => this.move(-1));
    const next = nav.createEl("button", { text: "Next", cls: "mod-cta" });
    next.disabled = this.index >= this.queue.length - 1;
    next.addEventListener("click", () => this.move(1));
  }

  private actionButton(
    parent: HTMLElement,
    icon: string,
    tooltip: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "attachment-audit-review-action" });
    const iconEl = btn.createSpan();
    setIcon(iconEl, icon);
    btn.createSpan({ text: tooltip });
    // The visible label already IS the accessible name; an aria-label duplicating
    // it would only risk drifting from it.
    btn.addEventListener("click", onClick);
    return btn;
  }

  private async openCurrent(): Promise<void> {
    const issue = this.current();
    if (issue) await this.plugin.openAttachment(issue.attachmentPath);
  }

  private async toggleReviewed(): Promise<void> {
    const issue = this.current();
    if (!issue) return;
    await this.plugin.setReviewed(issue, !this.plugin.isReviewed(issue));
    this.renderCurrent();
  }

  private async ignoreCurrent(): Promise<void> {
    const issue = this.current();
    if (!issue) return;
    await this.plugin.setIgnored(issue, true);
    this.dropCurrent();
  }

  private async excludeCurrent(): Promise<void> {
    const issue = this.current();
    if (!issue) return;
    const path = issue.attachmentPath;
    await this.plugin.excludeAttachment(path);
    this.queue = this.queue.filter((i) => i.attachmentPath !== path);
    if (this.index >= this.queue.length) this.index = Math.max(0, this.queue.length - 1);
    if (this.queue.length === 0) {
      new Notice(`${PRODUCT_NAME}: review complete.`);
      this.close();
      return;
    }
    this.renderCurrent();
  }

  private dropCurrent(): void {
    this.dropIssue(this.current());
  }

  private dropIssue(target: AttachmentIssue | null): void {
    if (!target) return;
    this.queue = this.queue.filter((i) => i !== target);
    if (this.index >= this.queue.length) this.index = Math.max(0, this.queue.length - 1);
    if (this.queue.length === 0) {
      new Notice(`${PRODUCT_NAME}: review complete.`);
      this.close();
      return;
    }
    this.renderCurrent();
  }
}
