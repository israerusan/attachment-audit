import assert from "node:assert";
import { computeReclaim } from "../src/core/reclaim/reclaimableSpace";
import { makeIssue } from "./_helpers";

// Unused bytes sum over DISTINCT paths (a file flagged unused + large counts once).
const r1 = computeReclaim([
  makeIssue({ attachmentPath: "a.png", issueType: "unused", sizeBytes: 100 }),
  makeIssue({ attachmentPath: "a.png", issueType: "large", sizeBytes: 100 }),
  makeIssue({ attachmentPath: "b.png", issueType: "unused", sizeBytes: 250 }),
]);
assert.strictEqual(r1.unusedBytes, 350); // 100 + 250, not 450
assert.strictEqual(r1.duplicateExtraBytes, 0);

// Duplicate extra bytes = (copies - 1) * size, per cluster.
const r2 = computeReclaim([
  makeIssue({ attachmentPath: "x1", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x2", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x3", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
]);
assert.strictEqual(r2.duplicateExtraBytes, 1000); // keep one of three 500B copies

// A duplicate cluster with no clusterId contributes nothing.
const r3 = computeReclaim([makeIssue({ issueType: "duplicate", sizeBytes: 999 })]);
assert.strictEqual(r3.duplicateExtraBytes, 0);

// A cluster whose copies are ALSO unused: the two figures stay independent and
// unusedBytes never folds in duplicateExtraBytes (no double-count in the headline).
const r4 = computeReclaim([
  makeIssue({ attachmentPath: "x1", issueType: "unused", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x1", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x2", issueType: "unused", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x2", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x3", issueType: "unused", sizeBytes: 500 }),
  makeIssue({ attachmentPath: "x3", issueType: "duplicate", clusterId: "h", sizeBytes: 500 }),
]);
assert.strictEqual(r4.unusedBytes, 1500); // 3 distinct unused paths × 500
assert.strictEqual(r4.duplicateExtraBytes, 1000); // (3 − 1) × 500

console.log("reclaimableSpace tests passed");
