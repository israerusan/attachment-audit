import assert from "node:assert";
import { MentionMatcher, fileNameVariants } from "../src/core/safety/mentionMatcher";

// Variants cover raw + percent-encoded (spaces, &, parens, non-ascii).
assert.deepStrictEqual(fileNameVariants("a b.png"), ["a b.png", "a%20b.png"]);
assert.deepStrictEqual(fileNameVariants("a&b.png"), ["a&b.png", "a%26b.png"]);
assert.deepStrictEqual(fileNameVariants("plain.png"), ["plain.png"]);
// Parentheses get a percent-encoded variant (encodeURIComponent leaves them literal).
assert.ok(fileNameVariants("chart (1).png").includes("chart%20%281%29.png"));
// Non-ASCII names get an NFC-normalized, percent-encoded variant.
assert.ok(fileNameVariants("café.png").includes("caf%c3%a9.png"));

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
