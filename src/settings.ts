import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type AttachmentManagerPlugin from "./main";
import type { AttachmentManagerSettings, IssueType, CustomRule, ScanProfile } from "./types";
import { ISSUE_TYPES, ISSUE_TYPE_LABELS } from "./types";
import { DEFAULT_JUNK_NAME_PATTERNS } from "./core/naming/namePatterns";
import { LicenseManager } from "./core/license/LicenseManager";
import { PRO_NAME, PRO_TAGLINE, PURCHASE_URL, REVIEW_URL } from "./product";
import { RuleEditModal } from "./ui/RuleEditModal";
import { ProfileEditModal } from "./ui/ProfileEditModal";

export const DEFAULT_SETTINGS: AttachmentManagerSettings = {
  version: 1,
  enabledIssueTypes: [...ISSUE_TYPES],
  largeSizeThresholdKb: 1024, // 1 MB
  attachmentFolder: "",
  junkNamePatterns: [...DEFAULT_JUNK_NAME_PATTERNS],
  duplicateMaxScanKb: 51200, // skip hashing files over 50 MB (memory guard)
  attachmentExtensions: [],
  excludedFolders: [],
  excludedPaths: [],
  ignoredIssueKeys: [],
  reviewedIssueKeys: [],
  licenseKey: "",
  licenseStatus: "free",
  severityWeights: {
    unused: 3,
    duplicate: 3,
    large: 2,
    unnamed: 1,
    misplaced: 1,
    custom: 2,
  },
  sortMode: "severity",
  savedProfiles: [],
  customRules: [],
  onboardingDismissed: false,
  proCtaDismissed: false,
  singleTrashCount: 0,
  reclaimedTotalBytes: 0,
  reviewAsked: false,
  bulkTrialUsed: false,
};

/** Split a comma/newline separated field into trimmed, non-empty entries. */
export function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Detectors the user can toggle in settings (custom is driven by rules). */
const BUILT_IN_TYPES: IssueType[] = ["unused", "duplicate", "large", "unnamed", "misplaced"];

const DETECTOR_DESC: Record<string, string> = {
  unused: "Attachments no note references (two-signal check; safe to trash).",
  duplicate: "Byte-identical copies of the same file.",
  large: "Files over the size threshold below.",
  unnamed: "Auto-generated names like “Pasted image …”.",
  misplaced: "Files outside your attachment folder below.",
};

