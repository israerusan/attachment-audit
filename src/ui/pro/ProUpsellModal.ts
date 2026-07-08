import { App, Modal, Notice } from "obsidian";
import { PRODUCT_ID, PRO_NAME, PRO_PRICE_LABEL, PRO_TAGLINE, PRO_UPSELL, PURCHASE_URL } from "../../product";

/** Obsidian's settings opener — not in the public typings. */
interface SettingApi {
  open?: () => void;
  openTabById?: (id: string) => void;
}

/**
 * An actionable upsell shown the moment a free user reaches for a Pro feature:
 * what they get, the price, a real buy link, and a shortcut to paste a key —
 * instead of a toast that fades with no next step.
 */
export class ProUpsellModal extends Modal {
  constructor(
    app: App,
    private feature: keyof typeof PRO_UPSELL,
    /** Optional concrete hook (e.g. "Clear all 143 unused files (2.1 GB) at once."). */
    private context?: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`${PRO_NAME} — ${PRO_PRICE_LABEL}`);

    // Lead with the user's concrete payoff when we have one — it converts far
    // better than a generic feature list at the moment of peak intent.
    if (this.context) {
      contentEl.createDiv({ cls: "attachment-audit-upsell-lead", text: this.context });
      contentEl.createDiv({ cls: "attachment-audit-upsell-sub", text: PRO_UPSELL[this.feature] });
    } else {
      contentEl.createDiv({ cls: "attachment-audit-upsell-lead", text: PRO_UPSELL[this.feature] });
      contentEl.createDiv({ cls: "attachment-audit-upsell-sub", text: PRO_TAGLINE });
    }

    const actions = contentEl.createDiv({ cls: "attachment-audit-upsell-actions" });
    actions.createEl("a", {
      text: `Get Pro — ${PRO_PRICE_LABEL}`,
      cls: "attachment-audit-cta-link",
      href: PURCHASE_URL,
    });
    const haveKey = actions.createEl("button", { text: "I have a license key" });
    haveKey.addEventListener("click", () => {
      this.close();
      // Jump straight to our settings tab so activation is one paste away; fall
      // back to a plain instruction if the (internal) settings API isn't available.
      const setting = (this.app as unknown as { setting?: SettingApi }).setting;
      if (setting?.open) {
        setting.open();
        setting.openTabById?.(PRODUCT_ID);
      } else {
        new Notice("Open Settings → Community plugins → Attachment Audit → Pro license and paste your key.");
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
