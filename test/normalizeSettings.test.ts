import assert from "node:assert";
import {
  migrateRawSettings,
  normalizeSettings,
  SCHEMA_VERSION,
} from "../src/core/settings/normalize";
import { DEFAULT_SETTINGS } from "../src/core/settings/defaults";
import type { AttachmentManagerSettings } from "../src/types";

const defaults = (): AttachmentManagerSettings =>
  JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AttachmentManagerSettings;

const load = (raw: Record<string, unknown>): AttachmentManagerSettings => {
  const { raw: migrated } = migrateRawSettings(raw);
  return normalizeSettings(Object.assign(defaults(), migrated), DEFAULT_SETTINGS);
};

// --- The bug this module exists for -----------------------------------------
// A corrupted `enabledIssueTypes` string used to pass straight through:
// `new Set("unused")` became {u,n,s,e,d}, every detector was disabled, and the
// scan reported "0 issues" — which reads as "my vault is clean", not "broken".
// Its length was 6, so the "no detectors enabled" warning never fired either.
const corrupted = load({ enabledIssueTypes: "unused" });
assert.deepStrictEqual(
  corrupted.enabledIssueTypes,
  DEFAULT_SETTINGS.enabledIssueTypes,
  "a non-array falls back to the defaults rather than disabling every detector"
);

// Unknown entries are dropped, known ones kept.
assert.deepStrictEqual(
  load({ enabledIssueTypes: ["unused", "nonsense", 42, "large"] }).enabledIssueTypes,
  ["unused", "large"]
);
// An array that filters down to nothing falls back rather than silently scanning nothing.
assert.deepStrictEqual(
  load({ enabledIssueTypes: ["nope"] }).enabledIssueTypes,
  DEFAULT_SETTINGS.enabledIssueTypes
);

// --- sortMode was previously unvalidated ------------------------------------
// A corrupt value flowed into sortIssues and silently fell through to path sort.
assert.strictEqual(load({ sortMode: "bogus" }).sortMode, DEFAULT_SETTINGS.sortMode);
assert.strictEqual(load({ sortMode: 7 }).sortMode, DEFAULT_SETTINGS.sortMode);
assert.strictEqual(load({ sortMode: "size" }).sortMode, "size");

// --- Array coercion ---------------------------------------------------------
for (const key of ["junkNamePatterns", "excludedFolders", "excludedPaths", "customRules"] as const) {
  assert.ok(Array.isArray(load({ [key]: "not an array" })[key]), `${key} coerced to an array`);
  assert.ok(Array.isArray(load({ [key]: null })[key]), `${key} null coerced to an array`);
}
// Non-string elements are filtered out of string arrays — a number in
// junkNamePatterns would throw inside `new RegExp` once per attachment.
assert.deepStrictEqual(load({ junkNamePatterns: ["^ok$", 5, null, "^also$"] }).junkNamePatterns, [
  "^ok$",
  "^also$",
]);

// --- Numeric clamping -------------------------------------------------------
assert.strictEqual(load({ largeSizeThresholdKb: -50 }).largeSizeThresholdKb, 0);
assert.strictEqual(
  load({ largeSizeThresholdKb: "big" }).largeSizeThresholdKb,
  DEFAULT_SETTINGS.largeSizeThresholdKb
);
assert.strictEqual(
  load({ duplicateMaxScanKb: NaN }).duplicateMaxScanKb,
  DEFAULT_SETTINGS.duplicateMaxScanKb
);
assert.strictEqual(load({ duplicateMaxScanKb: 0 }).duplicateMaxScanKb, 0, "0 is meaningful (disables hashing)");
assert.strictEqual(load({ singleTrashCount: -3 }).singleTrashCount, 0);

// --- Severity weights -------------------------------------------------------
const weights = load({ severityWeights: { unused: 99, large: "x" } }).severityWeights;
assert.strictEqual(weights.unused, 5, "clamped to the 1-5 range");
assert.strictEqual(weights.large, DEFAULT_SETTINGS.severityWeights.large);
assert.strictEqual(weights.missing, DEFAULT_SETTINGS.severityWeights.missing, "new key gets its default");
assert.strictEqual(load({ severityWeights: "nope" }).severityWeights.unused, DEFAULT_SETTINGS.severityWeights.unused);

// --- Booleans ---------------------------------------------------------------
assert.strictEqual(load({ onboardingDismissed: "yes" }).onboardingDismissed, false);
assert.strictEqual(load({ bulkTrialUsed: 1 }).bulkTrialUsed, false);
assert.strictEqual(load({ proCtaDismissed: true }).proCtaDismissed, true);

