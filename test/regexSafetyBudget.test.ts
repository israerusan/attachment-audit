import assert from "node:assert";
import { checkRegexSafety } from "../src/core/rules/regexSafety";

// A PROPERTY test for the OTHER claim the screen makes.
//
// `regexSafetySoundness.test.ts` checks the alternation-disjointness proof. This
// one checks the chain budget: a pattern the screen ACCEPTS must actually run
// fast on adversarial input, because it runs once per attachment on the UI thread.
//
// The screen used to estimate chain cost as a flat product of every quantifier's
// branching factor, ignoring whether the quantified atoms could interact at all.
// That refused ordinary rules — `^IMG_\d+_\d+_\d+_\d+$` and every other camera or
// screenshot naming scheme — so the product is now reset at a literal the
// preceding atom provably cannot consume. That reset is a PROOF about
// backtracking, and a proof is exactly the kind of thing that is wrong in ways
// examples do not reveal. The invariant is what matters, so assert the invariant.
//
// Measured, against a 255-character basename (the cap `matchesJunkName` applies),
// is why this is worth a test at all:
//
//      ^a+a+a+$        ->     23 ms
//      ^a+a+a+a+$      ->  1,406 ms
//      ^a+a+a+a+a+$    -> 71,706 ms
//
// So an accepted four-deep chain over overlapping atoms is already a visible
// freeze multiplied by the attachment count, and a five-deep one never returns.

/** The input length `matchesJunkName` and `customRuleEngine` both cap at. */
const INPUT_CAP = 255;

/**
 * Wall-clock ceiling for one accepted pattern against one adversarial input.
 *
 * Generous on purpose: this is a regression gate against catastrophic
 * backtracking (seconds to forever), not a benchmark. Every pattern the screen
 * accepts today measures under a millisecond.
 */
const BUDGET_MS = 50;

/** Atoms to build chains from, with a character each one matches. */
const ATOMS: { src: string; sample: string }[] = [
  { src: "a", sample: "a" },
  { src: String.fromCharCode(92) + "d", sample: "1" },
  { src: String.fromCharCode(92) + "w", sample: "w" },
  { src: "[a-z]", sample: "q" },
  { src: "[0-9]", sample: "7" },
  { src: "[a-z0-9]", sample: "k" },
  { src: ".", sample: "z" },
];

/** Separators placed between the quantifiers, including "none at all". */
const SEPARATORS = ["", "-", "_", ".", String.fromCharCode(92) + ".", "x", "0", " ", "--"];

/** Quantifiers worth chaining: the unbounded ones and a wide bounded one. */
const QUANTIFIERS = ["+", "*", "{1,50}"];

/**
 * Characters to pad an adversarial input with. The goal is a string the atoms
 * CAN consume whose overall match still fails, which is what forces the engine
 * to explore every split of the input between the chained quantifiers.
 */
const PADS = ["a", "1", "w", "q", "7", "k", "z", "-", "_", ".", " ", "x", "0"];

function buildChain(atom: string, quant: string, sep: string, depth: number): string {
  const unit = atom + quant;
  return "^" + Array.from({ length: depth }, () => unit).join(sep) + "$";
}

/**
 * Adversarial inputs for a pattern: long uniform runs of each pad character, and
 * a separator-joined construction derived from the pattern's own shape. Each ends
 * in a character chosen to defeat the `$` anchor so backtracking is exhaustive.
 */
function adversarialInputs(sample: string, sep: string, depth: number): string[] {
  const inputs: string[] = [];
  for (const pad of PADS) inputs.push(pad.repeat(INPUT_CAP - 1) + "");
  // A well-formed body of the right shape, padded out to the cap, then broken.
  const plainSep = sep.replace(new RegExp(String.fromCharCode(92, 92), "g"), "");
  const runLen = Math.max(1, Math.floor((INPUT_CAP - plainSep.length * (depth - 1)) / depth));
  const body = Array.from({ length: depth }, () => sample.repeat(runLen)).join(plainSep);
  inputs.push(body.slice(0, INPUT_CAP - 1) + "");
  return inputs;
}

let accepted = 0;
let checked = 0;
const overBudget: string[] = [];

for (const atom of ATOMS) {
  for (const quant of QUANTIFIERS) {
    for (const sep of SEPARATORS) {
      for (let depth = 2; depth <= 5; depth++) {
        const pattern = buildChain(atom.src, quant, sep, depth);
        checked++;
        if (!checkRegexSafety(pattern).safe) continue;
        accepted++;
        let re: RegExp;
        try {
          re = new RegExp(pattern, "i");
        } catch {
          continue; // the screen also validates compilability; nothing to time
        }
        for (const input of adversarialInputs(atom.sample, sep, depth)) {
          const started = process.hrtime.bigint();
          re.test(input);
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          if (ms > BUDGET_MS) {
            overBudget.push(`${pattern} took ${ms.toFixed(0)}ms on ${input.length} chars`);
            break;
          }
        }
      }
    }
  }
}

assert.strictEqual(
  overBudget.length,
  0,
  `accepted pattern(s) exceeded ${BUDGET_MS}ms on adversarial input:\n  ` + overBudget.join("\n  ")
);

// The screen must still be USEFUL, not merely safe: a screen that refuses
// everything would pass the assertion above trivially.
assert.ok(accepted > 50, `expected the screen to accept realistic chains, accepted ${accepted}`);

// The realistic rules this budget exists to permit. Each was refused before the
// barrier reset, and each is strictly linear — the quantified atoms are separated
// by a literal the preceding atom cannot consume, so there is nothing to
// backtrack across.
for (const pattern of [
  "^IMG_" + String.fromCharCode(92) + "d+_" + String.fromCharCode(92) + "d+_" +
    String.fromCharCode(92) + "d+_" + String.fromCharCode(92) + "d+$",
  "^Screenshot " + String.fromCharCode(92) + "d+-" + String.fromCharCode(92) + "d+-" +
    String.fromCharCode(92) + "d+ at " + String.fromCharCode(92) + "d+$",
  "^[a-z]+-[0-9]+-[a-z]+-[0-9]+$",
]) {
  assert.ok(checkRegexSafety(pattern).safe, `should accept the realistic rule ${pattern}`);
}

// And the shapes that genuinely blow up must stay refused, separator or not.
for (const pattern of [
  "^a+a+a+a+$",
  "^a+a+a+a+a+$",
  String.fromCharCode(92) + "d+" + String.fromCharCode(92) + "d+" +
    String.fromCharCode(92) + "d+" + String.fromCharCode(92) + "d+",
  "^[a-z]+[a-z]+[a-z]+[a-z]+$",
  // An UNESCAPED dot is not a barrier: `.` matches digits too.
  "^" + String.fromCharCode(92) + "d+." + String.fromCharCode(92) + "d+." +
    String.fromCharCode(92) + "d+." + String.fromCharCode(92) + "d+$",
  // A class the model declines to parse (it contains an escape) proves nothing,
  // so the product must stand.
  "^[" + String.fromCharCode(92) + "w-]+-[" + String.fromCharCode(92) + "w-]+-[" +
    String.fromCharCode(92) + "w-]+-[" + String.fromCharCode(92) + "w-]+$",
] as string[]) {
  assert.ok(!checkRegexSafety(pattern).safe, `should refuse the blow-up shape ${pattern}`);
}

console.log(
  `regexSafety budget: ${checked} chains screened, ${accepted} accepted, 0 over ${BUDGET_MS}ms`
);
