import { App, Modal, Notice, Setting } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import type { ScanProfile, IssueType, SortMode } from "../types";
import { ISSUE_TYPES, ISSUE_TYPE_LABELS } from "../types";
import { newId } from "../core/utils/ids";
import { parseList } from "../settings";

/** Create or edit a saved scan profile (Pro): a reusable set of enabled issue
 *  types, folder scope, threshold overrides, and which custom rules run. */
export class ProfileEditModal extends Modal {
  private name: string;
  private enabledTypes: Set<IssueType>;
  private includedFolders: string;
  private excludedFolders: string;
  private sortMode: SortMode;
  private largeMb: string;
  private attachmentFolder: string;
  private ruleIds: Set<string> | null;

  constructor(
    app: App,
    private plugin: AttachmentManagerPlugin,
    private existing: ScanProfile | null,
    private onSave: (profile: ScanProfile) => Promise<void>
  ) {
    super(app);
    this.name = existing?.name ?? "";
    this.enabledTypes = new Set(existing?.enabledIssueTypes ?? ISSUE_TYPES);
    this.includedFolders = (existing?.includedFolders ?? []).join(", ");
    this.excludedFolders = (existing?.excludedFolders ?? []).join(", ");
    this.sortMode = existing?.sortMode ?? "severity";
    this.largeMb =
      existing?.largeSizeThresholdKb != null ? String(existing.largeSizeThresholdKb / 1024) : "";
    this.attachmentFolder = existing?.attachmentFolder ?? "";
    this.ruleIds = existing?.customRuleIds ? new Set(existing.customRuleIds) : null;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.existing ? "Edit profile" : "New profile");

    new Setting(contentEl).setName("Name").addText((t) =>
      t.setPlaceholder("Monthly cleanup").setValue(this.name).onChange((v) => (this.name = v))
    );

    new Setting(contentEl).setName("Issue types to include").setHeading();
    for (const type of ISSUE_TYPES) {
      new Setting(contentEl).setName(ISSUE_TYPE_LABELS[type]).addToggle((t) =>
        t.setValue(this.enabledTypes.has(type)).onChange((v) => {
          if (v) this.enabledTypes.add(type);
          else this.enabledTypes.delete(type);
        })
      );
    }

    new Setting(contentEl)
      .setName("Included folders")
      .setDesc("Comma-separated. Leave blank to scan the whole vault.")
      .addText((t) => t.setValue(this.includedFolders).onChange((v) => (this.includedFolders = v)));
    new Setting(contentEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated. Overrides the global exclusions when set.")
      .addText((t) => t.setValue(this.excludedFolders).onChange((v) => (this.excludedFolders = v)));

    new Setting(contentEl).setName("Overrides (blank = use global)").setHeading();
    new Setting(contentEl).setName("Large threshold (MB)").addText((t) =>
      t.setPlaceholder("global").setValue(this.largeMb).onChange((v) => (this.largeMb = v))
    );
    new Setting(contentEl)
      .setName("Attachment folder")
      .setDesc("Blank = use global.")
      .addText((t) => t.setValue(this.attachmentFolder).onChange((v) => (this.attachmentFolder = v)));

    const rules = this.plugin.settings.customRules;
    if (rules.length > 0) {
      new Setting(contentEl).setName("Custom rules to run (all if none selected)").setHeading();
      for (const rule of rules) {
        new Setting(contentEl).setName(rule.name || "Untitled rule").addToggle((t) =>
          t.setValue(this.ruleIds ? this.ruleIds.has(rule.id) : true).onChange((v) => {
            if (!this.ruleIds) this.ruleIds = new Set(rules.map((r) => r.id));
            if (v) this.ruleIds.add(rule.id);
            else this.ruleIds.delete(rule.id);
          })
        );
      }
    }

    new Setting(contentEl).setName("Sort").addDropdown((d) => {
      d.addOption("severity", "Severity");
      d.addOption("size", "Size");
      d.addOption("name", "Name");
      d.addOption("path", "Path");
      d.setValue(this.sortMode).onChange((v) => (this.sortMode = v as SortMode));
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Save profile").setCta().onClick(() => void this.submit())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    let enabledIssueTypes = ISSUE_TYPES.filter((t) => this.enabledTypes.has(t));
    if (this.ruleIds && this.ruleIds.size === 0) {
      enabledIssueTypes = enabledIssueTypes.filter((t) => t !== "custom");
    }
    if (enabledIssueTypes.length === 0) {
      new Notice("Select at least one issue type for this profile.");
      return;
    }
    const largeSizeThresholdKb = toMbKb(this.largeMb);
    const attachmentFolder = this.attachmentFolder.trim();

    const profile: ScanProfile = {
      ...this.existing,
      id: this.existing?.id ?? newId("profile"),
      name: this.name.trim() || "Untitled profile",
      enabledIssueTypes,
      includedFolders: parseList(this.includedFolders),
      excludedFolders: parseList(this.excludedFolders),
      sortMode: this.sortMode,
      largeSizeThresholdKb,
      attachmentFolder: attachmentFolder.length > 0 ? attachmentFolder : undefined,
      customRuleIds: this.ruleIds && this.ruleIds.size > 0 ? [...this.ruleIds] : undefined,
    };
    await this.onSave(profile);
    this.close();
  }
}

/** Largest threshold accepted, in KB (64 TB) — matches the load-time clamp. */
const MAX_THRESHOLD_KB = 1024 * 1024 * 64;

/** Parse an optional MB override into KB; blank/invalid yields undefined (use global). */
function toMbKb(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return undefined;
  // Clamped here as well as on load: an absurd value entered in this modal would
  // otherwise sit in the live profile for the session and silently stop the
  // `large` detector from ever firing for scans that use it.
  return Math.min(MAX_THRESHOLD_KB, Math.max(0, Math.round(n * 1024)));
}
