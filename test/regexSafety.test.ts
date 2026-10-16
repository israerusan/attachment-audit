import assert from "node:assert";
import { checkRegexSafety } from "../src/core/rules/regexSafety";

const safe = (p: string): boolean => checkRegexSafety(p).safe;

// --- The shipped defaults must all survive the screen -----------------------
import { DEFAULT_JUNK_NAME_PATTERNS } from "../src/core/naming/namePatterns";
for (const pattern of DEFAULT_JUNK_NAME_PATTERNS) {
  assert.ok(safe(pattern), `default junk pattern rejected: ${pattern}`);
}

// --- Ordinary user patterns stay allowed ------------------------------------
assert.ok(safe("^Pasted image \\d+"));
assert.ok(safe("^(IMG|DSC)_\\d+$"), "alternation alone is fine when not repeated");
assert.ok(safe("\\.(png|jpe?g)$"));
assert.ok(safe("^screenshot.*final$"));
assert.ok(safe("^a{2,4}$"), "bounded repetition of a group-free atom");
assert.ok(safe("(abc){2,4}"), "BOUNDED repetition of a group is not exponential");
assert.ok(safe("[a-z+*]+"), "quantifier chars inside a character class are literals");
assert.ok(safe("\\(\\d+\\)"), "escaped parens are not a group");

// --- Alternation the screen must NOT reject ---------------------------------
// Alternatives whose first atoms cannot match the same character can never both
// consume the same input, so repeating them is linear. These are plausible rules.
assert.ok(!safe("^(\\w|-)+$"), "classes and escapes are no longer modelled");
assert.ok(safe("^(a|b)+$"), "distinct literals");
assert.ok(safe("^(img|dsc|pxl)+$"), "distinct first letters");
assert.ok(!safe("^([a-z]|[0-9])+$"), "classes are no longer modelled");
assert.ok(!safe("^(\\d|-)+$"));

// --- Group-free catastrophic chains are refused ------------------------------
// The shape an earlier version of this screen accepted. Measured on this machine:
// 16 chained `.*` against a 27-character input takes ~91 SECONDS in one test().
assert.ok(!safe("^" + "a+".repeat(16) + "$"), "chained a+ (measured 457ms at 27 chars)");
assert.ok(!safe("^" + ".*".repeat(16) + "x$"), "chained .* (measured 91s at 27 chars)");
assert.ok(!safe("^" + "[a-z]+".repeat(16) + "$"), "chained class+ (measured 469ms at 27 chars)");
assert.ok(!safe("a+a+a+a+"), "four open-ended repeats is already over the limit");
// THREE interacting repeats is over the limit too, since the budget tightened from
// 64^3 to 64^2. The number came off the clock, not off a preference: `^\w*\w*\w*$`
// measures 51 ms against a 255-character basename, and that cost is paid once per
// attachment — about 17 minutes of frozen UI across a 20,000-attachment vault.
// See the MAX_SEARCH_SPACE comment for the full measurement table.
assert.ok(!safe("a+a+a+"), "three interacting repeats is over the limit");
assert.ok(!safe("^\\w*\\w*\\w*$"), "the 51ms-per-attachment case");
assert.ok(safe("a+a+"), "two interacting repeats stays usable (measured 0.3ms)");
assert.ok(!safe("\\d*\\d*\\d*\\d*"));

// --- ...but a chain whose repeats CANNOT interact is linear, and allowed -------
// Separated by a literal the preceding atom cannot consume, there is nothing to
// backtrack across, however long the chain. These are the shapes real naming
// schemes take, and every one of them was refused before the barrier reset.
assert.ok(safe("^IMG_\\d+_\\d+_\\d+_\\d+$"), "camera naming scheme");
assert.ok(safe("^Screenshot \\d+-\\d+-\\d+ at \\d+$"), "macOS screenshot scheme");
assert.ok(safe("^\\d+\\.\\d+\\.\\d+\\.\\d+$"), "dotted version, escaped dots");
assert.ok(safe("^[a-z]+-[0-9]+-[a-z]+-[0-9]+$"), "class chain around hyphens");
assert.ok(safe("^\\w+-\\w+-\\w+-\\w+$"), "word chain around hyphens (measured 0.04ms)");
// An UNESCAPED dot matches digits, so it is not a barrier and the product stands.
assert.ok(!safe("^\\d+.\\d+.\\d+.\\d+$"), "unescaped dot is not a separator");
// A hyphen INSIDE the class means the class can match the separator.
assert.ok(!safe("^[a-z-]+-[a-z-]+-[a-z-]+-[a-z-]+$"), "class that matches its own separator");
// A class containing an escape is deliberately not modelled, so it proves nothing.
assert.ok(!safe("^[\\w-]+-[\\w-]+-[\\w-]+-[\\w-]+$"), "unmodelled class proves nothing");