// --- Identity-less profiles and rules are dropped ---------------------------
// They could not be edited or deleted from the UI, so they'd be permanent junk.
const junk = load({
  savedProfiles: [{ id: "p1", name: "Keep" }, { name: "No id" }, null, "nope"],
  customRules: [{ id: "r1" }, {}, 5],
});
assert.strictEqual(junk.savedProfiles.length, 1);
assert.strictEqual(junk.customRules.length, 1);

// --- Migration --------------------------------------------------------------
// The version MUST be read from the raw blob. A pre-versioned blob merged with
// defaults first would inherit the current number and skip its migration forever.
const preVersioned = migrateRawSettings({ attachmentFolder: "assets" });
assert.strictEqual(preVersioned.fromVersion, 0, "a missing version reads as 0, not as the default");
assert.strictEqual(preVersioned.raw.version, SCHEMA_VERSION);

assert.strictEqual(migrateRawSettings({ version: 1 }).fromVersion, 1);
assert.strictEqual(migrateRawSettings({ version: 1 }).raw.version, SCHEMA_VERSION);
// Already current: no-op.
assert.strictEqual(migrateRawSettings({ version: SCHEMA_VERSION }).raw.version, SCHEMA_VERSION);

// A blob from a NEWER plugin version is left untouched rather than mangled — a
// user who rolled back must not have their newer settings silently rewritten.
const future = migrateRawSettings({ version: SCHEMA_VERSION + 5, mystery: true });
assert.strictEqual(future.fromVersion, SCHEMA_VERSION + 5);
assert.strictEqual(future.raw.mystery, true);
assert.strictEqual(future.raw.version, SCHEMA_VERSION + 5, "not downgraded in place");

// --- A totally empty blob yields usable defaults ----------------------------
const empty = load({});
assert.deepStrictEqual(empty.enabledIssueTypes, DEFAULT_SETTINGS.enabledIssueTypes);
assert.strictEqual(empty.version, SCHEMA_VERSION);
assert.strictEqual(empty.licenseKey, "");

console.log("normalizeSettings tests passed");

// --- Profile CONTENTS must be validated, not just their id ------------------
// A surviving profile's fields go straight into ScanConfig. Checking only for an
// `id` reintroduced the exact silent-no-op bug this module exists to prevent.
{
  const s = load({
    savedProfiles: [
      { id: "p1", name: "Bad", enabledIssueTypes: "unused", excludedFolders: "y" },
    ],
  });
  const p = s.savedProfiles[0];
  assert.ok(Array.isArray(p.enabledIssueTypes), "a string override is not passed through");
  assert.deepStrictEqual(
    p.enabledIssueTypes,
    DEFAULT_SETTINGS.enabledIssueTypes,
    "an unusable override falls back rather than disabling every detector"
  );
  // `excludedFolders: "y"` previously reached `config.excludedFolders.map(...)`
  // and crashed every scan with a TypeError.
  assert.ok(Array.isArray(p.excludedFolders));
  assert.ok(Array.isArray(p.includedFolders));
}

// Unknown issue types inside a profile are filtered, valid ones kept.
assert.deepStrictEqual(
  load({ savedProfiles: [{ id: "p", enabledIssueTypes: ["large", "bogus", 3] }] })
    .savedProfiles[0].enabledIssueTypes,
  ["large"]
);

// A nameless profile still gets something selectable in the dropdown.
assert.strictEqual(load({ savedProfiles: [{ id: "p" }] }).savedProfiles[0].name, "Untitled profile");

// A hostile sortMode inside a profile is dropped, a valid one kept.
assert.strictEqual(load({ savedProfiles: [{ id: "p", sortMode: "junk" }] }).savedProfiles[0].sortMode, undefined);
assert.strictEqual(load({ savedProfiles: [{ id: "p", sortMode: "size" }] }).savedProfiles[0].sortMode, "size");

