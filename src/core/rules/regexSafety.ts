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
 * reject two chained `.*`, which is both common and fast. Calibrated so three
 * unbounded quantifiers stay under the budget and four do not.
 */
const UNBOUNDED_CHOICES = 64;

/**
 * Ceiling on the estimated backtracking search space of a pattern: the product of
 * how many different lengths each repeating quantifier can consume.
 *
 * Counting quantifiers rather than multiplying their ranges was not enough. It
 * treated `{n,m}` as free, so `^a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}$` was
 * accepted and took **over 20 seconds** on a 128-character input, and
 * `^a{0,50}` x5 took 8 seconds at the 256-character cap. Multiplying the ranges
 * catches those (50^6 = 1.5e10) while leaving exact counts alone: `{4}` offers
 * exactly one choice and cannot backtrack, so `^(\d{4})-(\d{2})$` is free.
 */
const MAX_SEARCH_SPACE = 1_000_000;

interface GroupFrame {
  /** Index of the `(` that opened this group. */
  start: number;
  /** The body contains an unbounded quantifier, so it is ambiguous. */
  hasQuantifier: boolean;
  /** Offsets of top-level `|` separators inside this group. */
  altBreaks: number[];
}

/**
 * The maximum number of repetitions a quantifier allows, or `Infinity`. A
 * quantifier that can repeat at most once (`?`, `{0,1}`, `{1}`) cannot multiply.
 */
function maxRepeatsAt(pattern: string, i: number): number {
  const c = pattern[i];
  if (c === "*" || c === "+") return Infinity;
  if (c === "?") return 1;
  if (c !== "{") return 0; // not a quantifier at all
  const close = pattern.indexOf("}", i);
  if (close === -1) return 0;
  const body = pattern.slice(i + 1, close);
  const bounded = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (!bounded) return 0;
  if (bounded[2] === undefined) return Number(bounded[1]); // {n}
  if (bounded[2] === "") return Infinity; // {n,}
  return Number(bounded[2]); // {n,m}
}

/**
 * How many different lengths the quantifier at `i` can consume — its branching
 * factor. `{4}` is 1 (no choice, so no backtracking), `?` is 2, `{1,50}` is 50,
 * and anything open-ended is treated as {@link UNBOUNDED_CHOICES}. Returns 1 when
 * there is no quantifier here, so it is multiplication-neutral.
 */
function quantifierChoicesAt(pattern: string, i: number): number {
  const c = pattern[i];
  if (c === "*" || c === "+") return UNBOUNDED_CHOICES;
  if (c === "?") return 2;
  if (c !== "{") return 1;
  const close = pattern.indexOf("}", i);
  if (close === -1) return 1;
  const bounded = /^(\d+)(?:,(\d*))?$/.exec(pattern.slice(i + 1, close));
  if (!bounded) return 1;
  if (bounded[2] === undefined) return 1; // {n} — exactly n, no choice
  if (bounded[2] === "") return UNBOUNDED_CHOICES; // {n,}
  return Math.max(1, Number(bounded[2]) - Number(bounded[1]) + 1); // {n,m}
}

/**
 * True when the quantifier at `i` can repeat more than once — the property that
 * makes nesting multiply.
 *
 * BOUNDED repetition counts. An earlier version tested only for unbounded
 * quantifiers, so `^(x{1,20}){1,20}$` sailed through: measured at **106 seconds**
 * for a single `test()` against an 80-character input, and `^(\w{1,9}){1,9}$`
 * took 12 seconds PER ATTACHMENT through the real junk-name path. Nested bounded
 * repeats multiply (20x20 = 400 ways to split each prefix) exactly as nested
 * unbounded ones do.
 */
function repeatingQuantifierAt(pattern: string, i: number): boolean {
  return maxRepeatsAt(pattern, i) > 1;
}

/** ASCII code points matched by a shorthand class, used for disjointness tests. */
function shorthandCharset(letter: string): Set<number> | null {
  const set = new Set<number>();
  const add = (pred: (c: number) => boolean, negate: boolean): Set<number> => {
    for (let c = 0; c < 128; c++) if (pred(c) !== negate) set.add(c);
    return set;
  };
  const isWord = (c: number): boolean =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const isDigit = (c: number): boolean => c >= 48 && c <= 57;
  const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
  switch (letter) {
    case "w": return add(isWord, false);
    case "W": return add(isWord, true);
    case "d": return add(isDigit, false);
    case "D": return add(isDigit, true);
    case "s": return add(isSpace, false);
    case "S": return add(isSpace, true);
    default: return null;
  }
}

/**
 * The set of ASCII characters an alternative's FIRST atom can match, or null when
 * we cannot model it. Two alternatives whose first atoms cannot match the same
 * character can never both consume the same input, so the alternation is
 * unambiguous and safe to repeat — that is what keeps sensible patterns like
 * `^(\w|-)+$` and `^(img|dsc|pxl)+$` usable.
 */
