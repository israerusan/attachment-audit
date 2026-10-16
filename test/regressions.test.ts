import assert from "node:assert";
import { findMissingAttachments } from "../src/core/detectors/missingDetector";
import { matchesJunkName, DEFAULT_JUNK_NAME_PATTERNS as JUNK } from "../src/core/naming/namePatterns";
import { normalizeSettings } from "../src/core/settings/normalize";
import { DEFAULT_SETTINGS } from "../src/core/settings/defaults";
import { buildMarkdownReport } from "../src/core/reports/markdownReport";
import {
  couldBeTrashedAs,
  indexTrashListing,
  trashCandidatePaths,
  selectTrashCandidate,
  type TrashCandidate,
} from "../src/core/journal/trashCandidates";
import { runCustomRules } from "../src/core/rules/customRuleEngine";
import type { AttachmentIssue, AttachmentStat, CustomRule } from "../src/types";

const norm = (over: Record<string, unknown>): Record<string, unknown> =>
  normalizeSettings(
    structuredClone({ ...DEFAULT_SETTINGS, ...over }) as never,
    DEFAULT_SETTINGS
  ) as unknown as Record<string, unknown>;

// =============================================================== broken links
// `extensionOf` is "everything after the last dot" with no shape constraint, so
// filtering unresolved links on "has an extension that is not md/canvas/base"
// reported ordinary note links as broken ATTACHMENTS: `[[2024.01.15]]` has
// extension `15`, `[[v1.2 plan]]` has `2 plan`, `[[Dr. Smith notes]]` has
// ` Smith notes`. Dotted daily notes and forward links to uncreated notes are
// completely normal Obsidian usage, so this was guaranteed, permanent noise —
// one severity-3 issue per link, on every scan.
{
  const found = findMissingAttachments({
    "A.md": {
      "2024.01.15": 1,
      "v1.2 plan": 1,
      "Dr. Smith notes": 1,
      "README": 1,
      "Some Note": 1,
      "assets/real.png": 1,
    },
  }).map((e) => e.link);
  assert.deepStrictEqual(found, ["assets/real.png"], "only the real attachment is reported");
}
// Recognised attachment extensions still report, including aliased and anchored
// links, and regardless of case.
for (const link of ["a.PNG", "x.webp|thumb", "docs/report.pdf", "clip.mp4", "font.woff2"]) {
  const found = findMissingAttachments({ "A.md": { [link]: 1 } });
  assert.strictEqual(found.length, 1, `${link} must still be reported`);
}
// External URLs are never vault attachments.
for (const link of ["https://example.com/a.png", "//cdn/a.png"]) {
  assert.deepStrictEqual(findMissingAttachments({ "A.md": { [link]: 1 } }), []);
}

// ============================================================ junk-name anchors
// `^Screenshot[ _]` and `^Untitled` had no right-hand anchor, so deliberately
// named files matched a FREE-TIER DEFAULT with nothing edited by the user.
assert.ok(!matchesJunkName("Screenshot workflow diagram", JUNK), "a named file is not junk");
assert.ok(!matchesJunkName("Untitled Symphony No. 5 score", JUNK), "nor is this");
assert.ok(!matchesJunkName("Screen Shot of the proposal", JUNK));
// ...while every real auto-generated name on every platform still matches.
for (const name of [
  "Screenshot 2026-01-01 at 10.00.00",
  "Screenshot_20240101-100000",
  "Screenshot (1)",
  "Screen Shot 2019-04-02 at 11.11.11",
  "Untitled",
  "Untitled 3",
  "Pasted image 20240101120000",
  "IMG_1234",
  "DSC-0001",
  "image (2)",
  "download",
]) {
  assert.ok(matchesJunkName(name, JUNK), `${name} must still be flagged`);
}

