// The default settings object. Pure data, no Obsidian API — it lives in core so
// the normalizer, the migration path and their tests can reach it without
// dragging `PluginSettingTab` (and therefore the whole Obsidian runtime) into
// the pure test path. `src/settings.ts` re-exports it for existing callers.

import { ISSUE_TYPES } from "../../types";
import type { AttachmentManagerSettings } from "../../types";
import { DEFAULT_JUNK_NAME_PATTERNS } from "../naming/namePatterns";
import { SCHEMA_VERSION } from "./normalize";

export const DEFAULT_SETTINGS: AttachmentManagerSettings = {
  version: SCHEMA_VERSION,
  enabledIssueTypes: [...ISSUE_TYPES],
  largeSizeThresholdKb: 1024, // 1 MB
  attachmentFolder: "",
  junkNamePatterns: [...DEFAULT_JUNK_NAME_PATTERNS],
  duplicateMaxScanKb: 51200, // skip hashing files over 50 MB (per-file memory guard)
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
    missing: 3, // a broken embed is visibly wrong in a note, right now
    custom: 2,
  },
  sortMode: "severity",
  showThumbnails: true,
  savedProfiles: [],
  customRules: [],
  onboardingDismissed: false,
  proCtaDismissed: false,
  singleTrashCount: 0,
  reclaimedTotalBytes: 0,
  reviewAsked: false,
  bulkTrialUsed: false,
};
