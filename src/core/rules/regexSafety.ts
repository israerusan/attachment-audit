// Static screening for catastrophic-backtracking regexes. No Obsidian API — runs
// in tests under Node.
//
// Custom rules and junk-name patterns are user-supplied regexes evaluated once
// per attachment, synchronously, on Obsidian's UI thread. JavaScript cannot
// interrupt a running regex, so once `/^(a+)+$/` meets a non-matching string the
// renderer is simply gone — and because the pattern is persisted in settings,
// restarting Obsidian re-hangs on the next scan.
//
// Capping the INPUT length does not help: backtracking is exponential in input
// length, so a 256-character cap is astronomically worse than a 30-character one.
// The only practical defence without a worker thread is to refuse the pattern.
//
// Two shapes blow up, and BOTH must be caught:
//
//   1. A quantified group whose body is itself ambiguous — `(a+)+`, `(\w+\s?)+`,
//      `(a|aa)*`. This is the textbook case.
//   2. Several unbounded quantifiers in sequence over overlapping atoms, with no
//      group at all — `^a+a+a+a+…$`, `^.*.*.*…x$`, `^[a-z]+[a-z]+…$`. Measured on
//      this machine: 16 chained `.*` against a 27-character input takes **91
//      seconds** in one `test()` call. An earlier version of this file only
//      inspected groups and accepted every one of these.

export interface RegexSafetyVerdict {
  safe: boolean;
  /** Why the pattern was refused, phrased for the settings UI. */
  reason?: string;
}

/** Patterns longer than this are refused outright — no legitimate name rule needs it. */
const MAX_PATTERN_LENGTH = 400;

/** Nesting depth beyond which we stop trying to reason about the pattern. */
const MAX_GROUP_DEPTH = 12;

/**
 * Assumed number of lengths an unbounded quantifier can consume, for the
 * search-space estimate below. Not the real input cap (256) — using that would
 * reject even two chained `.*`, which is both common and fast. Calibrated so two
 * INTERACTING unbounded quantifiers stay under the budget and three do not;
 * quantifiers separated by a barrier are not multiplied together at all.
 */
const UNBOUNDED_CHOICES = 64;

/**
 * Ceiling on the estimated backtracking search space of a pattern: the product of
 * how many different lengths each repeating quantifier can consume, reset at every
 * point where two quantifiers provably cannot interact (see `barrierSince`).
 *
 * Counting quantifiers rather than multiplying their ranges was not enough. It
 * treated `{n,m}` as free, so `^a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}$` was
 * accepted and took **over 20 seconds** on a 128-character input, and
 * `^a{0,50}` x5 took 8 seconds at the 256-character cap. Multiplying the ranges
 * catches those (50^6 = 1.5e10) while leaving exact counts alone: `{4}` offers
 * exactly one choice and cannot backtrack, so `^(\d{4})-(\d{2})$` is free.
 *
 * The limit is CALIBRATED, not guessed. Measured against a 255-character basename,
 * which is the cap `matchesJunkName` applies, and remembering that this pattern
 * runs ONCE PER ATTACHMENT on the UI thread:
 *
 *      ^a+a+$        ->     0.3 ms        ^a+a+a+$      ->      23 ms
 *      ^\w*\w*\w*$    ->      51 ms        ^a+a+a+a+$    ->   1,406 ms
 *                                        ^a+a+a+a+a+$  ->  71,706 ms
 *
 * 64^2 is the ceiling because of the first column, not the second. The budget was
 * 64^3, which admitted three open-ended repeats over OVERLAPPING atoms — and
 * `^\w*\w*\w*$` at 51 ms per attachment is 17 minutes of frozen UI across a
 * 20,000-attachment vault. Tightening it costs nothing real: the patterns people
 * actually write chain their repeats around separators (`^IMG_\d+_\d+_\d+$`), and
 * the barrier reset means those never accumulate a product at all, however long
 * the chain. What 64^2 refuses is specifically a long run of repeats that CAN
 * consume each other's input, which is the only shape that backtracks.
 */
const MAX_SEARCH_SPACE = UNBOUNDED_CHOICES ** 2; // 4,096 — two interacting open-ended repeats