// ======================================================= untrusted data.json
// A NEGATIVE `days` made `older-than-days` fire on every attachment in the vault
// — `now - mtime > days * MS_PER_DAY` is true for all of them. `kb` was already
// defended downstream; `days` was not.
{
  const s = norm({
    customRules: [
      { id: "r1", name: "r", condition: { type: "older-than-days", days: -1 }, severity: 3 },
    ],
  });
  const rules = s.customRules as CustomRule[];
  assert.strictEqual(
    (rules[0].condition as { days: number }).days,
    0,
    "a negative age is clamped, not carried into the engine"
  );
  const stat: AttachmentStat = {
    path: "a.png",
    name: "a.png",
    basename: "a",
    extension: "png",
    size: 1,
    mtime: 1000,
    inboundLinks: 0,
  };
  assert.deepStrictEqual(
    runCustomRules(stat, rules, 1000),
    [],
    "and a zero-age rule does not fire on a file modified right now"
  );
}
// A traversal segment in the attachment folder reaches `createFolder` and every
// move target. `normalizePath` does not resolve `..`, so refuse it outright.
for (const folder of ["../outside", "assets/../../outside", "..", "assets\\..\\out"]) {
  assert.strictEqual(
    norm({ attachmentFolder: folder }).attachmentFolder,
    DEFAULT_SETTINGS.attachmentFolder,
    `${folder} must be rejected`
  );
}
assert.strictEqual(norm({ attachmentFolder: "assets/images" }).attachmentFolder, "assets/images");
// A legitimate name that merely CONTAINS dots is not a traversal.
assert.strictEqual(norm({ attachmentFolder: "assets/..images" }).attachmentFolder, "assets/..images");

// The schema version must never be LOWERED. `migrateRawSettings` deliberately
// leaves a newer blob untouched; stamping the current version here undid that as
// soon as anything triggered a save, and the next launch of the newer build would
// re-run migrations over already-migrated data.
{
  const current = norm({}).version as number;
  assert.strictEqual(norm({ version: current + 2 }).version, current + 2, "never downgraded");
  assert.strictEqual(norm({ version: 0 }).version, current, "an older one is brought forward");
  assert.strictEqual(norm({ version: undefined }).version, current);
}

// ========================================================== report link safety
// `[`, `]`, `#` and `|` all terminate or re-interpret a wikilink, and all four are
// legal in filenames. `assets/a|b.png` rendered as a link to `assets/a` aliased
// `b.png`.
{
  const issue = (path: string): AttachmentIssue => ({
    id: path,
    attachmentPath: path,
    attachmentName: path.slice(path.lastIndexOf("/") + 1),
    issueType: "unused",
    severity: 3,
    reason: "Nothing links to it",
    sizeBytes: 100,
  });
  const report = buildMarkdownReport({
    scannedAt: "2026-10-15 00:00",
    totalFiles: 3,
    issues: [issue("assets/a|b.png"), issue("assets/c#1.png"), issue("assets/plain.png")],
  });
  assert.ok(report.includes("`assets/a|b.png`"), "a piped path becomes a code span");
  assert.ok(report.includes("`assets/c#1.png`"), "so does an anchored one");
  assert.ok(!report.includes("[[assets/a|b.png]]"), "and never a broken wikilink");
  assert.ok(report.includes("[[assets/plain.png]]"), "an ordinary path still links");
}

// ============================================================== trash indexing
// Restoring used to re-scan the whole `.trash` listing per journal entry. At
// MAX_JOURNAL_ENTRIES (5,000) against a 50,000-file trash that measured 250
// million comparisons and 145 SECONDS of frozen UI. The index must answer exactly
// what the predicate answered, by lookup.
{
  const listing = [
    ".trash/logo.png",
    ".trash/logo 1.png",
    ".trash/logo (2).png",
    ".trash/logo.jpg",
    ".trash/logotype.png",
    ".trash/IMG_1234.png",
    ".trash/report 2024.pdf",
  ];
  const index = indexTrashListing(listing);
  const got = trashCandidatePaths(index, "logo.png").sort();
  assert.deepStrictEqual(
    got,
    [".trash/logo (2).png", ".trash/logo 1.png", ".trash/logo.png"],
    "the name plus its bounded collision forms, and nothing else"
  );
  // The narrowness the predicate is documented to have is preserved: these are
  // ordinary filenames, not collision suffixes.
  assert.deepStrictEqual(trashCandidatePaths(index, "IMG.png"), []);
  assert.deepStrictEqual(trashCandidatePaths(index, "report.pdf"), []);
  assert.deepStrictEqual(trashCandidatePaths(index, "nothing.png"), []);
  // A different extension is a different file.
  assert.deepStrictEqual(trashCandidatePaths(index, "logo.jpg"), [".trash/logo.jpg"]);
}

