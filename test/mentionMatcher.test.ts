import assert from "node:assert";
import { MentionMatcher, fileNameVariants } from "../src/core/safety/mentionMatcher";

// Variants cover raw + percent-encoded (spaces, &, parens, non-ascii).
assert.deepStrictEqual(fileNameVariants("a b.png"), ["a b.png", "a%20b.png"]);
// `&` also gets its HTML-entity form — pasted web markup writes `a&amp;b.png`.
assert.deepStrictEqual(fileNameVariants("a&b.png"), ["a&b.png", "a&amp;b.png", "a%26b.png"]);
// A pure-ASCII name with no specials stays a SINGLE pattern (keeps the trie small).
assert.deepStrictEqual(fileNameVariants("plain.png"), ["plain.png"]);
// Parentheses get a percent-encoded variant (encodeURIComponent leaves them literal).
assert.ok(fileNameVariants("chart (1).png").includes("chart%20%281%29.png"));
// Non-ASCII names get an NFC-normalized, percent-encoded variant.
assert.ok(fileNameVariants("café.png").includes("caf%c3%a9.png"));

// --- Unicode normalization -------------------------------------------------
// The scan no longer normalizes the (huge) source text, so BOTH composed and
// decomposed forms must be emitted as patterns. A miss here means a live file is
// reported unused and trashed.
const cafeNFC = "café.png"; // é as one code point
const cafeNFD = "café.png"; // e + combining acute
// Guard the guard: if an editor ever normalizes this file, the two literals above
// collapse into one string and every assertion below would pass vacuously.
assert.notStrictEqual(cafeNFC, cafeNFD, "the two literals really are different strings");
const nfcVariants = fileNameVariants(cafeNFC);
assert.ok(nfcVariants.includes(cafeNFC), "composed form is a pattern");
assert.ok(nfcVariants.includes(cafeNFD), "decomposed form is a pattern");
// ...and their percent-encoded forms differ entirely, so both must be present.
assert.ok(nfcVariants.includes("caf%c3%a9.png"), "percent-encoded NFC");
assert.ok(nfcVariants.includes("cafe%cc%81.png"), "percent-encoded NFD");
// Starting from the decomposed name yields the same set.
const nfdVariants = fileNameVariants(cafeNFD);
assert.ok(nfdVariants.includes(cafeNFC) && nfdVariants.includes(cafeNFD));

// An NFD-percent-encoded reference in raw HTML must match an NFC filename.
const mUni = new MentionMatcher();
for (const v of fileNameVariants(cafeNFC)) mUni.addPattern(v, 0);
mUni.build();
const hUni = new Set<number>();
mUni.scanInto('<img src="pics/cafe%CC%81.png">'.toLowerCase(), hUni);
assert.ok(hUni.has(0), "percent-encoded NFD reference suppresses the unused flag");

// A literal decomposed reference must match too, without normalizing the text.
const hUni2 = new Set<number>();
mUni.scanInto(`see ${cafeNFD}`.toLowerCase(), hUni2);
assert.ok(hUni2.has(0), "literal NFD reference suppresses the unused flag");

// An HTML-entity-escaped reference must match a name containing `&`.
const mAmp = new MentionMatcher();
for (const v of fileNameVariants("a&b.png")) mAmp.addPattern(v, 0);
mAmp.build();
const hAmp = new Set<number>();
mAmp.scanInto('<img src="a&amp;b.png">'.toLowerCase(), hAmp);
assert.ok(hAmp.has(0), "HTML-entity reference suppresses the unused flag");

// --- build() idempotency ----------------------------------------------------
// Re-merging fail-link outputs into already-merged arrays would grow them
// multiplicatively; a second build() must be a no-op.
const mIdem = new MentionMatcher();
mIdem.addPattern("cat.png", 0);
mIdem.addPattern("at.png", 1);
mIdem.build();
mIdem.build();
mIdem.build();
const hIdem = new Set<number>();
mIdem.scanInto("cat.png", hIdem);
assert.strictEqual(hIdem.size, 2, "repeated build() still reports exactly both owners");

// --- non-ASCII transitions at the root --------------------------------------
// The root has a dense ASCII fast path; characters outside it must still match.
const mWide = new MentionMatcher();
mWide.addPattern("日本語.png", 0);
mWide.build();
const hWide = new Set<number>();
mWide.scanInto("embed 日本語.png here", hWide);
assert.ok(hWide.has(0), "non-ASCII pattern matches through the Map fallback");

// Aho-Corasick finds every owner whose pattern occurs anywhere in a source text.
const m = new MentionMatcher();
m.addPattern("logo.png", 0);
m.addPattern("a%26b.png", 1); // encoded form owned by candidate 1
m.addPattern("unused.png", 2);
m.build();