// --- Catastrophic shapes are refused ----------------------------------------
assert.ok(!safe("^(a+)+$"), "classic nested quantifier");
assert.ok(!safe("(a*)*"), "nested star");
assert.ok(!safe("^(\\w+\\s?)+$"), "the plausible-looking one that hangs Obsidian");
assert.ok(!safe("(a|aa)+"), "overlapping alternation under a quantifier");
assert.ok(!safe("(a|b|ab)*"));
assert.ok(!safe("((x+)y)+"), "ambiguity propagates out through an enclosing group");
assert.ok(!safe("(a+){2,}"), "open-ended {n,} counts as unbounded");

// A refusal must explain itself — the settings UI shows this text.
const verdict = checkRegexSafety("^(a+)+$");
assert.strictEqual(verdict.safe, false);
assert.ok(verdict.reason && verdict.reason.length > 0, "refusal carries a reason");

// --- Invalid regexes are refused rather than thrown -------------------------
assert.ok(!safe("("), "unbalanced group");
assert.ok(!safe("[z-a]"), "invalid character range");
assert.ok(!safe("*"), "nothing to repeat");

// --- Absurd input is refused ------------------------------------------------
assert.ok(!safe("a".repeat(500)), "over the length cap");

// --- The screen must be FAST: it runs on every settings keystroke ------------
const started = Date.now();
for (let i = 0; i < 2000; i++) checkRegexSafety("^(\\w+\\s?)+$");
assert.ok(Date.now() - started < 1000, "screening 2000 patterns stays well under a second");

// --- Regression: the shape that motivated this module -----------------------
// Before the screen, `/^(a+)+$/.test("a".repeat(30) + "!")` took ~46 SECONDS.
// The screen must reject it outright, so it is never compiled or executed.
assert.ok(!safe("^(a+)+$"));

console.log("regexSafety tests passed");

// --- Nested BOUNDED repetition is exponential too ---------------------------
// An earlier version only treated `*`, `+` and `{n,}` as repeats, so these sailed
// through. Measured with a single `new RegExp(p,"i").test(...)` call:
//   ^(x{1,20}){1,20}$      on 81 chars -> 106,283 ms
//   ^((a{1,8}){1,8}){1,8}$ on 61 chars -> 104,079 ms
//   ^([a-z]{1,9}){1,9}$    on 61 chars ->  17,689 ms
//   ^(\w{1,9}){1,9}$       via matchesJunkName -> 12,204 ms PER ATTACHMENT
assert.ok(!safe("^(x{1,20}){1,20}$"));
assert.ok(!safe("^((a{1,8}){1,8}){1,8}$"));
assert.ok(!safe("^([a-z]{1,9}){1,9}$"));
assert.ok(!safe("^(\\w{1,9}){1,9}$"));
assert.ok(!safe("(a{2,3})+"), "bounded inner, unbounded outer");
assert.ok(!safe("(a+){2,3}"), "unbounded inner, bounded outer");

// A group repeated at most ONCE cannot multiply, so it stays allowed.
assert.ok(safe("^(abc)?$"));
assert.ok(safe("^(abc){1}$"));
assert.ok(safe("^(\\d{4})-(\\d{2})$"), "bounded, non-nested, not repeated");
assert.ok(safe("^image( \\(\\d+\\))?$"), "the shipped default still passes");

// --- The `i` flag must be modelled -------------------------------------------
// Both callers compile with "i", so branches differing only in case are the SAME
// branch. Unfolded this was judged disjoint and accepted: measured 18,546 ms.
assert.ok(!safe("^(a|A)+$"));
assert.ok(!safe("^(img|IMG)+$"));
assert.ok(safe("^(a|B)+$"), "genuinely different letters are still fine");

console.log("regexSafety nested-bounded + case-fold tests passed");

// --- Non-ASCII case pairs are the SAME branch under the `i` flag ------------
// Both callers compile with "i". An ASCII-only fold left Latin-1, Latin Extended,
// Greek and Cyrillic unfolded: 2,261 accepted `^(lower|upper)+$` pairs that are
// actually one branch. `^(é|É)+$` took over 20 SECONDS on a 64-char input.
assert.ok(!safe("^(é|É)+$"));
assert.ok(!safe("^(ä|Ä)+$"));
assert.ok(!safe("^(и|И)+$"), "Cyrillic");
assert.ok(!safe("^([é]|[É])+$"), "character-class form too");
// Greek final sigma: σ and ς are distinct lowercase forms that BOTH uppercase to
// Σ, which is why the fold canonicalizes upward rather than downward.
assert.ok(!safe("^(σ|ς)+$"));

