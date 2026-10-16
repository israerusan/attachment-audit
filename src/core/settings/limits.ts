// Shared numeric ceilings for size settings.
//
// These were previously written out as the bare literal `1024 * 1024 * 64` in
// four places — and in TWO DIFFERENT UNITS. `normalizeSettings` clamped
// `largeSizeThresholdKb` to that many KILOBYTES (64 GB) on load, while the
// settings tab clamped its MB input box to that many MEGABYTES and multiplied by
// 1024, admitting a value 1024x above the load-time clamp. Both sites carried a
// comment claiming they matched. Typing a huge number into the MB box therefore
// put a threshold into the live settings that no file could ever exceed — the
// `large` detector silently reported nothing for the rest of the session — and a
// restart then quietly changed the value out from under the user.
//
// One definition, derived, so the two units can never drift again.

/** Largest size threshold accepted, in KB (64 GB). Enforced on load AND in the UI. */
export const MAX_THRESHOLD_KB = 64 * 1024 * 1024;

/** The same ceiling expressed in MB (65,536 MB), for the MB-denominated inputs. */
export const MAX_THRESHOLD_MB = MAX_THRESHOLD_KB / 1024;