const hits = new Set<number>();
m.scanInto('see ![[assets/logo.png]] and <img src="a%26b.png">'.toLowerCase(), hits);
assert.ok(hits.has(0), "logo.png matched");
assert.ok(hits.has(1), "encoded a%26b.png matched");
assert.ok(!hits.has(2), "unused.png not matched");

// Overlapping/adjacent patterns and repeated scans accumulate into the same set.
const m2 = new MentionMatcher();
m2.addPattern("cat.png", 0);
m2.addPattern("at.png", 1); // suffix overlaps with cat.png via fail links
m2.build();
const h2 = new Set<number>();
m2.scanInto("cat.png", h2);
assert.ok(h2.has(0) && h2.has(1), "fail-link output (at.png inside cat.png) is reported");

// Adding a pattern AFTER build() must not silently miss matches (auto-rebuild).
const m3 = new MentionMatcher();
m3.addPattern("cat.png", 0);
m3.build();
m3.addPattern("at.png", 1);
const h3 = new Set<number>();
m3.scanInto("cat.png", h3);
assert.ok(h3.has(0) && h3.has(1), "pattern added after build() is still matched");

// Conservative substring safety: a candidate that is a SUFFIX of a referenced
// name must ALSO be reported mentioned (over-suppression is intentional — it
// biases toward never trashing a file that might still be referenced).
const m4 = new MentionMatcher();
m4.addPattern("a.png", 0);
m4.addPattern("data.png", 1);
m4.build();
const h4 = new Set<number>();
m4.scanInto("see data.png", h4);
assert.ok(h4.has(0) && h4.has(1), "suffix candidate a.png is reported for data.png");

console.log("mentionMatcher tests passed");

// --- Repeated build() must neither compound nor lose patterns ---------------
// `addPattern` clears the built flag so a late pattern gets wired, which defeats
// a naive `if (built) return` guard: re-merging already-merged fail-link outputs
// grew them multiplicatively (36 -> 157 -> 2570 -> 149851 over six rebuilds,
// then a RangeError). Rebuilding from each node's OWN ids fixes that — but must
// not drop the late pattern in the process.
{
  const m = new MentionMatcher();
  m.addPattern("cat.png", 0);
  m.build();
  m.addPattern("at.png", 1); // shares a suffix -> reached via fail links
  m.build();
  m.addPattern("t.png", 2);
  m.build();
  m.build();
  m.build();

  const hits = new Set<number>();
  m.scanInto("cat.png", hits);
  assert.ok(hits.has(0) && hits.has(1) && hits.has(2), "every pattern still matches after rebuilds");
  assert.strictEqual(hits.size, 3, "and exactly those");

  // Rebuilding many more times must stay stable rather than exploding.
  for (let i = 0; i < 25; i++) m.build();
  const again = new Set<number>();
  m.scanInto("cat.png", again);
  assert.strictEqual(again.size, 3, "25 further rebuilds change nothing");
}

// --- Differential check against a naive oracle ------------------------------
// The automaton must agree with plain `String.includes` for every pattern.
{
  const alphabets = ["ab", "abc", "aA1.-", "日本語", "café"];
  let checked = 0;
  let seed = 12345;
  const rnd = (n: number): number => {
    // xorshift32 via Math.imul — deterministic (so a failure is reproducible) and
    // integer-safe. A plain LCG here overflowed 2^53 and degenerated.
    seed ^= seed << 13;
    seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    return Math.abs(seed) % n;
  };
  for (let trial = 0; trial < 3000; trial++) {
    const alpha = alphabets[rnd(alphabets.length)];
    const patterns: string[] = [];
    const count = 1 + rnd(4);
    for (let p = 0; p < count; p++) {
      let s = "";
      const len = 1 + rnd(5);
      for (let k = 0; k < len; k++) s += alpha[rnd(alpha.length)];
      patterns.push(s.toLowerCase());
    }
    let text = "";
    const tlen = rnd(30);
    for (let k = 0; k < tlen; k++) text += alpha[rnd(alpha.length)];
    text = text.toLowerCase();

    const m = new MentionMatcher();
    patterns.forEach((p, i) => m.addPattern(p, i));
    if (rnd(2) === 0) m.build(); // sometimes build early, then rebuild
    m.build();

    const got = new Set<number>();
    m.scanInto(text, got);
    for (let i = 0; i < patterns.length; i++) {
      const expected = patterns[i].length > 0 && text.includes(patterns[i]);
      assert.strictEqual(
        got.has(i),
        expected,
        `mismatch: pattern ${JSON.stringify(patterns[i])} in ${JSON.stringify(text)}`
      );
      checked++;
    }
  }
  assert.ok(checked > 5000, "the differential sweep actually ran");
}

console.log("mentionMatcher rebuild + differential tests passed");
