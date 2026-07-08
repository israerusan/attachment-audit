import assert from "node:assert";
import { selectDuplicateCopiesToTrash } from "../src/core/dedupe/duplicateTrashSelection";
import { makeIssue } from "./_helpers";
import type { AttachmentIssue } from "../src/types";

const dup = (path: string, cluster: string): AttachmentIssue =>
  makeIssue({ attachmentPath: path, issueType: "duplicate", clusterId: cluster });

// 1. A referenced copy (inbound > 0) is never trashed.
{
  const all = [dup("a", "h"), dup("b", "h")];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["a", "b"]), new Map([["a", 1]]));
  assert.deepStrictEqual(out, ["b"]);
}

// 2. A copy not in the two-signal unused set is never trashed.
{
  const all = [dup("a", "h"), dup("b", "h")];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["b"]), new Map());
  assert.deepStrictEqual(out, ["b"]);
}

// 3. When every copy is eligible, exactly one is kept (never trash the last copy).
{
  const all = [dup("a", "h"), dup("b", "h")];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["a", "b"]), new Map());
  assert.strictEqual(out.length, 1);
  assert.ok(["a", "b"].includes(out[0]));
}

// 4. A single-member cluster is untouchable (the sole copy survives).
{
  const all = [dup("a", "h")];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["a"]), new Map());
  assert.deepStrictEqual(out, []);
}

// 5. Selection scope respected — unselected copies are never trashed.
{
  const all = [dup("a", "h"), dup("b", "h"), dup("c", "h")];
  const out = selectDuplicateCopiesToTrash([all[0]], all, new Set(["a", "b", "c"]), new Map());
  assert.deepStrictEqual(out, ["a"]);
}

// 6. Keep-one is applied per cluster, independently.
{
  const all = [dup("a", "h1"), dup("b", "h1"), dup("c", "h2"), dup("d", "h2")];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["a", "b", "c", "d"]), new Map());
  assert.strictEqual(out.length, 2); // one survivor per cluster
}

// 7. Non-duplicate / no-clusterId selections are ignored.
{
  const all = [makeIssue({ attachmentPath: "x", issueType: "large" })];
  const out = selectDuplicateCopiesToTrash(all, all, new Set(["x"]), new Map());
  assert.deepStrictEqual(out, []);
}

console.log("duplicateTrashSelection tests passed");