function firstAtomCharset(alt: string): Set<number> | null {
  if (alt.length === 0) return null; // an empty alternative under `+` loops forever
  const c = alt[0];

  if (c === "\\") {
    const next = alt[1];
    if (next === undefined) return null;
    const shorthand = shorthandCharset(next);
    if (shorthand) return shorthand;
    // An escaped literal (\., \-, \/ …). Control escapes are not modelled.
    if (/[a-zA-Z0-9]/.test(next)) return null;
    return new Set([next.charCodeAt(0)]);
  }

  if (c === "[") {
    const close = alt.indexOf("]", 1);
    if (close === -1) return null;
    const body = alt.slice(1, close);
    if (body.startsWith("^")) return null; // negated classes: don't guess
    const set = new Set<number>();
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\") {
        const shorthand = shorthandCharset(body[i + 1]);
        if (shorthand) for (const v of shorthand) set.add(v);
        else set.add(body.charCodeAt(i + 1));
        i++;
        continue;
      }
      if (body[i + 1] === "-" && body[i + 2] !== undefined && body[i + 2] !== "]") {
        for (let v = body.charCodeAt(i); v <= body.charCodeAt(i + 2); v++) set.add(v);
        i += 2;
        continue;
      }
      set.add(body.charCodeAt(i));
    }
    return set;
  }

  // A nested group, or `.` — too broad or too complex to model.
  if (c === "(" || c === ".") return null;
  // A quantifier or anchor leading an alternative is not a plain atom.
  if ("*+?{}|^$".includes(c)) return null;
  return new Set([c.charCodeAt(0)]);
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
  const upper = String.fromCodePoint(c).toUpperCase();
  if ([...upper].length !== 1) return c; // e.g. ß -> SS
  const u = upper.codePointAt(0) ?? c;
  // A non-ASCII character must not canonicalize into ASCII (spec rule; e.g. ſ -> S).
  if (c > 0x7f && u <= 0x7f) return c;
  return u;
}

/**
 * Fold a charset for case-insensitive comparison. BOTH callers compile with the
 * `i` flag (`namePatterns.ts` and `customRuleEngine.ts`), so `(a|A)+` — judged
 * disjoint on raw code points, {97} vs {65} — is actually two identical branches.
 *
 * This was ASCII-only at first, which left the whole of Latin-1 Supplement, Latin
 * Extended, Greek and Cyrillic unfolded: a sweep found **2,261** accepted
 * `^(lower|upper)+$` pairs that are identical under `i`. `^(é|É)+$` was accepted
 * and took over 20 seconds on a 64-character input.
 */
function caseFold(set: Set<number>): Set<number> {
  const folded = new Set<number>();
  for (const c of set) folded.add(canonicalize(c));
  return folded;
}

function setsIntersect(a: Set<number>, b: Set<number>): boolean {
  const [small, large] = a.size <= b.size ? [caseFold(a), caseFold(b)] : [caseFold(b), caseFold(a)];
  for (const v of small) if (large.has(v)) return true;
  return false;
}

/**
 * True when a group's alternatives might match the same text, which is what makes
 * repeating the group exponential.
 */
function alternativesAmbiguous(body: string, breaks: number[], groupStart: number): boolean {
  if (breaks.length === 0) return false; // no alternation at all
  const alts: string[] = [];
  let from = 0;
  for (const b of breaks) {
    alts.push(body.slice(from, b - groupStart - 1));
    from = b - groupStart;
  }
  alts.push(body.slice(from));

  const charsets: Set<number>[] = [];
  for (const alt of alts) {
    const set = firstAtomCharset(alt.trim());
    if (set === null) return true; // cannot prove disjoint -> assume the worst
    charsets.push(set);
  }
  for (let i = 0; i < charsets.length; i++) {
    for (let j = i + 1; j < charsets.length; j++) {
      if (setsIntersect(charsets[i], charsets[j])) return true;
    }
  }
  return false;
}

/**
 * Screen a user-supplied regex for shapes known to backtrack catastrophically,
 * and for patterns that simply will not compile.
 */
export function checkRegexSafety(pattern: string): RegexSafetyVerdict {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
  }

  const stack: GroupFrame[] = [];
  let inClass = false;
  let escaped = false;
  /** Running product of every quantifier's branching factor. */
  let searchSpace = 1;

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
      stack.push({ start: i, hasQuantifier: false, altBreaks: [] });
      continue;
    }

    if (c === ")") {
      const frame = stack.pop();
      if (!frame) continue; // unbalanced — `new RegExp` will reject it below
      const body = pattern.slice(frame.start + 1, i);
      const ambiguous =
        frame.hasQuantifier || alternativesAmbiguous(body, frame.altBreaks, frame.start);
      // A repeated group whose body is itself ambiguous is the classic
      // exponential shape: (a+)+, (\w+\s?)+, (a|aa)*, (x{1,20}){1,20}.
      if (ambiguous && repeatingQuantifierAt(pattern, i + 1)) {
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

    // The search-space budget applies at EVERY nesting level, not just inside a
    // group: a chain of quantifiers with no group at all is the second documented
    // blow-up shape, and it has a bounded variant (`a{1,50}` x6) as well as an
    // unbounded one (`a+` x6).
    searchSpace *= quantifierChoicesAt(pattern, i);
    if (searchSpace > MAX_SEARCH_SPACE) {
      return {
        safe: false,
        reason:
          "Pattern chains too many open-ended or wide repeats (like `a+a+a+a+` or " +
          "`a{1,50}a{1,50}a{1,50}`). This can hang Obsidian — simplify it.",
      };
    }
    // Mark the enclosing group ambiguous for ANY repeating quantifier, bounded or
    // not — `(x{1,20})` is just as multiplicative as `(x+)` once repeated.
    if (stack.length > 0 && repeatingQuantifierAt(pattern, i)) {
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