export class AttachmentManagerSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AttachmentManagerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderScanSection();
    this.renderExclusionsSection();
    this.renderLicenseSection();
    this.renderSeveritySection();
    this.renderRulesSection();
    this.renderProfilesSection();
  }

  private save(): Promise<void> {
    this.plugin.queueSave();
    return Promise.resolve();
  }

  private async saveNow(): Promise<void> {
    await this.plugin.saveSettings();
  }

  hide(): void {
    this.plugin.flushPendingSave();
  }

  // --- Scan settings --------------------------------------------------------

  private renderScanSection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Scan").setHeading();

    for (const type of BUILT_IN_TYPES) {
      new Setting(containerEl)
        .setName(`Detect ${ISSUE_TYPE_LABELS[type].toLowerCase()}`)
        .setDesc(DETECTOR_DESC[type])
        .addToggle((t) =>
          t.setValue(s.enabledIssueTypes.includes(type)).onChange((v) => {
            const set = new Set(s.enabledIssueTypes);
            if (v) set.add(type);
            else set.delete(type);
            s.enabledIssueTypes = ISSUE_TYPES.filter((it) => set.has(it));
            this.plugin.queueSave();
          })
        );
    }

    new Setting(containerEl)
      .setName("Large file threshold (MB)")
      .setDesc("Flag attachments larger than this. Set 0 to disable.")
      .addText((t) =>
        t
          .setPlaceholder("1")
          .setValue(String(round2(s.largeSizeThresholdKb / 1024)))
          .onChange(async (v) => {
            const mb = clampFloat(v, 0, s.largeSizeThresholdKb / 1024);
            s.largeSizeThresholdKb = Math.round(mb * 1024);
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc(
        "Where attachments should live. Files outside it are flagged “misplaced”, " +
          "and “move to attachment folder” targets it. Leave blank to disable both."
      )
      .addText((t) =>
        t
          .setPlaceholder("assets")
          .setValue(s.attachmentFolder)
          .onChange(async (v) => {
            s.attachmentFolder = v.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Junk name patterns")
      .setDesc(
        "Regular expressions (one per line) matched against the filename without its " +
          "extension, case-insensitively. Reset to restore the defaults."
      )
      .addTextArea((t) =>
        t
          .setValue(s.junkNamePatterns.join("\n"))
          .onChange(async (v) => {
            s.junkNamePatterns = parseList(v);
            await this.save();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reset to defaults")
          .onClick(async () => {
            s.junkNamePatterns = [...DEFAULT_JUNK_NAME_PATTERNS];
            await this.saveNow();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Duplicate hashing size cap (MB)")
      .setDesc("Skip hashing files larger than this when finding duplicates (protects memory). 0 turns duplicate hashing off.")
      .addText((t) =>
        t
          .setPlaceholder("50")
          .setValue(String(round2(s.duplicateMaxScanKb / 1024)))
          .onChange(async (v) => {
            const mb = clampFloat(v, 0, s.duplicateMaxScanKb / 1024);
            s.duplicateMaxScanKb = Math.round(mb * 1024);
            await this.save();
          })
      );
  }

  // --- Exclusions -----------------------------------------------------------

  private renderExclusionsSection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Exclusions").setHeading();

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Folders to skip entirely. One per line or comma-separated.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Templates\nArchive")
          .setValue(s.excludedFolders.join("\n"))
          .onChange(async (v) => {
            s.excludedFolders = parseList(v);
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("Individual attachment paths to skip. One per line or comma-separated.")
      .addTextArea((t) =>
        t
          .setValue(s.excludedPaths.join("\n"))
          .onChange(async (v) => {
            s.excludedPaths = parseList(v);
            await this.save();
          })
      );

    const ignoredCount = this.plugin.ignoredCount();
    new Setting(containerEl)
      .setName("Ignored results")
      .setDesc(
        ignoredCount > 0
          ? `${ignoredCount} result(s) hidden via "Ignore". Clear to bring them back on the next scan.`
          : "Results you ignore are hidden here. Nothing ignored yet."
      )
      .addButton((b) => {
        b.setButtonText("Clear ignored").setDisabled(ignoredCount === 0);
        b.onClick(async () => {
          await this.plugin.clearIgnored();
          this.display();
        });
      });
  }

  // --- License --------------------------------------------------------------

  private renderLicenseSection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Pro license").setHeading();

    if (this.plugin.isPro) {
      new Setting(containerEl)
        .setName(`${PRO_NAME} unlocked`)
        .setDesc(this.plugin.licenseEmail ? `Licensed to ${this.plugin.licenseEmail}.` : "Thank you!")
        .addButton((b) =>
          b.setButtonText("Clear license").onClick(async () => {
            s.licenseKey = "";
            this.plugin.refreshLicense();
            await this.saveNow();
            this.display();
          })
        );
      const review = new Setting(containerEl)
        .setName("Enjoying Attachment Audit?")
        .setDesc("A quick star on GitHub helps other vaults find it.");
      review.controlEl.createEl("a", {
        text: "Leave a review",
        cls: "attachment-audit-external-btn",
        href: REVIEW_URL,
      });
      return;
    }

    let draft = s.licenseKey;
    new Setting(containerEl)
      .setName("License key")
      .setDesc(
        this.plugin.licenseError ??
          "After purchase your key arrives by email. Paste it here to unlock all Pro features."
      )
      .addText((t) =>
        t
          .setPlaceholder("payload.signature")
          .setValue(s.licenseKey)
          .onChange((v) => {
            draft = v.trim();
          })
      );

    const actions = new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Validate")
        .setCta()
        .onClick(async () => {
          const result = LicenseManager.verify(draft);
          if (!result.valid) {
            new Notice(result.error);
            return;
          }
          s.licenseKey = draft;
          this.plugin.refreshLicense();
          await this.saveNow();
          new Notice(`${PRO_NAME} unlocked.`);
          this.display();
        })
    );
    actions.controlEl.createEl("a", {
      text: "Get Pro",
      cls: "attachment-audit-external-btn",
      href: PURCHASE_URL,
    });
    actions.setDesc(
      "One-time $9 — no account, no subscription. Your key works offline and unlocks every Pro feature on this device."
    );
  }

  // --- Pro: severity tuning -------------------------------------------------

  private renderSeveritySection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    this.proHeading("Severity tuning");
    if (!this.plugin.isPro) return;

    for (const type of ISSUE_TYPES) {
      new Setting(containerEl)
        .setName(ISSUE_TYPE_LABELS[type])
        .setDesc(`Weight for ${ISSUE_TYPE_LABELS[type].toLowerCase()} when sorting by severity.`)
        .addSlider((sl) =>
          sl
            .setLimits(1, 5, 1)
            .setValue(s.severityWeights[type])
            .setDynamicTooltip()
            .onChange(async (v) => {
              s.severityWeights[type] = v;
              await this.save();
            })
        );
    }
  }

  // --- Pro: custom rules ----------------------------------------------------

  private renderRulesSection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    this.proHeading("Custom rules");
    if (!this.plugin.isPro) return;

    for (const rule of s.customRules) {
      new Setting(containerEl)
        .setName(rule.name || "Untitled rule")
        .setDesc(describeRule(rule))
        .addToggle((tg) =>
          tg.setValue(rule.enabled).onChange(async (v) => {
            rule.enabled = v;
            await this.save();
          })
        )
        .addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip("Edit")
            .onClick(() => {
              new RuleEditModal(this.app, rule, async (updated) => {
                await this.plugin.saveRule(updated);
                this.display();
              }).open();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Delete")
            .onClick(async () => {
              await this.plugin.deleteRule(rule.id);
              this.display();
            })
        );
    }

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        new RuleEditModal(this.app, null, async (created) => {
          await this.plugin.saveRule(created);
          this.display();
        }).open();
      })
    );
  }

  // --- Pro: profiles --------------------------------------------------------

  private renderProfilesSection(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    this.proHeading("Saved scan profiles");
    if (!this.plugin.isPro) return;

    for (const profile of s.savedProfiles) {
      new Setting(containerEl)
        .setName(profile.name || "Untitled profile")
        .setDesc(describeProfile(profile))
        .addButton((b) =>
          b.setButtonText("Run").onClick(async () => {
            await this.plugin.runScan(profile.id);
            await this.plugin.activateView();
          })
        )
        .addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip("Edit")
            .onClick(() => {
              new ProfileEditModal(this.app, this.plugin, profile, async (updated) => {
                await this.plugin.saveProfile(updated);
                this.display();
              }).open();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Delete")
            .onClick(async () => {
              await this.plugin.deleteProfile(profile.id);
              this.display();
            })
        );
    }

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add profile").onClick(() => {
        new ProfileEditModal(this.app, this.plugin, null, async (created) => {
          await this.plugin.saveProfile(created);
          this.display();
        }).open();
      })
    );
  }

  private proHeading(title: string): void {
    const { containerEl } = this;
    const heading = new Setting(containerEl).setName(title).setHeading();
    heading.nameEl.createSpan({ text: "Pro", cls: "attachment-audit-pro-pill" });
    if (!this.plugin.isPro) {
      const upsell = new Setting(containerEl).setDesc(PRO_TAGLINE);
      upsell.settingEl.addClass("attachment-audit-locked");
      upsell.controlEl.createEl("a", {
        text: "Unlock Pro",
        cls: "attachment-audit-external-btn",
        href: PURCHASE_URL,
      });
    }
  }
}

function clampFloat(value: string, min: number, fallback: number): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function describeRule(rule: CustomRule): string {
  const where = rule.scope.folders?.length ? `folders: ${rule.scope.folders.join(", ")}` : "all files";
  return `${rule.condition.type} — ${where}`;
}

function describeProfile(profile: ScanProfile): string {
  const types = profile.enabledIssueTypes.length
    ? profile.enabledIssueTypes.map((t) => ISSUE_TYPE_LABELS[t]).join(", ")
    : "all issue types";
  const folders = profile.includedFolders.length ? ` in ${profile.includedFolders.join(", ")}` : "";
  return `${types}${folders}`;
}