// --- Custom rule contents ---------------------------------------------------
{
  const rules = load({
    customRules: [
      { id: "r1", condition: { type: "nonsense" }, severity: 99, scope: "bad" },
      { id: "r2", condition: { type: "name-matches", pattern: { evil: true } } },
      { id: "r3", condition: "not an object" },
    ],
  }).customRules;
  assert.strictEqual(rules.length, 3);
  // An unrecognised condition type would fall through the engine's switch and
  // return undefined; it is replaced with something inert and valid.
  assert.ok(["larger-than-kb"].includes(rules[0].condition.type));
  assert.strictEqual(rules[0].severity, 5, "severity clamped into 1-5");
  assert.ok(Array.isArray(rules[0].scope.folders), "a non-object scope still yields a folder array");
  // A non-string pattern must not become the literal "[object Object]".
  const r2 = rules[1].condition;
  assert.strictEqual(r2.type, "name-matches");
  assert.strictEqual(r2.type === "name-matches" ? r2.pattern : null, "");
  assert.ok(typeof rules[2].condition.type === "string");
}

// --- showThumbnails defaults ON, so a bad value must restore the default -----
assert.strictEqual(load({ showThumbnails: null }).showThumbnails, true);
assert.strictEqual(load({ showThumbnails: "no" }).showThumbnails, true);
assert.strictEqual(load({ showThumbnails: false }).showThumbnails, false);

// --- Version clamping -------------------------------------------------------
// A fractional or negative version missed every MIGRATIONS lookup and silently
// skipped the whole chain.
assert.strictEqual(migrateRawSettings({ version: -5 }).fromVersion, 0);
assert.strictEqual(migrateRawSettings({ version: 1.5 }).fromVersion, 1);
assert.strictEqual(migrateRawSettings({ version: -5 }).raw.version, SCHEMA_VERSION);
assert.strictEqual(migrateRawSettings({ version: NaN }).fromVersion, 0);
assert.strictEqual(migrateRawSettings({ version: Infinity }).fromVersion, 0);

// --- Nothing throws on hostile input ----------------------------------------
for (const hostile of [
  { savedProfiles: "hello" },
  { customRules: 5 },
  { severityWeights: [1, 2, 3] },
  { enabledIssueTypes: { a: 1 } },
  { savedProfiles: [null, undefined, 3, "x", []] },
  { customRules: [{ id: "r", scope: null, condition: null }] },
]) {
  assert.doesNotThrow(() => load(hostile as Record<string, unknown>), JSON.stringify(hostile));
}

console.log("normalizeSettings profile/rule validation tests passed");

// --- lastScanSummary must be renderable or absent ---------------------------
// The dashboard's pre-first-scan view only guards `!summary`, then reads
// `summary.byType[type]`. A partial `{}` — what a truncated write or a sync
// conflict produces — threw a TypeError inside render() on startup and left the
// pane blank. Dropping it falls back to the clean "no scan yet" state.
assert.strictEqual(load({ lastScanSummary: {} }).lastScanSummary, undefined);
assert.strictEqual(load({ lastScanSummary: null }).lastScanSummary, undefined);
assert.strictEqual(load({ lastScanSummary: "nope" }).lastScanSummary, undefined);
assert.strictEqual(load({ lastScanSummary: { scannedAt: "not a date" } }).lastScanSummary, undefined);
assert.strictEqual(
  load({ lastScanSummary: { scannedAt: new Date().toISOString(), byType: "bad" } }).lastScanSummary,
  undefined,
  "a non-object byType is unrenderable"
);
assert.strictEqual(
  load({ lastScanSummary: { scannedAt: new Date().toISOString(), byType: [] } }).lastScanSummary,
  undefined,
  "an array byType is unrenderable"
);

// A well-formed summary survives, with junk counts filtered and numbers coerced.
{
  const at = new Date().toISOString();
  const summary = load({
    lastScanSummary: {
      scannedAt: at,
      byType: { unused: 3, large: "x", missing: 2 },
      totalFiles: "many",
      reclaimableBytes: -5,
    },
  }).lastScanSummary;
  assert.ok(summary, "a valid summary is kept");
  assert.strictEqual(summary.scannedAt, at);
  assert.deepStrictEqual(summary.byType, { unused: 3, missing: 2 }, "non-numeric counts dropped");
  assert.strictEqual(summary.totalFiles, 0, "unusable numbers become 0");
  assert.strictEqual(summary.reclaimableBytes, 0, "negatives clamped");
}

// --- Profile thresholds get the SAME upper clamp as the top level -----------
// Without it, 1e300 survived into ScanConfig and the `large` detector silently
// never fired for that profile.
{
  const p = load({ savedProfiles: [{ id: "p", largeSizeThresholdKb: 1e300 }] }).savedProfiles[0];
  assert.ok(
    p.largeSizeThresholdKb !== undefined && p.largeSizeThresholdKb <= 1024 * 1024 * 64,
    "profile threshold is clamped"
  );
}

console.log("normalizeSettings summary/clamp tests passed");