// ...but the spec's non-ASCII-to-ASCII exclusion must be honoured. Dotless ı
// uppercases to I, and long s ſ to S, yet neither is `i`-equivalent to its ASCII
// counterpart — so these branches ARE disjoint and stay allowed (measured 0ms).
assert.ok(!new RegExp("^ı$", "i").test("I"), "dotless i is not i-equivalent to I");
assert.ok(safe("^(ı|I)+$"));
assert.ok(!new RegExp("^ſ$", "i").test("S"), "long s is not i-equivalent to S");
assert.ok(safe("^(ſ|S)+$"));

// --- Bounded chains outside any group ---------------------------------------
// Counting only UNBOUNDED quantifiers treated `{n,m}` as free. Measured:
//   ^a{1,50} x6 $   on 128 chars -> over 20,000 ms (killed)
//   ^a{0,50} x5 $   on 256 chars ->      8,092 ms
//   ^.{1,30} x6 $   on 192 chars ->      2,204 ms
assert.ok(!safe("^" + "a{1,50}".repeat(6) + "$"));
assert.ok(!safe("^" + "a{0,50}".repeat(5) + "$"));
assert.ok(!safe("^" + ".{1,30}".repeat(6) + "$"));
assert.ok(!safe("^" + "[a-z]{1,40}".repeat(5) + "$"));
assert.ok(!safe("^" + "\\w{1,60}".repeat(4) + "$"));
// Wrapping the chain in a non-repeated group must not launder it.
assert.ok(!safe("^(" + "a{1,50}".repeat(6) + ")$"));
assert.ok(!safe("^(?:" + "a{1,50}".repeat(6) + ")$"));

// EXACT counts offer no choice and cannot backtrack, so they stay free.
assert.ok(safe("^(\\d{4})-(\\d{2})-(\\d{2})$"), "a date pattern is not a threat");
assert.ok(safe("^a{4}b{4}c{4}d{4}e{4}$"));
// A handful of optionals is a tiny search space.
assert.ok(safe("^a?b?c?d?e?$"));

console.log("regexSafety case-fold + bounded-chain tests passed");

// Guard against a shell heredoc (or an editor) silently eating the backslashes in
// the fixtures above and turning `\w` into a literal `w`, which would make several
// assertions pass for the wrong reason.
const BACKSLASH = String.fromCharCode(92);
assert.ok("\\w{1,60}".includes(BACKSLASH), "regex escapes in this file survived editing");
assert.ok("^(\\d{4})-(\\d{2})$".includes(BACKSLASH + "d"), "digit escapes survived editing");

// --- An OPTIONAL atom inside a repeated group -------------------------------
// `?` has max 1, so an earlier ambiguity test ("can it repeat more than once?")
// treated it as harmless. But an optional atom inside a repeated group is the
// classic length ambiguity: `(aa?)+` splits a run of `a`s into any mix of ones
// and twos. Measured **14,275 ms** for `^(aa?)+$` on a 41-character input.
// The shorthand-class forms are ones a user could plausibly type.
for (const p of [
  "^(aa?)+$", "^(a?a)+$", "^(aa?)*$", "^(aa?){1,99}$", "^(a{0,1}a)+$",
  "^(?:aa?)+$", "^((a)a?)+$", "^(a(a)?)+$", "^x(aa?)+$",
  "^(\w\w?)+$", "^([a-z][a-z]?)+$", "^(\d\d?)+$",
  "^(a\w?)+$", "^(.a?)+$",
]) {
  assert.ok(!safe(p), `optional-in-repeated-group must be refused: ${p}`);
}

// ...but a group that runs AT MOST ONCE cannot multiply, however ambiguous its
// body. This is why a shipped default with `\d+` inside an optional group is fine.
assert.ok(safe("^image( \(\d+\))?$"));
assert.ok(safe("^(\d+)?$"));
assert.ok(safe("^(a+)?$"));
// A FIXED-width body offers no choice, so repeating it is safe.
assert.ok(safe("^(\d{4})+$"), "fixed-width group repeat cannot backtrack");
assert.ok(safe("^(ab){2,8}$"));