interface GroupFrame {
  /**
   * Index of the first character of the group's BODY — after any `(?:`, `(?=`,
   * `(?<name>` prefix. Scanning from the `(` instead meant the prefix's own `?`
   * was read as a quantifier on the group's body: every repeated non-capturing
   * group (`^(?:ab)+$`, `^(?:img|dsc)+$`) was refused with a message about
   * nested repetition it did not contain, and each `(?` silently doubled the
   * search-space budget.
   */
  start: number;
  /** The body contains an unbounded quantifier, so it is ambiguous. */
  hasQuantifier: boolean;
  /** Offsets of top-level `|` separators inside this group. */
  altBreaks: number[];
}

/** The repetition range a quantifier permits, or null when `i` is not a quantifier. */
interface RepeatRange {
  min: number;
  max: number;
}

function quantifierRangeAt(pattern: string, i: number): RepeatRange | null {
  const c = pattern[i];
  if (c === "*") return { min: 0, max: Infinity };
  if (c === "+") return { min: 1, max: Infinity };
  if (c === "?") return { min: 0, max: 1 };
  if (c !== "{") return null;
  const close = pattern.indexOf("}", i);
  if (close === -1) return null;
  const bounded = /^(\d+)(?:,(\d*))?$/.exec(pattern.slice(i + 1, close));
  if (!bounded) return null; // a literal `{`, per JS
  const min = Number(bounded[1]);
  if (bounded[2] === undefined) return { min, max: min }; // {n}
  if (bounded[2] === "") return { min, max: Infinity }; // {n,}
  return { min, max: Number(bounded[2]) }; // {n,m}
}

/**
 * True for a quantifier that ERASES its atom: `{0}` or `{0,0}`.
 *
 * These break the alternation disjointness proof in a way nothing else does.
 * That proof assumes each alternative's leading atom must consume a character,
 * so two branches with non-overlapping first atoms can never both match the same
 * text. Every other way to make that atom optional — `?`, `*`, `{0,n}`, `{0,}` —
 * has `max > min` and already poisons the group via
 * {@link variableLengthQuantifierAt}. A zero-repeat has `max === min === 0`, so
 * it slipped through all three checks: `^(a{0}b|b)+$` was read as branches `a`
 * and `b` (disjoint, safe) while the engine sees `^(b|b)+$`. Measured 9,433 ms
 * for ONE attachment through `matchesJunkName` at 28 characters, and over two
 * minutes at 35.
 *
 * Refusing them outright is complete and simple: `{0}` is never meaningful in a
 * name rule, since it matches the empty string.
 */
function erasesItsAtom(range: RepeatRange): boolean {
  return range.max === 0;
}

/**
 * How many different lengths the quantifier at `i` can consume — its branching
 * factor. Returns 1 when there is no quantifier, so it is multiplication-neutral.
 */
function quantifierChoicesAt(pattern: string, i: number): number {
  const range = quantifierRangeAt(pattern, i);
  if (range === null) return 1;
  if (range.max === Infinity) return UNBOUNDED_CHOICES;
  return Math.max(1, range.max - range.min + 1);
}

/**
 * True when the quantifier at `i` makes the text it governs VARIABLE in length.
 * Used to decide whether a group's BODY is ambiguous.
 *
 * The test is `max > min`, not `max > 1`:
 *  - `?` and `{0,1}` have max 1, so they read as non-repeating — but an optional
 *    atom inside a repeated group is the classic length ambiguity: `(aa?)+` can
 *    split a run of `a`s into any mix of ones and twos. Measured **14,275 ms**
 *    for `^(aa?)+$` on a 41-character input, and `^(\w\w?)+$` — something a user
 *    might genuinely write for "one or two word characters" — is the same shape.
 *  - `{4}` has max 4, so it read as repeating and made `^(\d{4})+$` look
 *    dangerous. A fixed-width body offers no choice and cannot backtrack.
 */
function variableLengthQuantifierAt(pattern: string, i: number): boolean {
  const range = quantifierRangeAt(pattern, i);
  return range !== null && range.max > range.min;
}

/**
 * True when the quantifier at `i` can run its subject MORE THAN ONCE. Used for
 * the OUTER quantifier on a group — a distinct question from the one above.
 *
 * `(X)?` runs X at most once, so no amount of ambiguity inside X can multiply:
 * that is why `^image( \(\d+\))?$`, one of the shipped defaults, is safe despite
 * containing `\d+` inside an optional group.
 */
