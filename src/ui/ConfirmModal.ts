import { App, Modal, Setting, setIcon } from "obsidian";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmText: string;
  onConfirm: () => void;
  /**
   * The exact paths this action will touch. Shown as a scrollable list, because
   * "Move 14 unused file(s) to trash" gives the user no way to notice the one
   * they didn't mean to select.
   */
  files?: string[];
}

/** Beyond this, the list is summarized rather than rendered in full. */
const MAX_LISTED_FILES = 200;

/**
 * A small confirm dialog for destructive actions (trash / dedupe / move). Shows
 * the count, reclaimable size and affected paths, and requires an explicit click
 * on the warning-styled confirm button before anything is touched.
 */
export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.opts.title);
    // Carries the danger signal in the dialog's chrome, not only in the last 90px
    // of it — a destructive confirm otherwise looks identical to a benign prompt.
    this.modalEl.addClass("attachment-audit-confirm-modal");

    const callout = contentEl.createDiv({ cls: "attachment-audit-confirm-callout" });
    setIcon(callout.createSpan({ cls: "attachment-audit-confirm-icon" }), "alert-triangle");
    callout.createDiv({ cls: "attachment-audit-confirm-body", text: this.opts.body });

    const files = this.opts.files;
    if (files && files.length > 0) {
      const list = contentEl.createDiv({ cls: "attachment-audit-confirm-files" });
      for (const path of files.slice(0, MAX_LISTED_FILES)) {
        list.createDiv({ cls: "attachment-audit-confirm-file", text: path });
      }
      if (files.length > MAX_LISTED_FILES) {
        list.createDiv({
          cls: "attachment-audit-confirm-more",
          text: `…and ${files.length - MAX_LISTED_FILES} more`,
        });
      }
    }

    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText("Cancel").onClick(() => this.close());
        // Focus the safe choice by default so Enter doesn't confirm a destructive action.
        window.setTimeout(() => b.buttonEl.focus(), 0);
      })
      .addButton((b) =>
        b
          .setButtonText(this.opts.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.opts.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
