import { App, Modal, Notice, setIcon } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import { formatBytes } from "../core/utils/sizes";
import {
  batchBytes,
  describeBatch,
  restorability,
  type JournalBatch,
} from "../core/journal/actionJournal";
import { PRODUCT_NAME } from "../product";

/** Files listed per batch before the rest are summarized. */
const MAX_LISTED = 12;

/**
 * The cleanup history: what this plugin changed, when, and whether it can be put
 * back.
 *
 * The plugin's pitch is that it is safe enough to trust with bulk delete, and
 * everything backing that was previously prose. This is the evidence — including
 * the honest negative cases, which matter more than the positive one: a batch
 * that went to the system trash or was permanently deleted says so plainly
 * rather than offering a restore that cannot work.
 */
export class HistoryModal extends Modal {
  constructor(app: App, private plugin: AttachmentManagerPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Cleanup history");
    this.modalEl.addClass("attachment-audit-history-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const journal = this.plugin.settings.journal;
    if (journal.length === 0) {
      const empty = contentEl.createDiv({ cls: "attachment-audit-empty" });
      setIcon(empty.createDiv({ cls: "attachment-audit-empty-icon" }), "history");
      empty.createDiv({ cls: "attachment-audit-empty-title", text: "Nothing yet" });
      empty.createDiv({
        cls: "attachment-audit-empty-hint",
        text:
          this.plugin.settings.journalLimit <= 0
            ? "History is turned off in settings."
            : "Every trash, move and rename Attachment Audit performs will be listed here, with a way to put it back.",
      });
      return;
    }

    contentEl.createDiv({
      cls: "attachment-audit-history-intro",
      text: `The last ${journal.length} action${journal.length === 1 ? "" : "s"} Attachment Audit performed, newest first.`,
    });

    const list = contentEl.createDiv({ cls: "attachment-audit-history" });
    for (const batch of journal) this.renderBatch(list, batch);

    const footer = contentEl.createDiv({ cls: "attachment-audit-history-footer" });
    const clear = footer.createEl("button", { text: "Clear history" });
    clear.addEventListener("click", () => {
      this.plugin.confirmDestructive(
        "Clear cleanup history",
        "Forget every recorded action? The files themselves are not touched — but anything " +
          "still restorable will no longer be listed, so you will not be able to put it back from here.",
        "Clear history",
        () => void this.plugin.clearJournal().then(() => this.render())
      );
    });
  }

  private renderBatch(host: HTMLElement, batch: JournalBatch): void {
    const card = host.createDiv({ cls: "attachment-audit-history-item" });
    if (batch.revertedAt) card.addClass("is-reverted");

    const head = card.createDiv({ cls: "attachment-audit-history-head" });
    setIcon(head.createSpan({ cls: "attachment-audit-history-icon" }), iconFor(batch));
    const bytes = batchBytes(batch);
    const size = bytes > 0 ? ` · ${formatBytes(bytes)}` : "";
    head.createSpan({
      cls: "attachment-audit-history-title",
      text: `${describeBatch(batch)}${size}`,
    });
    head.createSpan({
      cls: "attachment-audit-history-when",
      text: relativeTime(batch.at),
    });

    const done = batch.entries.filter((e) => e.restoredTo).length;
    const outstanding = batch.entries.length - done;

    const files = card.createDiv({ cls: "attachment-audit-history-files" });
    for (const entry of batch.entries.slice(0, MAX_LISTED)) {
      const row = files.createDiv({ cls: "attachment-audit-history-file" });
      // Show per-entry state. Without it a 3-of-5 restore rendered identically to
      // an untouched batch, so the only signal the user ever got was a Notice
      // that had already disappeared.
      if (entry.restoredTo) {
        row.addClass("is-restored");
        setIcon(row.createSpan({ cls: "attachment-audit-history-tick" }), "check");
      }
      row.createSpan({ text: entry.from });
      if (entry.restoredTo && entry.restoredTo !== entry.from) {
        // It could not take its original name back, so say where it actually is.
        row.createSpan({ cls: "attachment-audit-history-arrow", text: " → " });
        row.createSpan({ text: entry.restoredTo });
      } else if (entry.to && !entry.restoredTo) {
        row.createSpan({ cls: "attachment-audit-history-arrow", text: " → " });
        row.createSpan({ text: entry.to });
      }
    }
    if (batch.entries.length > MAX_LISTED) {
      files.createDiv({
        cls: "attachment-audit-history-more",
        text: `…and ${batch.entries.length - MAX_LISTED} more`,
      });
    }

    const actions = card.createDiv({ cls: "attachment-audit-history-actions" });
    const verdict = restorability(batch);
    if (!verdict.restorable) {
      actions.createSpan({
        cls: "attachment-audit-history-note",
        text: verdict.reason ?? "This cannot be restored.",
      });
      return;
    }

    if (verdict.caveat) {
      actions.createSpan({ cls: "attachment-audit-history-note", text: verdict.caveat });
    }
    if (done > 0) {
      actions.createSpan({
        cls: "attachment-audit-history-note",
        text: `${done} of ${batch.entries.length} already back`,
      });
    }

    const restore = actions.createEl("button", {
      text: done > 0 ? `Put the remaining ${outstanding} back` : "Put these back",
      cls: "mod-cta",
    });
    // Restoring is FREE, at any size, deliberately.
    //
    // Pro's line is doing cleanup at SCALE; recovering from cleanup is not scale,
    // it is safety — and this plugin's entire pitch is that it is safe enough to
    // trust with bulk delete. Charging to undo would undercut the pitch, and it
    // would land hardest on exactly the wrong person: a free user whose one-time
    // bulk trial did something they didn't intend.
    restore.addEventListener("click", () => {
      restore.disabled = true;
      restore.setText("Restoring…");
      void this.plugin.restoreBatch(batch.id).then(() => this.render());
    });

    // An escape hatch for a batch that can never complete — a file deleted from
    // `.trash`, or one whose content no longer matches. Without this the card
    // stays live forever and every click re-walks the trash and re-fails, with
    // no way to acknowledge it and move on.
    //
    // Offered whenever the batch is restorable at all, NOT only once something
    // has come back. Gating it on `done > 0` meant the one case it exists for —
    // emptying the OS trash after a cleanup, so that every single entry fails —
    // was the exact case where it never appeared.
    const dismiss = actions.createEl("button", { text: "Done with this" });
    dismiss.addEventListener("click", () => {
      void this.plugin.dismissBatch(batch.id).then(() => this.render());
    });
  }
}

function iconFor(batch: JournalBatch): string {
  switch (batch.op) {
    case "trash":
      return "trash-2";
    case "move":
      return "folder-input";
    case "rename":
      return "pencil";
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Open the history, or say why there is nothing to show. */
export function openHistory(plugin: AttachmentManagerPlugin): void {
  if (plugin.settings.journalLimit <= 0 && plugin.settings.journal.length === 0) {
    new Notice(`${PRODUCT_NAME}: cleanup history is turned off in settings.`);
    return;
  }
  new HistoryModal(plugin.app, plugin).open();
}
