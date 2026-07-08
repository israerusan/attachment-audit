// The shared data contract for Attachment Audit. Detectors, the rule engine,
// severity scoring, reports, and the UI all speak these types. Kept
// dependency-free (no `obsidian` import) so the core is pure and unit-testable
// under Node.

export type IssueType =
  | "unused"
  | "duplicate"
  | "large"
  | "unnamed"
  | "misplaced"
  | "custom";

export const ISSUE_TYPES: IssueType[] = [
  "unused",
  "duplicate",
  "large",
  "unnamed",
  "misplaced",
  "custom",
];

/** Human labels for each issue type, used in the dashboard, results, and reports. */
export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  unused: "Unused",
  duplicate: "Duplicates",
  large: "Large files",
  unnamed: "Poorly named",
  misplaced: "Misplaced",
  custom: "Custom rules",
};

export type SortMode = "severity" | "size" | "name" | "path";

// --- Attachment snapshot handed to the pure detectors -----------------------

/** Raw per-attachment data gathered from the Obsidian API by the scan boundary. */
export interface RawAttachmentInput {
  /** Vault-relative path, e.g. `assets/Pasted image 20260101.png`. */
  path: string;
  /** Full filename including extension, e.g. `Pasted image 20260101.png`. */
  name: string;
  /** Filename without the extension, e.g. `Pasted image 20260101`. */
  basename: string;
  /** Lower-cased extension without the dot, e.g. `png`. */
  extension: string;
  /** Size on disk in bytes. */
  size: number;
  /** Last-modified time, ms since epoch. */
  mtime: number;
  /** Count of resolved inbound references from notes (embeds + links). */
  inboundLinks: number;
  /** SHA-256 hex, set ONLY for size-collision files when the duplicate detector runs. */
  hash?: string;
  /**
   * Whether the filename was found in a raw-content mention scan (note bodies,
   * canvas `file` values, text attachments, frontmatter). Set ONLY when the
   * unused detector runs; a `true` here SUPPRESSES the unused flag.
   */
  mentionedInContent?: boolean;
}

/** Normalized attachment snapshot the detectors and rule engine read. */
export type AttachmentStat = RawAttachmentInput;

// --- Detector output --------------------------------------------------------

/**
 * What a detector returns when an attachment has a problem: a short human reason
 * plus optional detail. `null` means "no issue". The scan orchestrator turns a
 * hit into a full {@link AttachmentIssue}, assigning the id and severity weight.
 */
export interface DetectorHit {
  reason: string;
  details?: string;
}

export interface AttachmentIssue {
  /** Stable key: `path::issueType` (plus `::ruleId` for custom rules). */
  id: string;
  attachmentPath: string;
  attachmentName: string;
  issueType: IssueType;
  severity: number;
  reason: string;
  details?: string;
  /** Size on disk in bytes — carried for reclaimable-space and the report. */
  sizeBytes: number;
  /** For duplicates: the content hash shared by the cluster (for reclaim math). */
  clusterId?: string;
  /** Set for issues produced by a custom rule. */
  sourceRuleId?: string;
}

// --- Settings ---------------------------------------------------------------

export interface ScanProfile {
  id: string;
  name: string;
  enabledIssueTypes: IssueType[];
  includedFolders: string[];
  excludedFolders: string[];
  largeSizeThresholdKb?: number;
  attachmentFolder?: string;
  junkNamePatterns?: string[];
  customRuleIds?: string[];
  sortMode?: SortMode;
}

export type CustomRuleCondition =
  | { type: "extension-is"; extension: string }
  | { type: "larger-than-kb"; kb: number }
  | { type: "in-folder"; folder: string }
  | { type: "name-matches"; pattern: string }
  | { type: "older-than-days"; days: number };

export interface CustomRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: {
    folders?: string[];
  };
  condition: CustomRuleCondition;
  severity: number;
  message: string;
}

export interface LastScanSummary {
  scannedAt: string;
  totalFiles: number;
  totalIssues: number;
  /** Distinct attachments with at least one issue (the honest "needs attention" count). */
  affectedAttachments: number;
  byType: Record<string, number>;
  /** Safely reclaimable bytes (unused files) at the time of the scan. */
  reclaimableBytes: number;
  profileId?: string;
}

export interface AttachmentManagerSettings {
  version: number;

  /** Which built-in issue types a default scan runs (free per-detector on/off). */
  enabledIssueTypes: IssueType[];

  /** Flag files larger than this many KB. 0 disables the large detector. */
  largeSizeThresholdKb: number;
  /** Where attachments should live; files outside it are "misplaced". Blank disables. */
  attachmentFolder: string;
  /** Regex patterns (basename, case-insensitive) that mark a junk/auto name. */
  junkNamePatterns: string[];
  /** Files larger than this many KB are skipped by duplicate hashing (memory guard). */
  duplicateMaxScanKb: number;
  /** Extra extensions to treat as attachments beyond the default non-note set. */
  attachmentExtensions: string[];

  excludedFolders: string[];
  excludedPaths: string[];

  /** Issue keys (`path::issueType`) the user chose to ignore. */
  ignoredIssueKeys: string[];
  /** Issue keys the user marked reviewed. */
  reviewedIssueKeys: string[];

  licenseKey: string;
  licenseStatus: "free" | "valid-pro" | "invalid";
  licenseEmail?: string;

  severityWeights: Record<IssueType, number>;

  /** Persisted dashboard sort, so a plain re-scan keeps the user's choice. */
  sortMode: SortMode;

  savedProfiles: ScanProfile[];
  customRules: CustomRule[];

  lastScanSummary?: LastScanSummary;

  /** First-run onboarding flag. */
  onboardingDismissed: boolean;
  /** Whether the free user dismissed the persistent Pro CTA card. */
  proCtaDismissed: boolean;

  /** How many files the user has trashed one at a time (drives a bulk-Pro nudge). */
  singleTrashCount: number;
  /** Cumulative bytes reclaimed via trashing (drives a one-time review ask). */
  reclaimedTotalBytes: number;
  /** Whether we've already asked this user for a review (never re-ask). */
  reviewAsked: boolean;
  /** Whether the free user has spent their one-time "first bulk cleanup" trial. */
  bulkTrialUsed: boolean;
}

/** Just the knobs a scan needs; a profile can override these at run time. */
export interface ScanConfig {
  enabledIssueTypes: IssueType[];
  largeSizeThresholdKb: number;
  attachmentFolder: string;
  junkNamePatterns: string[];
  duplicateMaxScanKb: number;
  attachmentExtensions: string[];
  includedFolders: string[];
  excludedFolders: string[];
  excludedPaths: string[];
  severityWeights: Record<IssueType, number>;
  customRules: CustomRule[];
  sortMode: SortMode;
}