// The index is an OPTIMIZATION, so the thing to test is that it changed nothing.
// Differential against the predicate it replaced, over names chosen to include
// every shape that has caused trouble: collision suffixes, ordinary numeric
// names, NFC/NFD pairs, and extension look-alikes.
{
  const names = [
    "logo.png", "logo 1.png", "logo 99.png", "logo 100.png", "logo (1).png",
    "logo (99).png", "logo (100).png", "logo-1.png", "logo_1.png", "logo.PNG",
    "logotype.png", "logo.png.png", "report 2024.pdf", "report.pdf",
    "IMG_1234.png", "IMG.png", "Screenshot 2023.png", "Screenshot.png",
    "café.png", "café.png", "a.png", "a 1.png", "noext", "noext 1",
    ".hidden", "two.dots.png", "two.dots 1.png",
  ];
  const listing = names.map((n) => `.trash/${n}`);
  const index = indexTrashListing(listing);
  for (const wanted of names) {
    const byScan = listing
      .filter((p) => couldBeTrashedAs(p.slice(p.lastIndexOf("/") + 1), wanted))
      .sort();
    const byIndex = trashCandidatePaths(index, wanted).sort();
    assert.deepStrictEqual(
      byIndex,
      byScan,
      `index and predicate must agree for ${JSON.stringify(wanted)}`
    );
  }
}

// ===================================================== same-name batch restore
// When ONE batch trashes two files sharing a basename, name and size cannot tell
// the entries apart, and the `exactName` preference actively picks wrong: the
// unsuffixed trash file is not preferentially either entry's. Restoring in reverse
// order gave one entry the unsuffixed file and the other whatever was left, so
// both paths came back holding the other's content — reported as a clean success.
{
  const candidates: TrashCandidate[] = [
    { path: ".trash/logo.png", size: 100, mtime: 5 },
    { path: ".trash/logo 1.png", size: 100, mtime: 5 },
  ];
  const withoutHash = selectTrashCandidate(
    candidates,
    { from: "b/logo.png", sizeBytes: 100, mtime: 5 },
    { requireContentMatch: true }
  );
  assert.strictEqual(withoutHash.found, null, "no content proof, no restore");
  assert.strictEqual(withoutHash.found === null ? withoutHash.reason : "", "ambiguous");

  // With hashes recorded, each entry is identified by content and restored.
  const hashed: TrashCandidate[] = [
    { path: ".trash/logo.png", size: 100, mtime: 5, headHash: "aaa" },
    { path: ".trash/logo 1.png", size: 100, mtime: 5, headHash: "bbb" },
  ];
  const b = selectTrashCandidate(
    hashed,
    { from: "b/logo.png", sizeBytes: 100, mtime: 5, headHash: "bbb" },
    { requireContentMatch: true }
  );
  assert.strictEqual(b.found?.path, ".trash/logo 1.png");
  const a = selectTrashCandidate(
    hashed,
    { from: "a/logo.png", sizeBytes: 100, mtime: 5, headHash: "aaa" },
    { requireContentMatch: true }
  );
  assert.strictEqual(a.found?.path, ".trash/logo.png");
}
// A UNIQUE basename in the batch is unaffected: no flag, no extra requirement.
{
  const outcome = selectTrashCandidate(
    [{ path: ".trash/solo.png", size: 100, mtime: 5 }],
    { from: "x/solo.png", sizeBytes: 100, mtime: 5 }
  );
  assert.strictEqual(outcome.found?.path, ".trash/solo.png");
}

console.log("regressions tests passed");
