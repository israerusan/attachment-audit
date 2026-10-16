// Pure settings normalization and schema migration. No Obsidian API — runs in
// tests under Node.
//
// `data.json` is a file on disk: it survives downgrades, hand edits, partial
// writes and sync conflicts. Anything loaded from it is untrusted input, and the
// failure mode is quiet — a corrupted `enabledIssueTypes` used to make every scan
// report "0 issues", which reads to the user as "my vault is clean" rather than
// "the plugin is broken".

import { ISSUE_TYPES } from "../../types";
import { MAX_THRESHOLD_KB } from "./limits";
import {
  DEFAULT_JOURNAL_LIMIT,
  MAX_JOURNAL_LIMIT,
  normalizeJournal,
} from "../journal/actionJournal";
import type {
  AttachmentManagerSettings,
  CustomRule,
  CustomRuleCondition,
  IssueType,
  ScanProfile,
  SortMode,
} from "../../types";

/** Current schema version. Bump when a migration is added below. */
export const SCHEMA_VERSION = 3;

const SORT_MODES: SortMode[] = ["severity", "size", "name", "path"];

/** Array-valued keys that must always end up as arrays. */
const ARRAY_KEYS = [
  "junkNamePatterns",
  "attachmentExtensions",
  "excludedFolders",
  "excludedPaths",
  "ignoredIssueKeys",
  "reviewedIssueKeys",
  "savedProfiles",
  "customRules",
] as const;

type RawSettings = Record<string, unknown>;

/**
 * Ordered migrations, keyed by the version they upgrade FROM. Version 0 means a
 * blob written before the field existed.
 */