function repeatsMoreThanOnceAt(pattern: string, i: number): boolean {
  const range = quantifierRangeAt(pattern, i);
  return range !== null && range.max > 1;
}

/**
 * Characters that start something {@link firstAtomCharset} refuses to model: a
 * backslash escape, a class, a group, or a quantifier/anchor meaning the leading
 * atom is not a plain literal. Built from a list rather than a string literal so
 * no amount of escaping confusion can quietly drop the backslash from it.
 */
const UNMODELLABLE_FIRST_CHARS: ReadonlySet<string> = new Set([
  String.fromCharCode(92), // backslash
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "*",
  "+",
  "?",
  ".",
  "^",
  "$",
  "|",
]);

/**
 * The single character an alternative's FIRST atom matches, or `null` when that
 * cannot be established trivially. Two alternatives whose first atoms cannot
 * match the same character can never both consume the same input, so the
 * alternation is unambiguous and safe to repeat.
 *
 * This models ONE thing: a plain literal character. Anything else — a class, any
 * escape, a group, a metacharacter — returns `null`, which makes the caller treat
 * the alternation as ambiguous and refuse to repeat it.
 *
 * That is a deliberate retreat. This function previously modelled character
 * classes, ranges and shorthand escapes so that `^(\w|-)+$` would be accepted,
 * and it was WRONG SEVEN TIMES, every time in the unsafe direction: an
 * under-approximated charset proves overlapping branches disjoint, and the
 * accepted pattern then freezes the renderer for minutes. The catalogue:
 *
 *   - negated shorthands modelled as ASCII-only (`\S` does match `é`)
 *   - in-class escapes read as the literal letter (`[\x41]` is `A`, not `x`)
 *   - an escaped `]` truncating the class, then throwing a RangeError
 *   - escaped range endpoints (`[\.-o]`, `[a-\d]`)
 *   - reversed ranges silently contributing nothing (`[\d-a-0]`)
 *
 * The feature was never worth it: NONE of the ten shipped default patterns, and
 * none of the realistic user rules surveyed, contains an alternation directly
 * under a repeat. The cost of the retreat is that `^(\w|-)+$` is refused — and
 * its natural spelling `^[\w-]+$` is not an alternation at all, so it is
 * unaffected. What remains is one literal character compared under the `i` flag's
 * canonicalization, which is small enough to be obviously correct.
 */
function firstAtom(alt: string): number | null {
  const c = alt[0];
  if (c === undefined) return null; // empty alternative: `(a|)+` loops forever
  if (UNMODELLABLE_FIRST_CHARS.has(c)) return null;
  // codePointAt on a single UTF-16 unit, matching the engine: neither caller
  // compiles with the `u` flag, so an astral character is two units to both of us.
  return c.codePointAt(0) ?? null;
}

/**
 * Fold one code point exactly the way the `i` flag does — ECMAScript's
 * Canonicalize: uppercase it, keep the result only if it is a single character
 * and the mapping did not pull a non-ASCII character into ASCII.
 *
 * `toUpperCase`, not `toLowerCase`: Greek sigma has TWO lowercase forms (σ and
 * final ς) that both uppercase to Σ, so lowercasing would judge them distinct.
 */
function canonicalize(c: number): number {
  // Defensive: `String.fromCodePoint` throws RangeError on NaN or an
  // out-of-range value. A parser bug upstream once fed it NaN and the exception
  // escaped every call site, aborting the scan. Screening a pattern must never
  // throw — the worst it may do is refuse the pattern.
  if (!Number.isInteger(c) || c < 0 || c > 0x10ffff) return -1;
  const upper = String.fromCodePoint(c).toUpperCase();
  if ([...upper].length !== 1) return c; // e.g. ß -> SS
  const u = upper.codePointAt(0) ?? c;
  // A non-ASCII character must not canonicalize into ASCII (spec rule; e.g. ſ -> S).
  if (c > 0x7f && u <= 0x7f) return c;
  return u;
}

