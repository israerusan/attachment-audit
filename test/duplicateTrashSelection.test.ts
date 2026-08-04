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

// --- Survivors must exist ON DISK, not merely in the last scan --------------
// "At least one copy always survives" previously rested entirely on the vault's
// delete event having fired and pruned the scan results. A copy deleted outside
// Obsidian — or an event missed during a sync — left a phantom survivor in the
// list and let the real last copy be trashed.
{
  const dup = (path: string): AttachmentIssue => ({
    id: `${path}::duplicate`,
    attachmentPath: path,
    attachmentName: path,
    issueType: "duplicate",
    severity: 3,
    reason: "identical",
    sizeBytes: 10,
    clusterId: "hash-1",
  });
  const a = dup("a.png");
  const b = dup("b.png");
  const all = [a, b];
  const unused = new Set(["a.png", "b.png"]);
  const inbound = new Map<string, number>();

  // Both on disk, only `a` selected: `b` survives, so `a` may go.
  assert.deepStrictEqual(
    selectDuplicateCopiesToTrash([a], all, unused, inbound, () => true),
    ["a.png"]
  );

  // `b` is already gone from disk (stale scan). `a` is now the LAST copy and
  // must be kept, even though the scan still lists `b` as a cluster member.
  assert.deepStrictEqual(
    selectDuplicateCopiesToTrash([a], all, unused, inbound, (p) => p !== "b.png"),
    [],
    "the last surviving copy on disk is never trashed"
  );

  // Selecting BOTH with both present still keeps one.
  assert.strictEqual(
    selectDuplicateCopiesToTrash([a, b], all, unused, inbound, () => true).length,
    1,
    "keep-one still applies when every copy is selected"
  );

  // Omitting the existence probe preserves the old behaviour (used by callers
  // that have no filesystem, and by the pure tests above).
  assert.deepStrictEqual(selectDuplicateCopiesToTrash([a], all, unused, inbound), ["a.png"]);
}

console.log("duplicateTrashSelection survivor-existence tests passed");
