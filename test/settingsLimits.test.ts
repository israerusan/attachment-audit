import assert from "node:assert";
import { MAX_THRESHOLD_KB, MAX_THRESHOLD_MB } from "../src/core/settings/limits";
import { normalizeSettings } from "../src/core/settings/normalize";
import { DEFAULT_SETTINGS } from "../src/core/settings/defaults";

// The two ceilings used to be the same literal `1024 * 1024 * 64` written out in
// four places, in TWO DIFFERENT UNITS — clamped as KILOBYTES on load, and as
// MEGABYTES in the settings tab, which then multiplied by 1024. Both sites carried
// a comment claiming they matched. The consequence was not cosmetic: a large value
// typed into the MB box produced a threshold no file could exceed, so the `large`
// detector silently reported nothing for the rest of the session, and a restart
// then changed the value out from under the user.
//
// The invariant is that the UI ceiling SURVIVES a load unchanged. Assert that
// rather than re-asserting the constants.

assert.strictEqual(MAX_THRESHOLD_MB * 1024, MAX_THRESHOLD_KB, "the two units must agree");

const norm = (over: Record<string, unknown>): Record<string, unknown> =>
  normalizeSettings(
    structuredClone({ ...DEFAULT_SETTINGS, ...over }) as never,
    DEFAULT_SETTINGS
  ) as unknown as Record<string, unknown>;

// The largest value the MB box accepts, converted the way the settings tab does.
const fromUiBox = Math.round(MAX_THRESHOLD_MB * 1024);
assert.strictEqual(
  norm({ largeSizeThresholdKb: fromUiBox }).largeSizeThresholdKb,
  fromUiBox,
  "a value at the UI ceiling must round-trip through a load unchanged"
);
assert.strictEqual(
  norm({ duplicateMaxScanKb: fromUiBox }).duplicateMaxScanKb,
  fromUiBox,
  "and so must the duplicate cap"
);

// Above the ceiling, the load still clamps — that behaviour is the point.
assert.strictEqual(
  norm({ largeSizeThresholdKb: 1e300 }).largeSizeThresholdKb,
  MAX_THRESHOLD_KB,
  "an absurd value is clamped, not carried into ScanConfig"
);
assert.strictEqual(norm({ largeSizeThresholdKb: -5 }).largeSizeThresholdKb, 0);
assert.strictEqual(
  norm({ largeSizeThresholdKb: Number.NaN }).largeSizeThresholdKb,
  DEFAULT_SETTINGS.largeSizeThresholdKb,
  "NaN falls back to the default rather than to zero"
);

// A profile override gets the same ceiling as the top-level field.
{
  const s = norm({
    savedProfiles: [{ id: "p1", name: "p", largeSizeThresholdKb: fromUiBox }],
  });
  const profiles = s.savedProfiles as { largeSizeThresholdKb?: number }[];
  assert.strictEqual(profiles[0].largeSizeThresholdKb, fromUiBox);
}

console.log("settingsLimits tests passed");
