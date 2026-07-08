import assert from "node:assert";
import { buildMarkdownReport } from "../src/core/reports/markdownReport";
import { makeIssue } from "./_helpers";

const md = buildMarkdownReport({
  scannedAt: "2026-07-06 10:00",
  profileName: "Monthly cleanup",
  totalFiles: 42,
  issues: [
    makeIssue({ attachmentPath: "assets/a.png", issueType: "unused", sizeBytes: 1024 * 1024, reason: "Not referenced by any note" }),
    makeIssue({ attachmentPath: "assets/b.png", issueType: "unused", sizeBytes: 1024 * 1024, reason: "Not referenced by any note" }),
    makeIssue({ attachmentPath: "x1", issueType: "duplicate", clusterId: "h", sizeBytes: 2048, reason: "dup", details: "Same content as: x2" }),
    makeIssue({ attachmentPath: "x2", issueType: "duplicate", clusterId: "h", sizeBytes: 2048, reason: "dup" }),
  ],
});

assert.ok(md.includes("# Attachment Audit Report"));
assert.ok(md.includes("Profile: Monthly cleanup"));
assert.ok(md.includes("Attachments scanned: 42"));
assert.ok(md.includes("Reclaimable now (unused): 2 MB"));
assert.ok(md.includes("In duplicate copies: 2 KB"));
// Section headers only for present types.
assert.ok(md.includes("## Unused"));
assert.ok(md.includes("## Duplicates"));
assert.ok(!md.includes("## Large files"));
// Embed-safe full-path links with size.
assert.ok(md.includes("[[assets/a.png]]"));
assert.ok(md.includes("(1 MB)"));
// Details preferred over reason when present.
assert.ok(md.includes("Same content as: x2"));

console.log("markdownReport tests passed");
