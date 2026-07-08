import { App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmText: string;
  onConfirm: () => void;
}

/**
 * A small confirm dialog for destructive actions (trash / dedupe). Shows the
 * count and reclaimable size in the body, and requires an explicit click on the
 * warning-styled confirm button before anything is trashed.
 */
export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.opts.title);
    contentEl.createDiv({ cls: "attachment-audit-confirm-body", text: this.opts.body });

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