/**
 * Whether two modelled first atoms can match the same character, under the `i`
 * flag both callers compile with.
 *
 * Deliberately takes CODE POINTS, not sets. `firstAtomCharset` used to return a
 * modelled character SET — for classes and shorthand escapes — and that
 * modelling was the source of seven separate accept-then-hang defects before it
 * was removed. Keeping a set-shaped interface here would leave the obvious place
 * for someone to reintroduce it.
 *
 * Case folding matters: `(a|A)+` looks disjoint on raw code points ({97} vs
 * {65}) and is two identical branches under `i`. Folding was ASCII-only at first,
 * which left Latin-1, Latin Extended, Greek and Cyrillic unfolded — a sweep found
 * 2,261 accepted `^(lower|upper)+$` pairs that are one branch, and `^(é|É)+$`
 * took over 20 seconds on a 64-character input.
 */
function atomsCollide(a: number, b: number): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * What the atom immediately BEFORE a quantifier can consume, modelled only when
 * it can be modelled soundly.
 *
 * `null` means "could be anything" and is the safe answer for every shape not
 * handled here: a group, a backreference, `.`, a negated class or shorthand, or
 * any class containing an escape. Nothing downstream may treat `null` as
 * permission.
 */
type AtomSet = { kind: "any" } | { kind: "set"; matches: (c: string) => boolean };

