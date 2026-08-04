import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type AttachmentManagerPlugin from "./main";
import type { IssueType, CustomRule, ScanProfile } from "./types";
import { ISSUE_TYPES, ISSUE_TYPE_LABELS } from "./types";
import { DEFAULT_JUNK_NAME_PATTERNS } from "./core/naming/namePatterns";
import { checkRegexSafety } from "./core/rules/regexSafety";
import { DEFAULT_JOURNAL_LIMIT, MAX_JOURNAL_LIMIT } from "./core/journal/actionJournal";
import { openHistory } from "./ui/HistoryModal";
import { LicenseManager } from "./core/license/LicenseManager";
import { PRO_NAME, PRO_TAGLINE, PURCHASE_URL, REVIEW_URL } from "./product";
import { RuleEditModal } from "./ui/RuleEditModal";
import { ProfileEditModal } from "./ui/ProfileEditModal";
// DEFAULT_SETTINGS lives in core/settings/defaults.ts (pure data, reachable from
// the Node test path). Re-exported here so existing imports keep working.
export { DEFAULT_SETTINGS } from "./core/settings/defaults";

/** Split a comma/newline separated field into trimmed, non-empty entries. */
export function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Detectors the user can toggle in settings (custom is driven by rules). */
const BUILT_IN_TYPES: IssueType[] = [
  "unused",
  "duplicate",
  "large",
  "unnamed",
  "misplaced",
  "missing",
];

const DETECTOR_DESC: Record<string, string> = {
  unused: "Attachments no note references (two-signal check; safe to trash).",
  duplicate: "Byte-identical copies of the same file.",
  large: "Files over the size threshold below.",
  unnamed: "Auto-generated names like “Pasted image …”.",
  misplaced: "Files outside your attachment folder below.",
  missing:
    "Links pointing at attachments that no longer exist. Covers Markdown and wikilinks; " +
    "references written as raw HTML, in canvas, or in frontmatter are not tracked by Obsidian and won't appear.",
};

export class AttachmentManagerSettingTab extends PluginSettingTab {
  /** Inline warning slot for junk-name patterns that were screened out. */
  private patternWarningEl: HTMLElement | null = null;

  constructor(app: App, private plugin: AttachmentManagerPlugin) {
    super(app, plugin);
  }

  /**
   * Surface any pattern the safety screen refuses. Silently ignoring them would
   * look identical to "this detector doesn't work".
   */
  private reportUnsafePatterns(patterns: string[]): void {
    const host = this.patternWarningEl;
    if (!host) return;
    host.empty();
    const bad = patterns
      .map((p) => ({ pattern: p, verdict: checkRegexSafety(p) }))
      .filter((r) => !r.verdict.safe);
    if (bad.length === 0) return;
    host.addClass("attachment-audit-warning");
    for (const { pattern, verdict } of bad) {
      host.createDiv({ text: `Skipping "${pattern}" — ${verdict.reason ?? "unusable pattern."}` });
    }
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
            const patterns = parseList(v);
            s.junkNamePatterns = patterns;
            this.reportUnsafePatterns(patterns);
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

    // Tell the user immediately when a pattern is refused, rather than letting it
    // silently never match. The engine screens these anyway (a nested-quantifier
    // regex would hang Obsidian on every attachment), but silent rejection would
    // look like the detector was broken.
    this.patternWarningEl = containerEl.createDiv({ cls: "attachment-audit-nudge" });
    this.reportUnsafePatterns(s.junkNamePatterns);

    new Setting(containerEl)
      .setName("Cleanup history entries")
      .setDesc(
        "How many past actions to remember, so you can see what changed and put it back. " +
          "Set 0 to record nothing. Only files sent to the vault's .trash folder can be restored — " +
          "the system trash is not reachable from a plugin."
      )
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_JOURNAL_LIMIT))
          .setValue(String(s.journalLimit))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            s.journalLimit = Number.isFinite(n)
              ? Math.min(MAX_JOURNAL_LIMIT, Math.max(0, n))
              : DEFAULT_JOURNAL_LIMIT;
            // Trim immediately, so lowering the cap takes effect without waiting
            // for the next action to push entries off the end.
            s.journal = s.journal.slice(0, s.journalLimit);
            await this.save();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("history")
          .setTooltip("Open cleanup history")
          .onClick(() => openHistory(this.plugin))
      );

    new Setting(containerEl)
      .setName("Show image previews")
      .setDesc(
        "Render a small thumbnail beside image results. Turn off on very large vaults " +
          "or slow remote storage."
      )
      .addToggle((t) =>
        t.setValue(s.showThumbnails).onChange(async (v) => {
          s.showThumbnails = v;
          await this.save();
          this.plugin.refreshViews();
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
          "After purchase, paste your license key here to unlock all Pro features. See the Buy Pro section in the repo for current purchase and delivery details."
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
      text: "Buy Pro info",
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

/**
 * Largest size threshold accepted, in MB (64 TB). Matches the clamp
 * `normalizeSettings` applies on load.
 */
const MAX_THRESHOLD_MB = 1024 * 1024 * 64;

function clampFloat(value: string, min: number, fallback: number): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  // The UPPER bound matters as much as the lower one, and it only existed on the
  // load path: typing 100000000 into the MB box put 1.024e11 KB straight into the
  // live settings, and the `large` detector then silently reported nothing for the
  // rest of the session with nothing in the UI to explain why.
  return Math.min(MAX_THRESHOLD_MB, Math.max(min, n));
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
