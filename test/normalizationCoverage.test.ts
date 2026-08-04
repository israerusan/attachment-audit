import assert from "node:assert";
import { MentionMatcher, fileNameVariants } from "../src/core/safety/mentionMatcher";

// The scan only calls `normalize()` on source text that contains non-ASCII, to
// avoid normalizing megabytes of plain English notes. This test pins the property
// that makes that safe: normalization can never change ASCII-only text, so
// "contains non-ASCII" is a strict superset of "might not be NFC".
//
// An earlier version tested for specific COMBINING MARK ranges instead. A sweep
// of the BMP and SMP found 12,366 composable code points — every Hangul syllable
// plus much of Devanagari, Bengali and Gurmukhi — whose decomposition contains no
// character in any of those ranges. Their partially-composed text would have
// skipped normalization and failed to match, and the file would have been
// reported unused.
for (let c = 0x00; c <= 0x7f; c++) {
  const s = String.fromCodePoint(c);
  assert.strictEqual(s.normalize("NFC"), s, `U+${c.toString(16)} changes under NFC`);
  assert.strictEqual(s.normalize("NFD"), s, `U+${c.toString(16)} changes under NFD`);
}

// Mirror of the scan's rule (kept in sync with `needsNormalization`).
const hasNonAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return true;
  return false;
};
const searchable = (text: string): string =>
  (hasNonAscii(text) ? text.normalize("NFC") : text).toLowerCase();

function matches(fileName: string, sourceText: string): boolean {
  const m = new MentionMatcher();
  for (const v of fileNameVariants(fileName)) m.addPattern(v, 0);
  m.build();
  const hits = new Set<number>();
  m.scanInto(searchable(sourceText), hits);
  return hits.has(0);
}

// Scripts the old range list did NOT cover. Each is a real filename embedded in a
// note whose text is in the opposite normal form.
const SCRIPTS: [label: string, name: string][] = [
  ["Hangul", "한글 문서.png"],
  ["Japanese voiced mark", "ガイド.png"],
  ["Devanagari", "नोऩ.png"],
  ["Bengali", "ছবি.png"],
  ["Gurmukhi", "ਲੱਖ.png"],
  ["Vietnamese", "tiếng việt.png"],
  ["Latin accents", "café ångström.png"],
];

for (const [label, name] of SCRIPTS) {
  const nfc = name.normalize("NFC");
  const nfd = name.normalize("NFD");
  // A composed filename referenced by decomposed text, and vice versa.
  assert.ok(matches(nfc, `see ![[${nfd}]] here`), `${label}: NFC name, NFD reference`);
  assert.ok(matches(nfd, `see ![[${nfc}]] here`), `${label}: NFD name, NFC reference`);
  assert.ok(matches(nfc, `see ![[${nfc}]] here`), `${label}: same form`);
}

// The partially-composed case: neither NFC nor NFD. `ê` (U+00EA) + combining
// acute — the normal output of several Vietnamese input methods.
const partial = "cafế.png";
assert.notStrictEqual(partial, partial.normalize("NFC"), "the fixture really is partially composed");
assert.notStrictEqual(partial, partial.normalize("NFD"), "and is not fully decomposed either");
assert.ok(
  matches(partial.normalize("NFC"), `<img src="${partial}">`),
  "partially-composed source text still matches the filename"
);

// ASCII text must NOT be normalized unnecessarily — the fast path is the whole
// point, and it must still match.
assert.ok(!hasNonAscii("plain ascii note with image.png"), "ASCII takes the fast path");
assert.ok(matches("image.png", "plain ascii note with image.png"));

console.log("normalizationCoverage tests passed");
