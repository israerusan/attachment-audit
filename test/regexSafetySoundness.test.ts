import assert from "node:assert";
import { checkRegexSafety } from "../src/core/rules/regexSafety";

// A PROPERTY test for the screen's core claim, rather than more examples.
//
// `checkRegexSafety` accepts a repeated alternation like `^(?:A|B)+$` only when it
// has proved A and B disjoint — that no string can be consumed by both. If that
// proof is ever wrong, the engine sees `(X|X)+` and backtracks exponentially,
// which is an unrecoverable UI freeze that survives restart.
//
// Five separate rounds of review found five different ways the proof was unsound
// (optional atoms, `{0}` erasure, `(?:` mis-parsing, in-class escapes, negated
// shorthands, escaped range endpoints). Every one was a case-by-case bug in a
// hand-written partial regex model, and every one was found by someone checking
// the INVARIANT rather than the cases. So check the invariant here.

const BACKSLASH = String.fromCharCode(92);
assert.strictEqual(BACKSLASH.charCodeAt(0), 92, "fixture integrity: backslash survived editing");

/** Characters an attachment name might plausibly contain, plus known trouble. */
const CORPUS: string[] = [
  ..."abcXYZ019_-. ()[]{}+*?^$|/",
  BACKSLASH,
  "\t",
  " ", // non-breaking space: matched by \s but not ASCII
  "é",
  "É",
  "ı",
  "ſ",
  "σ",
  "ς",
  "и",
  "–", // en dash
  "日",
  "́", // combining acute
];

/** Reduced corpus for the two-character sweep, kept small enough to be quadratic. */
const PAIR_CORPUS = ["a", "b", "A", "0", "9", "-", ".", BACKSLASH, "é", " ", "日"];

