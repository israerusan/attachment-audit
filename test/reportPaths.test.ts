import assert from "node:assert";
import { isGeneratedReport } from "../src/core/reports/reportPaths";

const FOLDER = "Attachment Audit Reports";

// --- Files WE generated are discounted from both safety signals --------------
assert.ok(isGeneratedReport(`${FOLDER}/Report 2026-08-03-18-30-00.md`, FOLDER));
// ...including the collision-suffixed form `uniqueReportPath` produces.
assert.ok(isGeneratedReport(`${FOLDER}/Report 2026-08-03-18-30-00 (2).md`, FOLDER));
assert.ok(isGeneratedReport(`${FOLDER}/Report 2026-12-31-23-59-59 (17).md`, FOLDER));

// --- A user's own note in that folder is a REAL source ----------------------
// This is the data-loss case the old whole-folder prefix match caused: an
// attachment embedded only from Index.md looked unused and could be trashed.
assert.ok(!isGeneratedReport(`${FOLDER}/Index.md`, FOLDER));
assert.ok(!isGeneratedReport(`${FOLDER}/My notes on the report.md`, FOLDER));
// A report the user RENAMED is theirs now, and must be honoured as a source.
assert.ok(!isGeneratedReport(`${FOLDER}/Report from August.md`, FOLDER));
// Near-misses on the timestamp shape are not ours.
assert.ok(!isGeneratedReport(`${FOLDER}/Report 2026-08-03.md`, FOLDER));
assert.ok(!isGeneratedReport(`${FOLDER}/Report .md`, FOLDER));
assert.ok(!isGeneratedReport(`${FOLDER}/report 2026-08-03-18-30-00.md`, FOLDER), "case-sensitive");

// --- Only the folder's TOP level, and only that folder ----------------------
assert.ok(!isGeneratedReport(`${FOLDER}/sub/Report 2026-08-03-18-30-00.md`, FOLDER));
assert.ok(!isGeneratedReport(`Elsewhere/Report 2026-08-03-18-30-00.md`, FOLDER));
assert.ok(!isGeneratedReport(`${FOLDER}`, FOLDER), "the folder itself is not a report");
// A sibling folder sharing the prefix must not be swallowed.
assert.ok(!isGeneratedReport(`${FOLDER} Archive/Report 2026-08-03-18-30-00.md`, FOLDER));

// --- Only markdown ----------------------------------------------------------
assert.ok(!isGeneratedReport(`${FOLDER}/Report 2026-08-03-18-30-00.png`, FOLDER));

console.log("reportPaths tests passed");
