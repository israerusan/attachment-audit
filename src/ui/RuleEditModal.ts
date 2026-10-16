import { App, Modal, Notice, Setting } from "obsidian";
import { checkRegexSafety } from "../core/rules/regexSafety";
import type { CustomRule, CustomRuleCondition } from "../types";
import { newId } from "../core/utils/ids";
import { parseList } from "../settings";

type ConditionType = CustomRuleCondition["type"];

/** Create or edit a single custom rule (Pro). Intentionally simple: one folder
 *  scope, one condition, one severity — no nested logic. */
export class RuleEditModal extends Modal {
  private name: string;
  private enabled: boolean;
  private folders: string;
  private conditionType: ConditionType;
  private extension: string;
  private kb: number;
  private folder: string;
  private pattern: string;
  private days: number;
  private severity: number;
  private message: string;
  private paramHost: HTMLElement | null = null;

  constructor(
    app: App,
    private existing: CustomRule | null,
    private onSave: (rule: CustomRule) => Promise<void>
  ) {
    super(app);
    const c = existing?.condition;
    this.name = existing?.name ?? "";
    this.enabled = existing?.enabled ?? true;
    this.folders = (existing?.scope.folders ?? []).join(", ");
    this.conditionType = c?.type ?? "extension-is";
    this.extension = c && c.type === "extension-is" ? c.extension : "";
    this.kb = c && c.type === "larger-than-kb" ? c.kb : 1024;
    this.folder = c && c.type === "in-folder" ? c.folder : "";
    this.pattern = c && c.type === "name-matches" ? c.pattern : "";
    this.days = c && c.type === "older-than-days" ? c.days : 90;
    this.severity = existing?.severity ?? 2;
    this.message = existing?.message ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.existing ? "Edit rule" : "New rule");

    new Setting(contentEl).setName("Name").addText((t) =>
      t.setValue(this.name).onChange((v) => (this.name = v))
    );
    new Setting(contentEl).setName("Enabled").addToggle((t) =>
      t.setValue(this.enabled).onChange((v) => (this.enabled = v))
    );

    new Setting(contentEl)
      .setName("Scope: folders")
      .setDesc("Comma-separated. Leave blank for the whole vault.")
      .addText((t) => t.setValue(this.folders).onChange((v) => (this.folders = v)));

    new Setting(contentEl).setName("Condition").addDropdown((d) => {
      d.addOption("extension-is", "Extension is");
      d.addOption("larger-than-kb", "Larger than N KB");
      d.addOption("in-folder", "In folder");
      d.addOption("name-matches", "Name matches regex");
      d.addOption("older-than-days", "Older than N days");
      d.setValue(this.conditionType).onChange((v) => {
        this.conditionType = v as ConditionType;
        this.renderParams();
      });
    });

    this.paramHost = contentEl.createDiv();
    this.renderParams();

    new Setting(contentEl)
      .setName("Severity")
      .addSlider((s) =>
        s.setLimits(1, 5, 1).setValue(this.severity).setDynamicTooltip().onChange((v) => (this.severity = v))
      );

    new Setting(contentEl)
      .setName("Message")
      .setDesc("Shown as the issue reason.")
      .addText((t) => t.setValue(this.message).onChange((v) => (this.message = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Save rule").setCta().onClick(() => void this.submit())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderParams(): void {
    const host = this.paramHost;
    if (!host) return;
    host.empty();
    if (this.conditionType === "extension-is") {
      new Setting(host).setName("Extension").addText((t) =>
        t.setPlaceholder("png").setValue(this.extension).onChange((v) => (this.extension = v))
      );
    } else if (this.conditionType === "larger-than-kb") {
      new Setting(host).setName("KB").addText((t) =>
        t.setValue(String(this.kb)).onChange((v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isNaN(n)) this.kb = n;
        })
      );
    } else if (this.conditionType === "in-folder") {
      new Setting(host).setName("Folder").addText((t) =>
        t.setPlaceholder("assets/old").setValue(this.folder).onChange((v) => (this.folder = v))
      );
    } else if (this.conditionType === "name-matches") {
      new Setting(host).setName("Regex").addText((t) =>
        t.setPlaceholder("^scan\\d+").setValue(this.pattern).onChange((v) => (this.pattern = v))
      );
    } else {
      new Setting(host).setName("Days").addText((t) =>
        t.setValue(String(this.days)).onChange((v) => {
          const n = Number.parseInt(v, 10);
          if (!Number.isNaN(n)) this.days = n;
        })
      );
    }
  }

  private buildCondition(): CustomRuleCondition | null {
    switch (this.conditionType) {
      case "extension-is":
        return this.extension.trim()
          ? { type: "extension-is", extension: this.extension.trim().toLowerCase().replace(/^\./, "") }
          : null;
      case "larger-than-kb":
        // Clamp to >= 1 KB; a 0/negative threshold would flag every non-empty file.
        return { type: "larger-than-kb", kb: Math.max(1, this.kb) };
      case "in-folder":
        return this.folder.trim() ? { type: "in-folder", folder: this.folder.trim() } : null;
      case "name-matches":
        return this.pattern.trim() ? { type: "name-matches", pattern: this.pattern.trim() } : null;
      case "older-than-days":
        // Clamp to >= 1 day; 0/negative would match every non-future file.
        return { type: "older-than-days", days: Math.max(1, this.days) };
    }
  }

  private async submit(): Promise<void> {
    const condition = this.buildCondition();
    if (!condition) {
      new Notice("Please fill in the condition field.");
      return;
    }
    // Screen the pattern HERE, where the user can still fix it.
    //
    // Nothing validated it before. An unsafe or malformed pattern was accepted by
    // this dialog, saved, and listed in settings as an enabled rule — and then
    // `customRuleEngine` cached it as `null` and the condition returned false for
    // every file, forever, with no message anywhere. A rule that matches nothing
    // and says nothing is worse than a rejected one, and this is a paid feature.
    // (The junk-name textarea has always reported its own rejections; the rules
    // UI simply never grew the same check.)
    if (condition.type === "name-matches") {
      const verdict = checkRegexSafety(condition.pattern);
      if (!verdict.safe) {
        new Notice(`${verdict.reason ?? "That pattern cannot be used."}`, 10000);
        return;
      }
    }
    const rule: CustomRule = {
      id: this.existing?.id ?? newId("rule"),
      name: this.name.trim() || "Untitled rule",
      enabled: this.enabled,
      scope: { folders: parseList(this.folders) },
      condition,
      severity: this.severity,
      message: this.message.trim() || defaultMessage(condition),
    };
    await this.onSave(rule);
    this.close();
  }
}

function defaultMessage(condition: CustomRuleCondition): string {
  switch (condition.type) {
    case "extension-is":
      return `Extension is .${condition.extension}`;
    case "larger-than-kb":
      return `Larger than ${condition.kb} KB`;
    case "in-folder":
      return `In folder ${condition.folder}`;
    case "name-matches":
      return `Name matches /${condition.pattern}/`;
    case "older-than-days":
      return `Older than ${condition.days} days`;
  }
}