const DIGITS = /^[0-9]$/;
const WORD = /^[0-9A-Za-z_]$/;
const SPACE = /^[ \f\n\r\t\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/;

/**
 * Parse a character class body into a membership test, or give up.
 *
 * Gives up (returns `null`) on a negated class and on ANY backslash. That
 * exclusion is not timidity, it is the lesson of this module's history: the
 * earlier charset modelling was wrong seven times and every single time the
 * error came from an escape — negated shorthands read as ASCII-only, `[\x41]`
 * read as the letter `x`, an escaped `]` truncating the class, escaped range
 * endpoints, reversed ranges contributing nothing. With no backslash in the body
 * the grammar is just literals and `lo-hi` ranges, the delimiting `]` is
 * unambiguous, and the whole thing fits in the function below.
 *
 * Note the direction of the risk here is also the opposite of last time. This
 * result is used to prove two quantifiers CANNOT interact; an over-broad model
 * makes us keep multiplying and refuse the pattern, which is merely annoying. It
 * is an under-broad model that would be unsafe, and literals-and-ranges cannot
 * be under-broad.
 */
function classMembership(body: string): ((c: string) => boolean) | null {
  if (body.startsWith("^")) return null; // negated: complement is effectively anything
  if (body.includes(String.fromCharCode(92))) return null; // any escape: do not model
  const literals: string[] = [];
  const ranges: [string, string][] = [];
  for (let i = 0; i < body.length; i++) {
    // A `-` is a range operator only strictly BETWEEN two members; first or last
    // it is an ordinary literal hyphen (`[-a-z]`, `[a-z-]`).
    if (body[i] === "-" && i > 0 && i + 1 < body.length && literals.length > 0) {
      const lo = literals.pop() as string;
      const hi = body[i + 1];
      if (lo.codePointAt(0)! > hi.codePointAt(0)!) return null; // reversed: do not model
      ranges.push([lo, hi]);
      i++;
      continue;
    }
    literals.push(body[i]);
  }
  return (c: string) => {
    // Both case variants, because both callers compile with the `i` flag.
    for (const v of caseVariants(c)) {
      if (literals.some((l) => caseVariants(l).includes(v))) return true;
      for (const [lo, hi] of ranges) {
        if (inRange(v, lo, hi) || inRange(v, lo.toLowerCase(), hi.toLowerCase())) return true;
        if (inRange(v, lo.toUpperCase(), hi.toUpperCase())) return true;
      }
    }
    return false;
  };
}

function caseVariants(c: string): string[] {
  const out = [c];
  const lower = c.toLowerCase();
  const upper = c.toUpperCase();
  if (lower.length === 1 && lower !== c) out.push(lower);
  if (upper.length === 1 && upper !== c) out.push(upper);
  return out;
}

function inRange(c: string, lo: string, hi: string): boolean {
  if (lo.length !== 1 || hi.length !== 1) return false;
  const n = c.codePointAt(0) ?? -1;
  return n >= (lo.codePointAt(0) ?? 0) && n <= (hi.codePointAt(0) ?? -1);
}

/**
 * Model the atom that a quantifier at `i` applies to — i.e. the thing ending at
 * `i - 1`. Only the shapes below are modelled; everything else is `any`.
 */
function atomBefore(pattern: string, i: number): AtomSet {
  const prev = pattern[i - 1];
  if (prev === undefined) return { kind: "any" };
  // `]` — a character class. Find its opening `[`, rejecting any escape inside.
  if (prev === "]") {
    const open = pattern.lastIndexOf("[", i - 1);
    if (open === -1) return { kind: "any" };
    const test = classMembership(pattern.slice(open + 1, i - 1));
    return test ? { kind: "set", matches: test } : { kind: "any" };
  }
  // A two-character escape: a shorthand with a known set, or an escaped literal.
  if (i >= 2 && pattern[i - 2] === String.fromCharCode(92)) {
    if (prev === "d") return { kind: "set", matches: (c) => DIGITS.test(c) };
    if (prev === "w") return { kind: "set", matches: (c) => WORD.test(c) };
    if (prev === "s") return { kind: "set", matches: (c) => SPACE.test(c) };
    // `\D`, `\W`, `\S` and `\1` are complements or backreferences: not modelled.
    if (/[A-Za-z0-9]/.test(prev)) return { kind: "any" };
    // An escaped punctuation character matches exactly itself.
    return { kind: "set", matches: (c) => c === prev };
  }
  // A plain literal, as long as it is not a metacharacter.
  if (UNMODELLABLE_FIRST_CHARS.has(prev)) return { kind: "any" };
  return { kind: "set", matches: (c) => caseVariants(c).includes(prev) || caseVariants(prev).includes(c) };
}


/** Index just past the quantifier starting at `i` (handles `+`, `*?`, `{1,9}`). */
function quantifierEndAt(pattern: string, i: number): number {
  if (pattern[i] === "{") {
    const close = pattern.indexOf("}", i);
    if (close !== -1) return pattern[close + 1] === "?" ? close + 2 : close + 1;
    return i + 1;
  }
  return pattern[i + 1] === "?" ? i + 2 : i + 1;
}

/** Length of the quantifier token ending at `end`, so its atom can be located. */
function quantifierLengthBefore(pattern: string, end: number): number {
  let n = end - 1;
  if (pattern[n] === "?" && n > 0) n--; // lazy marker
  if (pattern[n] === "}") {
    const open = pattern.lastIndexOf("{", n);
    if (open !== -1) return end - open;
  }
  return end - n;
}

/** Index of the `]` closing the class opened at `i`, or -1. No escapes allowed. */
function classEndAt(pattern: string, i: number): number {
  for (let j = i + 1; j < pattern.length; j++) {
    if (pattern[j] === String.fromCharCode(92)) return -1; // escapes: not modelled
    if (pattern[j] === "]" && j > i + 1) return j;
  }
  return -1;
}

/**
 * True when the span between two quantifiers contains a literal character the
 * EARLIER quantifier's atom provably cannot consume.
 *
 * Such a literal is a hard anchor: the earlier repeat cannot extend past it and
 * the later one cannot reach back before it, so backtracking in one cannot change
 * the work available to the other. That is what makes the search-space product
 * meaningless across it, and what lets `^IMG_\\d+_\\d+_\\d+_\\d+$` through while
 * `^\\d+\\d+\\d+\\d+$` stays refused.
 *
 * The span is TOKENIZED rather than scanned character by character, and the last
 * token is dropped. Both details are load-bearing; a naive character scan got
 * three cases wrong, every one in the UNSAFE direction:
 *
 *   - `^\\d+\\d+$` — the `d` of the second `\d` read as a standalone literal,
 *     which `\d` cannot match, inventing a barrier between adjacent repeats.
 *   - `^[a-z]+[a-z]+$` — the `-` inside the FOLLOWING class read as a separator.
 *   - the final atom belongs to the LATER quantifier, so it is not between the
 *     two at all; counting it made `^[a-z]+[a-z]+$` look separated by its own class.
 *
 * Anything that cannot be tokenized confidently — a group, an alternation —
 * abandons the search and keeps the product, because refusing is always the safe
 * outcome here.
 */
function barrierSince(pattern: string, lastQuantifierEnd: number, i: number): boolean {
  if (lastQuantifierEnd < 0) return false; // nothing earlier to be separated from
  const earlier = atomBefore(
    pattern,
    lastQuantifierEnd - quantifierLengthBefore(pattern, lastQuantifierEnd)
  );
  if (earlier.kind !== "set") return false; // unmodellable: prove nothing

  const atoms: (string | null)[] = [];
  let j = lastQuantifierEnd;
  while (j < i) {
    const c = pattern[j];
    if (c === "(" || c === ")" || c === "|") return false; // give up, keep the product
    if (c === String.fromCharCode(92)) {
      const next = pattern[j + 1];
      atoms.push(next !== undefined && !/[A-Za-z0-9]/.test(next) ? next : null);
      j += 2;
      continue;
    }
    if (c === "[") {
      const close = classEndAt(pattern, j);
      if (close === -1) return false;
      atoms.push(null);
      j = close + 1;
      continue;
    }
    // A quantifier attaches to the atom already pushed; it adds none of its own,
    // and a quantified atom is no barrier since it may match zero characters.
    if (quantifierRangeAt(pattern, j) !== null) {
      if (atoms.length > 0) atoms[atoms.length - 1] = null;
      j = quantifierEndAt(pattern, j);
      continue;
    }
    atoms.push(UNMODELLABLE_FIRST_CHARS.has(c) ? null : c);
    j++;
  }

  // Drop the trailing atom: it is what the LATER quantifier repeats, so it sits
  // beside that quantifier rather than between the two.
  atoms.pop();
  return atoms.some((a) => a !== null && !earlier.matches(a));
}

/**
 * True when a group's alternatives might match the same text, which is what makes
 * repeating the group exponential.
 */
function alternativesAmbiguous(body: string, breaks: number[], bodyStart: number): boolean {
  if (breaks.length === 0) return false; // no alternation at all
  const alts: string[] = [];
  let from = 0;
  for (const b of breaks) {
    alts.push(body.slice(from, b - bodyStart));
    from = b - bodyStart + 1;
  }
  alts.push(body.slice(from));

  const heads: number[] = [];
  for (const alt of alts) {
    // NOT trimmed: a leading space is a real atom, and analysing a different
    // string than the engine matches makes the disjointness proof unsound.
    const head = firstAtom(alt);
    if (head === null) return true; // cannot prove disjoint -> assume the worst
    heads.push(head);
  }
  // EVERY pair, not just adjacent ones: an overlap between branches 1 and 3 is
  // just as exponential as one between 1 and 2.
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      if (atomsCollide(heads[i], heads[j])) return true;
    }
  }
  return false;
}

