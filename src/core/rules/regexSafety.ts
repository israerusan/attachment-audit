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
 *
 * The limit is CALIBRATED, not guessed. Measured worst case against a 255-char
 * basename, which is the cap `matchesJunkName` applies:
 *
 *      32,768 ->   9 ms      262,144 ->  49 ms
 *     147,456 ->  43 ms      786,432 -> 156 ms
 *
 * 64^3 keeps three open-ended repeats (`^\w+\w+\w+$`, `a+a+a+`) usable while
 * refusing the four-quantifier chains that cross 150 ms per attachment.
 */
const MAX_SEARCH_SPACE = UNBOUNDED_CHOICES ** 3; // 262,144 — three open-ended repeats

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
 * The complete set of characters a shorthand class matches, or `null` when that
 * set cannot be represented as a finite list of ASCII code points.
 *
 * ONLY `\w` and `\d` are modellable. Both are exactly ASCII by definition
 * ([A-Za-z0-9_] and [0-9]), so enumerating 0-127 captures them fully.
 *
 * The others are deliberately unmodellable, and getting this wrong was a real
 * hang:
 *  - `\W`, `\D`, `\S` are COMPLEMENTS, so they match every non-ASCII character.
 *    Enumerating only 0-127 made `^(\S|é)+$` look like two disjoint branches
 *    when the engine sees one — measured 1,983 ms at 29 characters, and a sweep
 *    of U+0080-U+2FFF found 36,463 such accepted patterns.
 *  - `\s` is not ASCII either: it includes U+00A0, U+2028, U+FEFF and the
 *    U+2000-U+200A range.
 *
 * Returning `null` makes the caller treat the alternation as ambiguous, which is
 * the safe direction: it can only cause a pattern to be refused, never accepted.
 */
function shorthandCharset(letter: string): Set<number> | null {
  const set = new Set<number>();
  const addWhere = (pred: (c: number) => boolean): Set<number> => {
    for (let c = 0; c < 128; c++) if (pred(c)) set.add(c);
    return set;
  };
  const isWord = (c: number): boolean =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const isDigit = (c: number): boolean => c >= 48 && c <= 57;
  switch (letter) {
    case "w": return addWhere(isWord);
    case "d": return addWhere(isDigit);
    default: return null; // \W \D \S \s and every other escape: not ASCII-bounded
  }
}

/**
 * Index of the `]` that closes a character class starting at 0, honouring
 * backslash escapes, or -1. `indexOf("]")` was wrong: for `[\]]` it found the
 * ESCAPED bracket, truncating the class body to a lone backslash. The parser
 * then read past the end, added `NaN` to the charset, and `String.fromCodePoint`
 * threw an uncaught `RangeError` — which escaped all three call sites, aborting
 * the scan and breaking the settings tab so the offending pattern could not even
 * be deleted.
 */
function classTerminator(alt: string): number {
  for (let k = 1; k < alt.length; k++) {
    if (alt[k] === "\\") {
      k++; // skip whatever is escaped, including `]` and `\`
      continue;
    }
    if (alt[k] === "]") return k;
  }
  return -1;
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
    const close = classTerminator(alt);
    if (close === -1) return null;
    const body = alt.slice(1, close);
    if (body.startsWith("^")) return null; // negated classes: don't guess
    if (body.length === 0) return null; // `[]` matches nothing — not worth modelling
    const set = new Set<number>();
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\") {
        const next = body[i + 1];
        if (next === undefined) return null; // trailing backslash
        const shorthand = shorthandCharset(next);
        if (shorthand) {
          for (const v of shorthand) set.add(v);
          i++;
          continue;
        }
        // An alphanumeric escape we did not model is a control or numeric
        // sequence (`\x41`, `A`, `\t`, `\cA`, `\S`) whose VALUE is not the
        // letter itself. Treating it as the literal letter attributed it to the
        // wrong code point and cleared genuinely overlapping alternations:
        // `^(?:[\x41]|A)+$` was accepted while the engine sees `(A|A)+`.
        if (/[a-zA-Z0-9]/.test(next)) return null;
        set.add(body.charCodeAt(i + 1)); // escaped punctuation is its own literal
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
    return set.size > 0 ? set : null;
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
function alternativesAmbiguous(body: string, breaks: number[], bodyStart: number): boolean {
  if (breaks.length === 0) return false; // no alternation at all
  const alts: string[] = [];
  let from = 0;
  for (const b of breaks) {
    alts.push(body.slice(from, b - bodyStart));
    from = b - bodyStart + 1;
  }
  alts.push(body.slice(from));

  const charsets: Set<number>[] = [];
  for (const alt of alts) {
    // NOT trimmed: a leading space is a real atom, and analysing a different
    // string than the engine matches makes the disjointness proof unsound.
    const set = firstAtomCharset(alt);
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
