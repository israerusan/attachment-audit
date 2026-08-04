import assert from "node:assert";
import { resolveScanConfig } from "../src/core/scan/scanVault";
import type { AttachmentManagerSettings, ScanProfile } from "../src/types";

function baseSettings(): AttachmentManagerSettings {
  return {
    version: 1,
    enabledIssueTypes: ["unused", "large"],
    largeSizeThresholdKb: 1024,
    attachmentFolder: "/assets/", // leading+trailing slash — must normalize to "assets"
    junkNamePatterns: [],
    duplicateMaxScanKb: 51200,
    attachmentExtensions: [],
    excludedFolders: ["Archive"],
    excludedPaths: [],
    ignoredIssueKeys: [],
    reviewedIssueKeys: [],
    licenseKey: "",
    licenseStatus: "free",
    severityWeights: { unused: 3, duplicate: 3, large: 2, unnamed: 1, misplaced: 1, missing: 3, custom: 2 },
    sortMode: "severity",
    showThumbnails: true,
    journal: [],
    journalLimit: 50,
    savedProfiles: [],
    customRules: [],
    onboardingDismissed: false,
    proCtaDismissed: false,
    singleTrashCount: 0,
    reclaimedTotalBytes: 0,
    reviewAsked: false,
    bulkTrialUsed: false,
  };
}

// No profile: the attachment folder is normalized (slashes stripped) so the
// detector and the mover agree.
const base = resolveScanConfig(baseSettings());
assert.strictEqual(base.attachmentFolder, "assets");
assert.deepStrictEqual(base.enabledIssueTypes, ["unused", "large"]);
assert.strictEqual(base.includedFolders.length, 0);

// Profile overrides win, and its folder value is normalized too.
const profile: ScanProfile = {
  id: "p",
  name: "P",
  enabledIssueTypes: ["duplicate"],
  includedFolders: ["Notes"],
  excludedFolders: [],
  largeSizeThresholdKb: 2048,
  attachmentFolder: "/media",
};
const cfg = resolveScanConfig(baseSettings(), profile);
assert.deepStrictEqual(cfg.enabledIssueTypes, ["duplicate"]);
assert.strictEqual(cfg.largeSizeThresholdKb, 2048);
assert.strictEqual(cfg.attachmentFolder, "media");
assert.deepStrictEqual(cfg.includedFolders, ["Notes"]);
// An empty profile.excludedFolders falls back to the base exclusions.
assert.deepStrictEqual(cfg.excludedFolders, ["Archive"]);

// Omitted overrides inherit the base values.
const cfg2 = resolveScanConfig(baseSettings(), {
  ...profile,
  largeSizeThresholdKb: undefined,
  attachmentFolder: undefined,
});
assert.strictEqual(cfg2.largeSizeThresholdKb, 1024);
assert.strictEqual(cfg2.attachmentFolder, "assets");

console.log("resolveScanConfig tests passed");
