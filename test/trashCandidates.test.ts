import assert from "node:assert";
import {
  couldBeTrashedAs,
  explainOutcome,
  selectTrashCandidate,
  type TrashCandidate,
} from "../src/core/journal/trashCandidates";

const BACKSLASH = String.fromCharCode(92);
assert.strictEqual(BACKSLASH.charCodeAt(0), 92, "fixture integrity");

const c = (path: string, size: number, mtime = 1000): TrashCandidate => ({ path, size, mtime });

// --- The defect this module exists for --------------------------------------
// Size was once a PREFERENCE, not a gate: a lone name-match was restored however
// wrong it was. That moved a 50 KB stranger onto the path of a 2 MB file, reported
// success, and consumed the stranger from `.trash` — so Obsidian's own recovery
// could no longer reach it either. Two losses from one click.
{
  const out = selectTrashCandidate([c(".trash/diagram.png", 51_000)], {
    from: "notes/diagram.png",
    sizeBytes: 2_000_000,
  });
  assert.strictEqual(out.found, null, "a lone candidate of the wrong size is NOT restored");
  assert.strictEqual(out.found === null ? out.reason : "", "no-match");
}

// The honest case still works.
{
  const out = selectTrashCandidate([c(".trash/diagram.png", 2_000_000)], {
    from: "notes/diagram.png",
    sizeBytes: 2_000_000,
  });
  assert.ok(out.found);
  assert.strictEqual(out.found?.path, ".trash/diagram.png");
}

// --- Ambiguity must REFUSE, not guess ---------------------------------------
// Same name, same size, no recorded mtime to separate them: there is no evidence
// left to choose on, and picking the newest would be a silent data swap.
{
  const out = selectTrashCandidate(
    [c(".trash/logo.png", 100, 5000), c(".trash/logo 1.png", 100, 9000)],
    { from: "a/logo.png", sizeBytes: 100 }
  );
  assert.strictEqual(out.found, null);
  assert.strictEqual(out.found === null ? out.reason : "", "ambiguous");
}
// ...but a recorded mtime that singles one out resolves it.
{
  const out = selectTrashCandidate(
    [c(".trash/logo.png", 100, 5000), c(".trash/logo 1.png", 100, 9000)],
    { from: "a/logo.png", sizeBytes: 100, mtime: 9000 }
  );
  assert.strictEqual(out.found?.path, ".trash/logo 1.png");
}
// An mtime matching BOTH is still ambiguous.
{
  const out = selectTrashCandidate(
    [c(".trash/logo.png", 100, 5000), c(".trash/logo 1.png", 100, 5000)],
    { from: "a/logo.png", sizeBytes: 100, mtime: 5000 }
  );
  assert.strictEqual(out.found, null);
}

// --- The suffix pattern must not swallow ordinary filenames -----------------
// `.trash` holds everything the user has EVER locally deleted, so the candidate
// pool is their whole deletion history. An earlier pattern (`stem[ _-]?\(?\d+\)?`)
// matched all of these, which are just normal attachment names.
assert.ok(!couldBeTrashedAs("report 2024.pdf", "report.pdf"), "a year is not a collision suffix");
assert.ok(!couldBeTrashedAs("IMG_1234.png", "IMG.png"));
assert.ok(!couldBeTrashedAs("Screenshot_2023.png", "Screenshot.png"));
assert.ok(!couldBeTrashedAs("IMG-9.png", "IMG.png"));
// Mismatched parens are produced by no collision scheme.
assert.ok(!couldBeTrashedAs("report(3.pdf", "report.pdf"));
assert.ok(!couldBeTrashedAs("report 3).pdf", "report.pdf"));

// What IS accepted: the exact name, and the two plausible collision forms.
assert.ok(couldBeTrashedAs("report.pdf", "report.pdf"));
assert.ok(couldBeTrashedAs("report 1.pdf", "report.pdf"));
assert.ok(couldBeTrashedAs("report (2).pdf", "report.pdf"));

// Extension must match, so a same-stem different-type file is never a candidate.
assert.ok(!couldBeTrashedAs("report.png", "report.pdf"));
assert.ok(!couldBeTrashedAs("report 1.png", "report.pdf"));

// Regex metacharacters in the name are literals, not patterns.
assert.ok(couldBeTrashedAs("a+b(c)[d].e.png", "a+b(c)[d].e.png"));
assert.ok(!couldBeTrashedAs("aXbYcZdWe.png", "a+b(c)[d].e.png"), "metacharacters are escaped");
assert.ok(couldBeTrashedAs("file.name.v2 1.tar", "file.name.v2.tar"), "only the LAST dot splits");

// Extension-less names work.
assert.ok(couldBeTrashedAs("LICENSE", "LICENSE"));
assert.ok(couldBeTrashedAs("LICENSE 1", "LICENSE"));
assert.ok(!couldBeTrashedAs("LICENSE_1", "LICENSE"));

// Case matters — two files differing only in case are different files.
assert.ok(!couldBeTrashedAs("Report.pdf", "report.pdf"));

// --- Nothing matches at all -------------------------------------------------
assert.strictEqual(
  selectTrashCandidate([c(".trash/other.png", 100)], { from: "a/logo.png", sizeBytes: 100 }).found,
  null
);
assert.strictEqual(selectTrashCandidate([], { from: "a/logo.png", sizeBytes: 100 }).found, null);

// --- A zero-byte file is still identified by name + size --------------------
{
  const out = selectTrashCandidate([c(".trash/empty.txt", 0)], { from: "a/empty.txt", sizeBytes: 0 });
  assert.strictEqual(out.found?.path, ".trash/empty.txt");
}
// ...but two zero-byte files with the same name are ambiguous, as they should be.
{
  const out = selectTrashCandidate(
    [c(".trash/empty.txt", 0, 1), c(".trash/empty 1.txt", 0, 2)],
    { from: "a/empty.txt", sizeBytes: 0 }
  );
  assert.strictEqual(out.found, null);
}

// --- Both refusal reasons explain themselves --------------------------------
for (const reason of ["no-match", "ambiguous"] as const) {
  assert.ok(explainOutcome(reason).length > 0);
}
assert.notStrictEqual(explainOutcome("no-match"), explainOutcome("ambiguous"));

console.log("trashCandidates tests passed");

// --- The counter bound ------------------------------------------------------
// A collision counter is small; a long digit run is almost always meaningful.
assert.ok(couldBeTrashedAs("report 9.pdf", "report.pdf"));
assert.ok(couldBeTrashedAs("report 12.pdf", "report.pdf"), "two digits still plausible");
assert.ok(!couldBeTrashedAs("report 123.pdf", "report.pdf"), "three is a number, not a counter");
assert.ok(!couldBeTrashedAs("report 2024.pdf", "report.pdf"));
assert.ok(couldBeTrashedAs("report (12).pdf", "report.pdf"));
assert.ok(!couldBeTrashedAs("report (2024).pdf", "report.pdf"));

// Even an accepted near-miss is gated by size — the name pattern is defence in
// depth, not the defence. `report 12.pdf` is a candidate but must match exactly.
{
  const out = selectTrashCandidate([c(".trash/report 12.pdf", 999)], {
    from: "docs/report.pdf",
    sizeBytes: 12345,
  });
  assert.strictEqual(out.found, null, "a plausible name with the wrong size is refused");
}

console.log("trashCandidates counter-bound tests passed");
