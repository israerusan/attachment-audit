import assert from "node:assert";
import { sanitizeBaseName } from "../src/core/naming/sanitizeName";

const ok = (input: string): string | null => sanitizeBaseName(input).name;

// --- Ordinary names pass through unchanged ----------------------------------
assert.strictEqual(ok("holiday photo"), "holiday photo");
assert.strictEqual(ok("  trimmed  "), "trimmed");
assert.strictEqual(ok("café ☕ 日本語"), "café ☕ 日本語", "unicode is preserved");
assert.strictEqual(ok("report-2026_final.v2"), "report-2026_final.v2");

// --- Illegal path characters are stripped -----------------------------------
assert.strictEqual(ok('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij");

// --- Control characters are stripped ----------------------------------------
assert.strictEqual(ok("ab\u0000\u0001\u001Fcd"), "abcd");
assert.strictEqual(ok("ab\u007Fcd"), "abcd", "DEL is stripped too");
assert.strictEqual(ok("line\nbreak"), "linebreak");

// --- Trailing dots and spaces --------------------------------------------
// Windows silently drops these, which would leave Obsidian's index pointing at a
// path that does not exist on disk.
assert.strictEqual(ok("photo..."), "photo");
assert.strictEqual(ok("photo   "), "photo");
assert.strictEqual(ok("photo. . ."), "photo");
assert.strictEqual(ok("...leading is fine"), "...leading is fine");

// --- Reserved Windows device names ------------------------------------------
for (const reserved of ["con", "CON", "prn", "aux", "nul", "com1", "COM9", "lpt3"]) {
  assert.strictEqual(ok(reserved), null, `${reserved} must be rejected`);
}
// Reserved with ANY extension — `nul.old` still resolves to the NUL device, and
// the old check (which tested the whole string) let this through.
assert.strictEqual(ok("nul.old"), null);
assert.strictEqual(ok("con.backup.2026"), null);
assert.strictEqual(ok("CONOUT$"), null);
// ...but a name that merely STARTS with one is fine.
assert.strictEqual(ok("console"), "console");
assert.strictEqual(ok("nullify"), "nullify");
assert.strictEqual(ok("com10"), "com10", "only com1-com9 are reserved");

// --- Nothing usable left ----------------------------------------------------
assert.strictEqual(ok(""), null);
assert.strictEqual(ok("   "), null);
assert.strictEqual(ok("///"), null);
assert.strictEqual(ok("..."), null);
assert.strictEqual(ok("\u0001\u0002"), null);

// --- Length cap -------------------------------------------------------------
assert.strictEqual(ok("a".repeat(200)), "a".repeat(200));
assert.strictEqual(ok("a".repeat(201)), null);

// --- Every rejection explains itself ----------------------------------------
for (const bad of ["", "nul", "a".repeat(500)]) {
  const verdict = sanitizeBaseName(bad);
  assert.strictEqual(verdict.name, null);
  assert.ok(verdict.reason && verdict.reason.length > 0, `rejection of "${bad}" carries a reason`);
}

console.log("sanitizeName tests passed");