// --- The search-space budget is calibrated, not guessed ---------------------
// Measured worst case against a 255-char basename (the matchesJunkName cap):
//   32,768 -> 9ms   147,456 -> 43ms   262,144 -> 49ms   786,432 -> 156ms
//
// The budget is 64^2, not 64^3. 49 ms reads as cheap for ONE call, and this runs
// once per attachment — 49 ms is 16 minutes across a 20,000-attachment vault, so
// the old ceiling was calibrated against the wrong unit. Two interacting repeats
// (0.3 ms) is the line.
assert.ok(safe("^\w+\w+$"), "two open-ended repeats stay usable (0.3ms)");
assert.ok(!safe("^\w+\w+\w+$"), "three interacting repeats is 49ms PER ATTACHMENT");
assert.ok(!safe("^\w+\w+\w+\w{1,3}$"), "four crosses 150ms per attachment");
assert.ok(!safe("^\w+\w{1,25}\w{1,25}\w{1,25}$"));
// The same three repeats, separated so they cannot consume each other's input,
// cost 0.04 ms and are allowed. Chain length is not what makes a pattern slow.
assert.ok(safe("^\w+-\w+-\w+$"), "separated repeats are linear");

console.log("regexSafety optional-in-group + budget tests passed");

// --- A zero-repeat ERASES its atom and voids the disjointness proof ---------
// The alternation check assumes each branch's leading atom must consume a
// character. `?`, `*`, `{0,n}` and `{0,}` all have max > min and already poison
// the group; `{0}` has max === min === 0 and slipped through every check, so
// `^(a{0}b|b)+$` was read as branches `a` and `b` (disjoint, safe) while the
// engine sees `^(b|b)+$`. Measured 9,433 ms for ONE attachment at 28 chars.
for (const p of [
  "^(a{0}b|b)+$", "^(\\d{0}b|b)+$", "^(a{0,0}b|b)+$",
  "^(b|a{0}b)+$", "^([q]{0}b|b)+$", "^(ab|\\d{0}\\w)+$",
]) {
  assert.ok(!safe(p), `zero-repeat must be refused: ${p}`);
}
assert.ok(!safe("a{0}"), "a bare zero-repeat is meaningless anyway");
assert.ok(!safe("a{0,0}"));
// A zero MINIMUM is fine — only a zero MAXIMUM erases the atom.
assert.ok(safe("^a{0,5}$"));
assert.ok(safe("^ab*c$"));

// --- Group-kind prefixes must not be parsed as quantifiers ------------------
// Scanning from `(` meant the `?` in `(?:` was read as a quantifier on the
// group's own body: every repeated non-capturing group was refused with a
// message about nested repetition it did not contain, and each `(?` doubled the
// search-space budget.
assert.ok(safe("^(?:ab)+$"));
assert.ok(safe("^(?:ab)*$"));
assert.ok(safe("^(?:ab){2,4}$"));
assert.ok(safe("^(?:a|b)+$"));
assert.ok(safe("^(?:img|dsc|pxl)+$"), "non-capturing must behave like capturing");
assert.ok(safe("^(?=a)ab$"), "lookahead");
// Many group prefixes must not accumulate budget — none of these repeat anything.
assert.ok(safe("^" + "(?:a)".repeat(19) + "$"));
assert.ok(safe("^" + "(?=a)".repeat(19) + "$"));
// ...and a non-capturing group must not launder a genuinely dangerous body.
assert.ok(!safe("^(?:a+)+$"));
assert.ok(!safe("^(?:a|aa)+$"));
assert.ok(!safe("^(?:aa?)+$"));

// The alternation analysis must see the real first alternative, not the prefix.
assert.ok(!safe("^(?:a|ab)+$"), "overlapping branches inside a non-capturing group");

console.log("regexSafety zero-repeat + group-prefix tests passed");

// --- Character-class parsing must honour escapes ---------------------------
// `indexOf("]")` found the ESCAPED bracket in `[\\]]`, truncating the class body
// to a lone backslash. The parser then read past the end, added NaN to the
// charset, and String.fromCodePoint threw an uncaught RangeError that escaped
// ALL THREE call sites — aborting the scan and breaking the settings tab, so the
// offending pattern could not even be deleted. It recurred on every restart.
for (const p of ["^([\\]]|a)+$", "([\\]]|a)", "^([\\[\\]]|-)+$", "^(?:[\\]]|a)+$"]) {
  // The point of this case is that screening must not THROW. Since the retreat
  // to literal-only first atoms these are also refused (a class is no longer
  // modelled), which is the safe direction and costs nothing real.
  assert.doesNotThrow(() => checkRegexSafety(p), `must not throw: ${p}`);
  assert.strictEqual(typeof checkRegexSafety(p).safe, "boolean", `returns a verdict: ${p}`);
}