/**
 * Screen a user-supplied regex for shapes known to backtrack catastrophically,
 * and for patterns that simply will not compile.
 */
export function checkRegexSafety(pattern: string): RegexSafetyVerdict {
  // A bug in the screen must never take the scan down with it. All three callers
  // invoke this outside their own try/catch, so an exception here aborted the
  // whole scan mid-way and broke the settings tab — leaving the user unable to
  // delete the pattern that caused it, on every restart. Failing closed is
  // always available and always safe.
  try {
    return screen(pattern);
  } catch (err) {
    console.error("Attachment Audit: could not screen a pattern, refusing it", err);
    return { safe: false, reason: "This pattern could not be checked, so it is not being used." };
  }
}

function screen(pattern: string): RegexSafetyVerdict {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
  }

  const stack: GroupFrame[] = [];
  let inClass = false;
  let escaped = false;
  /** Running product of every quantifier's branching factor. */
  let searchSpace = 1;
  // Where the previous repeating quantifier ended, so the barrier test knows
  // which span of pattern sits between it and the next one.
  let lastQuantifierEnd = -1;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    // Inside `[...]` every metacharacter is literal, so nothing here can nest.
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }

    if (c === "(") {
      if (stack.length >= MAX_GROUP_DEPTH) {
        return { safe: false, reason: "Pattern nests groups too deeply." };
      }
      // Step over the group-kind prefix — `?:`, `?=`, `?!`, `?<=`, `?<!`,
      // `?<name>` — so its `?` is not scanned as a quantifier, and so the body
      // handed to the alternation analysis starts at the real first alternative.
      const prefix = /^\((\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))/.exec(pattern.slice(i));
      const bodyStart = i + 1 + (prefix ? prefix[1].length : 0);
      stack.push({ start: bodyStart, hasQuantifier: false, altBreaks: [] });
      if (prefix) i = bodyStart - 1; // the loop's i++ lands on the body
      continue;
    }

    if (c === ")") {
      const frame = stack.pop();
      if (!frame) continue; // unbalanced — `new RegExp` will reject it below
      const body = pattern.slice(frame.start, i);
      const ambiguous =
        frame.hasQuantifier || alternativesAmbiguous(body, frame.altBreaks, frame.start);
      // A repeated group whose body is itself ambiguous is the classic
      // exponential shape: (a+)+, (\w+\s?)+, (a|aa)*, (x{1,20}){1,20}.
      if (ambiguous && repeatsMoreThanOnceAt(pattern, i + 1)) {
        return {
          safe: false,
          reason:
            "Pattern repeats a group that already repeats (like `(a+)+`). " +
            "This can hang Obsidian — rewrite it without the nested repetition.",
        };
      }
      // An ambiguous inner group makes every enclosing group ambiguous too.
      if (stack.length > 0 && ambiguous) stack[stack.length - 1].hasQuantifier = true;
      continue;
    }

    if (c === "|" && stack.length > 0) {
      stack[stack.length - 1].altBreaks.push(i);
      continue;
    }

    const range = quantifierRangeAt(pattern, i);
    if (range !== null && erasesItsAtom(range)) {
      return {
        safe: false,
        reason:
          "Pattern contains a repeat of zero (like `a{0}`), which matches nothing. " +
          "Remove it — it can also make the pattern hang Obsidian.",
      };
    }
    // The search-space budget applies at EVERY nesting level, not just inside a
    // group: a chain of quantifiers with no group at all is the second documented
    // blow-up shape, and it has a bounded variant (`a{1,50}` x6) as well as an
    // unbounded one (`a+` x6).
    //
    // But the product only means anything for quantifiers that can actually
    // interact. Multiplying blindly refused ordinary, strictly linear rules —
    // `^IMG_\d+_\d+_\d+_\d+$`, `^\d+\.\d+\.\d+\.\d+$`,
    // `^[a-z]+-[0-9]+-[a-z]+-[0-9]+$`, every camera and screenshot naming scheme
    // a user would actually write. In all of those the quantified atoms are
    // separated by a literal the preceding atom cannot consume, so the earlier
    // repeat can never give ground to the later one: there is nothing to
    // backtrack across. The barrier below resets the product at exactly those
    // points.
    //
    // It is only ever applied on PROOF (see `atomBefore`), never on a guess: an
    // unmodellable atom keeps multiplying and the pattern keeps getting refused.
    // That matters, because the chain cost is not theoretical — measured against
    // a 255-character basename, `^a+a+a+a+$` takes 1.4 s and `^a+a+a+a+a+$` takes
    // 72 s, once per attachment.
    if (quantifierChoicesAt(pattern, i) > 1 && barrierSince(pattern, lastQuantifierEnd, i)) {
      searchSpace = 1;
    }
    searchSpace *= quantifierChoicesAt(pattern, i);
    if (quantifierChoicesAt(pattern, i) > 1) {
      const range = quantifierRangeAt(pattern, i);
      lastQuantifierEnd = range === null ? i + 1 : quantifierEndAt(pattern, i);
    }
    if (searchSpace > MAX_SEARCH_SPACE) {
      return {
        safe: false,
        reason:
          "Pattern chains repeats that can consume the same text (like `a+a+a+` or " +
          "`a{1,50}a{1,50}a{1,50}`). This can hang Obsidian — separate them with " +
          "something they cannot match, such as `-` or `_`, or simplify it.",
      };
    }
    // Mark the enclosing group ambiguous for ANY repeating quantifier, bounded or
    // not — `(x{1,20})` is just as multiplicative as `(x+)` once repeated.
    if (stack.length > 0 && variableLengthQuantifierAt(pattern, i)) {
      stack[stack.length - 1].hasQuantifier = true;
    }
  }

  try {
    new RegExp(pattern);
  } catch {
    return { safe: false, reason: "Not a valid regular expression." };
  }
  return { safe: true };
}