const MIGRATIONS: Record<number, (raw: RawSettings) => RawSettings> = {
  0: (raw) => ({ ...raw, version: 1 }),
  // 1 -> 2 introduced no field changes; the bump exists so `version` is finally
  // READ on load (it was written but never inspected before), which is what makes
  // every future migration possible.
  1: (raw) => ({ ...raw, version: 2 }),
  // 2 -> 3 adds the cleanup journal. A vault upgrading from 1.1.0 has no history,
  // and starting it empty is correct — we cannot reconstruct actions taken before
  // there was anywhere to record them, and inventing entries would offer restores
  // that cannot work.
  2: (raw) => ({
    ...raw,
    journal: Array.isArray(raw.journal) ? raw.journal : [],
    journalLimit:
      typeof raw.journalLimit === "number" && Number.isFinite(raw.journalLimit)
        ? raw.journalLimit
        : DEFAULT_JOURNAL_LIMIT,
    version: 3,
  }),
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function hasStringId(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * A string field's value, or `fallback`. Deliberately NOT `String(value)`: a
 * hand-edited object would stringify to the literal "[object Object]" and be
 * stored as if the user had typed it.
 */
function toStringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Keep only the string members of a value that should be a string array. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Keep only valid issue types, or `undefined` when the field was absent/unusable. */
function toIssueTypes(value: unknown): IssueType[] | undefined {
  if (value === undefined || value === null) return undefined;
  const valid = new Set<string>(ISSUE_TYPES);
  const kept = Array.isArray(value)
    ? value.filter((t): t is IssueType => typeof t === "string" && valid.has(t))
    : [];
  // An unusable value must not silently disable every detector for this profile —
  // dropping the override falls back to the global setting instead.
  return kept.length > 0 ? kept : undefined;
}

/**
 * A saved profile overrides scan config, so every field it can override needs the
 * same validation the top-level settings get. Unusable overrides are DROPPED
 * (left `undefined`) so `resolveScanConfig` falls back to the base value.
 */
function normalizeProfile(raw: RawSettings, defaults: AttachmentManagerSettings): ScanProfile {
  const profile: ScanProfile = {
    id: toStringField(raw.id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Untitled profile",
    enabledIssueTypes: toIssueTypes(raw.enabledIssueTypes) ?? [...defaults.enabledIssueTypes],
    includedFolders: toStringArray(raw.includedFolders),
    excludedFolders: toStringArray(raw.excludedFolders),
  };
  if (typeof raw.largeSizeThresholdKb === "number" && Number.isFinite(raw.largeSizeThresholdKb)) {
    // Same upper clamp as the top-level field. Without it `1e300` survived into
    // ScanConfig and the `large` detector silently never fired for that profile —
    // the quiet failure mode this module exists to prevent.
    profile.largeSizeThresholdKb = clampNumber(raw.largeSizeThresholdKb, 0, 0, MAX_THRESHOLD_KB);
  }
  if (typeof raw.attachmentFolder === "string") profile.attachmentFolder = raw.attachmentFolder;
  if (Array.isArray(raw.junkNamePatterns)) {
    profile.junkNamePatterns = toStringArray(raw.junkNamePatterns);
  }
  if (Array.isArray(raw.customRuleIds)) profile.customRuleIds = toStringArray(raw.customRuleIds);
  if (typeof raw.sortMode === "string" && SORT_MODES.includes(raw.sortMode as SortMode)) {
    profile.sortMode = raw.sortMode as SortMode;
  }
  return profile;
}

/** Coerce a custom rule into a shape the engine can evaluate without throwing. */
function normalizeRule(raw: RawSettings, defaults: AttachmentManagerSettings): CustomRule {
  const rawCondition = (
    typeof raw.condition === "object" && raw.condition !== null ? raw.condition : {}
  ) as RawSettings;
  const rawScope = (typeof raw.scope === "object" && raw.scope !== null ? raw.scope : {}) as RawSettings;

  // An unrecognised condition type would fall through `conditionTrue`'s switch and
  // return undefined; default it to something inert and valid instead.
  let condition: CustomRuleCondition = { type: "larger-than-kb", kb: Number.MAX_SAFE_INTEGER };
  switch (rawCondition.type) {
    case "extension-is":
      condition = { type: "extension-is", extension: toStringField(rawCondition.extension) };
      break;
    case "larger-than-kb":
      condition = {
        type: "larger-than-kb",
        kb: typeof rawCondition.kb === "number" && Number.isFinite(rawCondition.kb) ? rawCondition.kb : 0,
      };
      break;
    case "in-folder":
      condition = { type: "in-folder", folder: toStringField(rawCondition.folder) };
      break;
    case "name-matches":
      condition = { type: "name-matches", pattern: toStringField(rawCondition.pattern) };
      break;
    case "older-than-days":
      condition = {
        type: "older-than-days",
        // Clamped, not merely checked for finiteness. `isOlderThanDays` tests
        // `now - mtime > days * MS_PER_DAY`, so a NEGATIVE value makes the rule
        // fire on every attachment in the vault — one issue per file. `kb` was
        // already defended downstream; `days` was not, and this module's whole
        // premise is that data.json is untrusted input. 100 years is the ceiling.
        days: clampNumber(rawCondition.days, 0, 0, 36500),
      };
      break;
  }

  return {
    id: toStringField(raw.id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Untitled rule",
    enabled: raw.enabled !== false,
    scope: { folders: toStringArray(rawScope.folders) },
    condition,
    severity: clampNumber(raw.severity, defaults.severityWeights.custom, 1, 5),
    message: typeof raw.message === "string" ? raw.message : "",
  };
}

/**
 * Coerce the cached last-scan summary, or drop it entirely. Every field the
 * dashboard reads must be present and the right type — a half-written summary is
 * worse than none, because the "no scan yet" path renders cleanly.
 */
function normalizeSummary(value: unknown): AttachmentManagerSettings["lastScanSummary"] {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as RawSettings;
  if (typeof raw.scannedAt !== "string" || Number.isNaN(Date.parse(raw.scannedAt))) return undefined;
  if (typeof raw.byType !== "object" || raw.byType === null || Array.isArray(raw.byType)) {
    return undefined;
  }
  const byType: Record<string, number> = {};
  for (const [key, count] of Object.entries(raw.byType as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count)) byType[key] = Math.max(0, count);
  }
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
  return {
    scannedAt: raw.scannedAt,
    totalFiles: num(raw.totalFiles),
    totalIssues: num(raw.totalIssues),
    affectedAttachments: num(raw.affectedAttachments),
    byType,
    reclaimableBytes: num(raw.reclaimableBytes),
    profileId: typeof raw.profileId === "string" ? raw.profileId : undefined,
  };
}

/** Either path separator, so a Windows-style entry is split too. */
const SEPARATORS = /[\\/]+/;
/** True when a user-typed folder path contains a `..` segment. */
function hasTraversalSegment(folder: string): boolean {
  return folder.split(SEPARATORS).some((segment) => segment.trim() === "..");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Run the raw blob through any pending migrations. The version is read from the
 * RAW object — never from a defaults-merged one, where a missing `version` would
 * silently inherit the current number and skip its own migration forever.
 */
export function migrateRawSettings(raw: RawSettings): { raw: RawSettings; fromVersion: number } {
  // Clamp to a non-negative integer: a fractional or negative version would miss
  // every `MIGRATIONS[version]` lookup and silently skip the whole chain. That is
  // harmless while the migrations are no-ops and would not be later.
  const rawVersion = raw.version;
  const fromVersion =
    typeof rawVersion === "number" && Number.isFinite(rawVersion)
      ? Math.max(0, Math.trunc(rawVersion))
      : 0;
  // A blob from a NEWER plugin version: leave it alone rather than mangling
  // fields we don't understand. The normalizer below still guards every read.
  if (fromVersion > SCHEMA_VERSION) return { raw, fromVersion };

  let current = raw;
  let version = fromVersion;
  while (version < SCHEMA_VERSION && MIGRATIONS[version]) {
    current = MIGRATIONS[version](current);
    const next = typeof current.version === "number" ? current.version : version + 1;
    if (next <= version) break; // a migration that didn't advance would loop forever
    version = next;
  }
  return { raw: current, fromVersion };
}

/**
 * Coerce a defaults-merged settings object into a valid one, in place. Every
 * field that can break a scan if malformed is validated here, not just checked
 * for array-ness.
 */
export function normalizeSettings(
  settings: AttachmentManagerSettings,
  defaults: AttachmentManagerSettings
): AttachmentManagerSettings {
  const s = settings as unknown as RawSettings;

  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(s[key])) s[key] = [];
  }
  // Only these two must be arrays of STRINGS — a number in junkNamePatterns
  // would throw inside `new RegExp` on every attachment.
  for (const key of ["junkNamePatterns", "attachmentExtensions", "excludedFolders", "excludedPaths", "ignoredIssueKeys", "reviewedIssueKeys"] as const) {
    if (!isStringArray(s[key])) {
      s[key] = (s[key] as unknown[]).filter((v): v is string => typeof v === "string");
    }
  }

  // The bug this exists for: a string here passed straight through, `new Set("unused")`
  // became {u,n,s,e,d}, every detector was disabled, and the scan reported a
  // clean vault. Its length was 6, so the "no detectors enabled" warning never fired.
  const validTypes = new Set<string>(ISSUE_TYPES);
  const enabled = Array.isArray(s.enabledIssueTypes)
    ? (s.enabledIssueTypes as unknown[]).filter((t): t is IssueType =>
        typeof t === "string" && validTypes.has(t)
      )
    : [];
  s.enabledIssueTypes = enabled.length > 0 ? enabled : [...defaults.enabledIssueTypes];

  if (typeof s.sortMode !== "string" || !SORT_MODES.includes(s.sortMode as SortMode)) {
    s.sortMode = defaults.sortMode;
  }

  s.largeSizeThresholdKb = clampNumber(s.largeSizeThresholdKb, defaults.largeSizeThresholdKb, 0, MAX_THRESHOLD_KB);
  s.duplicateMaxScanKb = clampNumber(s.duplicateMaxScanKb, defaults.duplicateMaxScanKb, 0, MAX_THRESHOLD_KB);
  s.singleTrashCount = clampNumber(s.singleTrashCount, 0, 0, Number.MAX_SAFE_INTEGER);
  s.reclaimedTotalBytes = clampNumber(s.reclaimedTotalBytes, 0, 0, Number.MAX_SAFE_INTEGER);

  if (typeof s.attachmentFolder !== "string") s.attachmentFolder = defaults.attachmentFolder;
  // This string becomes a `createFolder` argument and the parent of every move
  // target. `normalizePath` does not resolve `..`, so `../outside` would be
  // handed straight to the adapter. Whether a given adapter honours that is not
  // something to discover by shipping, and a folder setting has no legitimate
  // reason to contain a traversal segment — refuse one outright.
  if (hasTraversalSegment(s.attachmentFolder as string)) {
    s.attachmentFolder = defaults.attachmentFolder;
  }
  if (typeof s.licenseKey !== "string") s.licenseKey = "";

  const weights = (typeof s.severityWeights === "object" && s.severityWeights !== null
    ? s.severityWeights
    : {}) as Record<string, unknown>;
  const normalizedWeights: Record<string, number> = {};
  for (const type of ISSUE_TYPES) {
    normalizedWeights[type] = clampNumber(weights[type], defaults.severityWeights[type], 1, 5);
  }
  s.severityWeights = normalizedWeights;

  for (const flag of ["onboardingDismissed", "proCtaDismissed", "reviewAsked", "bulkTrialUsed"] as const) {
    if (typeof s[flag] !== "boolean") s[flag] = false;
  }
  // Defaults to ON, so it needs the default rather than `false` — a stray null
  // would otherwise disable previews with nothing in the UI to explain why.
  if (typeof s.showThumbnails !== "boolean") s.showThumbnails = defaults.showThumbnails;

  // The dashboard's hydrated (pre-first-scan) view only guards `!summary` and then
  // reads `summary.byType[type]`, so a partial `{}` — exactly what a truncated
  // write or a sync conflict produces — threw a TypeError inside render() on
  // startup and left the pane blank. Drop a summary we can't render.
  s.lastScanSummary = normalizeSummary(s.lastScanSummary);

  // The journal drives a RESTORE button, so a malformed batch is worse than a
  // missing one — it would offer an undo that fails halfway through.
  s.journalLimit = clampNumber(s.journalLimit, DEFAULT_JOURNAL_LIMIT, 0, MAX_JOURNAL_LIMIT);
  s.journal = normalizeJournal(s.journal, s.journalLimit as number);

  // Drop profiles and rules that lost their identity — they can't be edited or
  // deleted from the UI, so they'd be permanent junk — then validate what's LEFT.
  //
  // Checking only for an `id` is not enough: a surviving profile's fields go
  // straight into `ScanConfig`. A profile with `enabledIssueTypes: "unused"`
  // reintroduces the exact silent-no-op bug this file exists to prevent, and one
  // with `excludedFolders: "y"` crashes the scan on `.map(...)`.
  s.savedProfiles = (s.savedProfiles as unknown[])
    .filter(hasStringId)
    .map((p) => normalizeProfile(p as RawSettings, defaults));
  s.customRules = (s.customRules as unknown[])
    .filter(hasStringId)
    .map((r) => normalizeRule(r as RawSettings, defaults));

  // NEVER lower the recorded schema version. `migrateRawSettings` deliberately
  // leaves a blob written by a NEWER plugin untouched, and the loader skips the
  // immediate save for one — but stamping SCHEMA_VERSION here undid both as soon
  // as anything else triggered a save. A user who opened an older build once
  // would be left with future-schema data labelled as the old schema, and the
  // next launch of the newer build would re-run migrations over already-migrated
  // data. No migration past the current version exists yet, which is precisely
  // why this is worth closing now rather than after one does.
  const recorded =
    typeof settings.version === "number" && Number.isFinite(settings.version)
      ? Math.floor(settings.version)
      : 0;
  s.version = Math.max(SCHEMA_VERSION, recorded);
  return settings;
}