/** Every branch of a top-level alternation inside a single leading group. */
function splitBranches(pattern: string): string[] | null {
  const open = pattern.indexOf("(");
  if (open === -1) return null;
  let bodyStart = open + 1;
  const prefix = /^\((\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))/.exec(pattern.slice(open));
  if (prefix) bodyStart = open + 1 + prefix[1].length;

  const branches: string[] = [];
  let depth = 0;
  let cls = false;
  let esc = false;
  let from = bodyStart;
  for (let i = bodyStart; i < pattern.length; i++) {
    const c = pattern[i];
    if (esc) { esc = false; continue; }
    if (c === BACKSLASH) { esc = true; continue; }
    if (cls) { if (c === "]") cls = false; continue; }
    if (c === "[") { cls = true; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") {
      if (depth === 0) {
        branches.push(pattern.slice(from, i));
        return branches.length > 1 ? branches : null;
      }
      depth--;
      continue;
    }
    if (c === "|" && depth === 0) {
      branches.push(pattern.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

/**
 * True when both branches can match the same string. Tries every single
 * character in the corpus, then every two-character combination over a reduced
 * corpus — a multi-atom branch can overlap another only on a longer string, and
 * checking one character would miss it.
 */
function branchesOverlap(a: string, b: string): boolean {
  let reA: RegExp;
  let reB: RegExp;
  try {
    // Anchored so we test what the branch itself consumes, with the `i` flag both
    // production callers compile with.
    reA = new RegExp("^(?:" + a + ")$", "i");
    reB = new RegExp("^(?:" + b + ")$", "i");
  } catch {
    return false; // not independently compilable — not a claim the screen made
  }
  const bothMatch = (s: string): boolean => {
    try {
      return reA.test(s) && reB.test(s);
    } catch {
      return false;
    }
  };
  for (const ch of CORPUS) if (bothMatch(ch)) return true;
  for (const x of PAIR_CORPUS) {
    for (const y of PAIR_CORPUS) if (bothMatch(x + y)) return true;
  }
  return false;
}

// --- The detector must actually detect ---------------------------------------
// A soundness sweep that cannot recognise an overlap would pass vacuously and be
// worse than no test at all. Pin it against the exact pairs that five rounds of
// review found, each of which the screen once wrongly proved disjoint.
assert.ok(branchesOverlap("0", "[" + BACKSLASH + ".-o]"), "escaped range endpoint overlaps");
assert.ok(branchesOverlap("A", "[" + BACKSLASH + "x41]"), "in-class hex escape is A, not x");
assert.ok(branchesOverlap("é", BACKSLASH + "S"), "negated shorthands match non-ASCII");
assert.ok(branchesOverlap("é", BACKSLASH + "W"));
assert.ok(branchesOverlap(" ", BACKSLASH + "s"), "\\s includes U+00A0");
assert.ok(branchesOverlap("a", "A"), "the i flag makes these one branch");
assert.ok(branchesOverlap("é", "É"));
assert.ok(branchesOverlap("a", "[a-z]"));
// A shorthand misaligns item boundaries, and the reversed range that follows
// contributes nothing — so the model dropped `a` while the engine still matches it.
assert.ok(branchesOverlap("a", "[" + BACKSLASH + "d-a-0]"), "reversed range after a shorthand");
assert.ok(branchesOverlap("é", "[" + BACKSLASH + "w-é-0]"));
// Two-character overlap: single-character probing alone would miss this.
assert.ok(branchesOverlap("ab", "[a-z][a-z]"), "multi-atom branches overlap on 2 chars");
assert.ok(!branchesOverlap("ab", "[0-9][0-9]"));
// ...and must NOT cry wolf on genuinely disjoint branches.
assert.ok(!branchesOverlap("a", "b"));
assert.ok(!branchesOverlap(BACKSLASH + "w", "-"), "\\w does not match a hyphen");
assert.ok(!branchesOverlap("[a-m]", "[n-z]"));
// An ESCAPED dot is a literal; a bare `.` is "any character" and DOES match a
// digit, so only the escaped form is disjoint from \d.
assert.ok(!branchesOverlap(BACKSLASH + "d", BACKSLASH + "."), "\\d vs a literal dot");
assert.ok(branchesOverlap(BACKSLASH + "d", "."), "\\d vs ANY character overlaps");

// Deterministic xorshift32 — an LCG overflows 2^53 here and degenerates.
let seed = 0x2f6e2b1;
function rnd(n: number): number {
  seed ^= seed << 13; seed |= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed |= 0;
  return Math.abs(seed) % n;
}

/**
 * Atoms chosen to include every shape that has previously broken the model, PLUS
 * plenty of plain literals — since the retreat to literal-only first atoms, a
 * class or escape leading a branch is simply refused, so a corpus made only of
 * those would exercise almost nothing on the accepted path.
 */
const ATOMS = [
  "a", "b", "c", "x", "y", "z", "A", "B", "Z", "0", "1", "9",
  "img", "dsc", "pxl", "ab", "aa", "xy", "a1", "-", "_", ".", "é", "É", "日", " ",
  BACKSLASH + "w", BACKSLASH + "d", BACKSLASH + "s",
  BACKSLASH + "W", BACKSLASH + "D", BACKSLASH + "S",
  BACKSLASH + ".", BACKSLASH + "-", BACKSLASH + "]",
  "[a-z]", "[0-9]", "[abc]", "[" + BACKSLASH + "w]", "[" + BACKSLASH + "d]",
  "[" + BACKSLASH + ".-o]", "[a-" + BACKSLASH + "d]", "[" + BACKSLASH + "x41]",
  "[" + BACKSLASH + "]]", "[^a]", "[]",
  // A shorthand followed by a REVERSED range. A shorthand misaligns this
  // parser's item boundaries against the engine's (Annex B reads the whole thing
  // as a union), and a reversed range then contributes nothing — the one
  // direction that makes the proof unsafe. The atom set previously held nothing
  // long enough to express this, so the sweep could not reach it.
  "[" + BACKSLASH + "d-a-0]", "[" + BACKSLASH + "w-é-0]", "[" + BACKSLASH + "d-a--]",
  "[" + BACKSLASH + "w-日-0]", "[" + BACKSLASH + "d-a-z]", "[z-a]",
  "a?", "a*", "a+", "a{0}", "a{1}", "a{2,4}", "a{0,1}",
];

let generated = 0;
let accepted = 0;
let unsound = 0;
const failures: string[] = [];

for (let trial = 0; trial < 6000; trial++) {
  // TWO to FOUR branches. The generator used to emit exactly two, so the
  // screen's pairwise loop was never exercised beyond the adjacent pair — and a
  // defect at positions 1 and 3 would have gone unseen.
  const branchCount = 2 + rnd(3);
  const parts: string[] = [];
  for (let k = 0; k < branchCount; k++) {
    parts.push(ATOMS[rnd(ATOMS.length)] + (rnd(3) === 0 ? ATOMS[rnd(ATOMS.length)] : ""));
  }
  const open = rnd(2) === 0 ? "(" : "(?:";
  const quant = ["+", "*", "{1,20}"][rnd(3)];
  const pattern = `^${open}${parts.join("|")})${quant}$`;

  try { new RegExp(pattern, "i"); } catch { continue; } // not a valid regex
  generated++;

  if (!checkRegexSafety(pattern).safe) continue;
  accepted++;

  const branches = splitBranches(pattern);
  if (!branches || branches.length < 2) continue;
  // EVERY pair, not just the first two.
  let overlapped = false;
  for (let x = 0; x < branches.length && !overlapped; x++) {
    for (let y = x + 1; y < branches.length && !overlapped; y++) {
      if (branchesOverlap(branches[x], branches[y])) overlapped = true;
    }
  }
  if (overlapped) {
    unsound++;
    if (failures.length < 8) failures.push(pattern);
  }
}

assert.ok(generated > 2000, `the sweep actually ran (generated ${generated})`);
assert.ok(accepted > 200, `and accepted a meaningful share (accepted ${accepted})`);
assert.strictEqual(
  unsound,
  0,
  `accepted ${unsound} repeated alternations whose branches can match the same ` +
    `character — each is a potential unrecoverable hang:\n  ` +
    failures.join("\n  ")
);

// The corpus must actually contain the characters that previously broke things,
// or the sweep above proves nothing.
assert.ok(CORPUS.includes(BACKSLASH), "corpus covers backslash");
assert.ok(CORPUS.includes("é"), "corpus covers non-ASCII, which \\W and \\S match");
assert.ok(CORPUS.includes(" "), "corpus covers non-ASCII whitespace, which \\s matches");
assert.ok(
  ATOMS.some((a) => a.includes(BACKSLASH)),
  "atoms actually contain backslashes (heredocs in this environment eat them)"
);

console.log(
  `regexSafety soundness: ${generated} patterns, ${accepted} accepted, 0 unsound`
);