// Screening must NEVER throw, whatever it is handed.
for (const p of ["[", "[\\", "[]", "[^]", "(", ")", "(?", "(?<", "a{", "a{x}", "a{2", "*", "+", "?", ""]) {
  assert.doesNotThrow(() => checkRegexSafety(p), `screening must not throw on: ${JSON.stringify(p)}`);
}

// --- In-class escapes must not be read as the literal letter ---------------
// `[\\x41]` is `A`, not `x`. Treating it as the letter attributed it to the
// wrong code point and cleared genuinely overlapping alternations:
// `^(?:[\\x41]|A)+$` was accepted while the engine sees `(A|A)+` — 1,930 ms.
assert.ok(!safe("^(?:[\\x41]|A)+$"));
assert.ok(!safe("^(?:[\\u0041]|A)+$"));
assert.ok(!safe("^(?:[\\t]|" + String.fromCharCode(9) + ")+$"));
assert.ok(!safe("^(?:[\\cA]|a)+$"));
// ...but escaped PUNCTUATION really is its own literal, so it stays modellable.
assert.ok(!safe("^([\\-]|a)+$"));
assert.ok(!safe("^([\\.]|a)+$"));

// --- Negated shorthands match NON-ASCII, so they cannot be modelled --------
// `\\W`, `\\D`, `\\S` are complements and match every character above 0x7F;
// `\\s` includes U+00A0, U+2028, U+FEFF. Enumerating only 0-127 made
// `^(?:\\S|é)+$` look like two disjoint branches when the engine sees one —
// measured 1,983 ms at 29 chars, with 36,463 such accepted patterns in a sweep.
assert.ok(!safe("^(?:\\S|é)+$"));
assert.ok(!safe("^(?:\\W|é)+$"));
assert.ok(!safe("^(?:\\D|é)+$"));
assert.ok(!safe("^([\\W]|é)+$"));
assert.ok(!safe("^(?:\\s|" + String.fromCharCode(0xa0) + ")+$"), "\s includes U+00A0");
// The two POSITIVE shorthands are exactly ASCII by definition and stay modellable.
assert.ok(!safe("^(\\w|-)+$"));
assert.ok(!safe("^(\\d|-)+$"));

console.log("regexSafety class-parsing + shorthand tests passed");

// --- A range endpoint that is an ESCAPE cannot be modelled -----------------
// The parser under-approximated the charset, which breaks the disjointness
// proof in the UNSAFE direction: `[\\.-o]` read as {'.','-','o'} instead of the
// range 0x2E-0x6F, and `[a-\\d]` read as {'d'} instead of 'a' plus every digit.
// `^(?:0|[\\.-o])+$` was accepted on that basis: 495 ms at 26 chars, and the
// wider `^(?:[\\!-~]|Q)+$` takes 64 SECONDS at 30.
assert.ok(!safe("^(?:0|[\\.-o])+$"), "escaped LOW endpoint");
assert.ok(!safe("^(?:[\\!-~]|Q)+$"));
assert.ok(!safe("^(?:a|[a-\\d])+$"), "escaped HIGH endpoint");
assert.ok(!safe("^(?:[+-\\-]|,)+$"));

// Since the retreat to literal-only first atoms, NO character class and no
// escape is modelled, so every one of these is refused. That is the safe
// direction and it costs nothing real — the natural spellings below, which are
// not alternations at all, are unaffected.
for (const p of [
  "^([\\-]|a)+$",
  "^([\\.]|a)+$",
  "^([\\]]|a)+$",
  "^([\\w]|-)+$",
  "^([a-z]|[0-9])+$",
  "^([a-m]|[n-z])+$",
]) {
  assert.ok(!safe(p), `a class is no longer modelled: ${p}`);
}
assert.ok(safe("^[\\w-]+$"), "the natural class spelling is unaffected");
assert.ok(safe("^[a-z0-9]+$"));
// Alternation of plain LITERALS is still modelled, which is the case that
// actually appears in real rules.
assert.ok(safe("^(img|dsc|pxl)+$"));
assert.ok(safe("^(a|b)+$"));
assert.ok(!safe("^(a|aa)+$"), "...and overlapping literals are still caught");

console.log("regexSafety escaped-range tests passed");
