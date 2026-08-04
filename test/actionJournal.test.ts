import assert from "node:assert";
import {
  appendBatch,
  batchBytes,
  describeBatch,
  normalizeJournal,
  replaceBatch,
  restorability,
  DEFAULT_JOURNAL_LIMIT,
  MAX_JOURNAL_LIMIT,
  type JournalBatch,
} from "../src/core/journal/actionJournal";

const batch = (over: Partial<JournalBatch> = {}): JournalBatch => ({
  id: "b1",
  at: "2026-08-04T10:00:00.000Z",
  op: "trash",
  trashDestination: "local",
  entries: [{ from: "assets/a.png", sizeBytes: 100 }],
  ...over,
});

// --- Restorability: the load-bearing rules ----------------------------------
// Promising an undo the filesystem cannot deliver is worse than promising none,
// so the NEGATIVE cases matter more than the positive one.

// Local trash is inside the vault, so we can read it and move the file back.
assert.strictEqual(restorability(batch({ trashDestination: "local" })).restorable, true);

// The system recycle bin is not addressable from a plugin.
{
  const v = restorability(batch({ trashDestination: "system" }));
  assert.strictEqual(v.restorable, false);
  assert.ok(v.reason?.includes("system trash"), "says where to look instead");
}

// "Permanently delete" leaves nothing to restore, and must say so plainly.
{
  const v = restorability(batch({ trashDestination: "permanent" }));
  assert.strictEqual(v.restorable, false);
  assert.ok(v.reason && v.reason.length > 0);
}

// An unrecognised destination must fail CLOSED — never offer a restore we can't
// prove will work.
assert.strictEqual(restorability(batch({ trashDestination: "unknown" })).restorable, false);
assert.strictEqual(restorability(batch({ trashDestination: undefined })).restorable, false);

// Moves and renames are always reversible: the file still exists, and reversing
// through Obsidian re-updates the links it updated on the way out.
const moved = batch({
  op: "move",
  trashDestination: undefined,
  entries: [{ from: "a.png", to: "assets/a.png", sizeBytes: 10 }],
});
assert.strictEqual(restorability(moved).restorable, true);
assert.strictEqual(restorability({ ...moved, op: "rename" }).restorable, true);

// A batch can never be reverted twice.
{
  const v = restorability(batch({ revertedAt: "2026-08-04T11:00:00.000Z" }));
  assert.strictEqual(v.restorable, false);
  assert.ok(v.reason?.includes("Already"));
}

// An empty batch has nothing to offer.
assert.strictEqual(restorability(batch({ entries: [] })).restorable, false);

// --- Append and trim --------------------------------------------------------
{
  const journal = appendBatch([], batch({ id: "a" }), 3);
  assert.deepStrictEqual(journal.map((b) => b.id), ["a"]);
  // Newest first, so the history reads top-down and the trim drops the oldest.
  const two = appendBatch(journal, batch({ id: "b" }), 3);
  assert.deepStrictEqual(two.map((b) => b.id), ["b", "a"]);
  const four = appendBatch(
    appendBatch(appendBatch(two, batch({ id: "c" }), 3), batch({ id: "d" }), 3),
    batch({ id: "e" }),
    3
  );
  assert.deepStrictEqual(four.map((b) => b.id), ["e", "d", "c"], "trimmed to the cap");
}
// A limit of 0 records nothing at all.
assert.deepStrictEqual(appendBatch([batch()], batch({ id: "x" }), 0), []);
// The hard ceiling stops a corrupt setting growing data.json without bound.
assert.ok(appendBatch([], batch(), 10_000).length <= MAX_JOURNAL_LIMIT);
// Negative and fractional limits are handled rather than throwing.
assert.deepStrictEqual(appendBatch([], batch(), -5), []);
assert.strictEqual(appendBatch([], batch(), 2.7).length, 1);

// --- replaceBatch -----------------------------------------------------------
{
  const journal = [batch({ id: "a" }), batch({ id: "b" })];
  const marked = replaceBatch(journal, "b", (b) => ({ ...b, revertedAt: "2026-08-04T12:00:00.000Z" }));
  assert.strictEqual(marked[0].revertedAt, undefined, "other batches untouched");
  assert.ok(marked[1].revertedAt);
  // An unknown id is a no-op, not an error.
  assert.deepStrictEqual(replaceBatch(journal, "nope", (b) => ({ ...b, id: "!" })), journal);
}

// --- Sizes and descriptions -------------------------------------------------
assert.strictEqual(
  batchBytes(batch({ entries: [{ from: "a", sizeBytes: 10 }, { from: "b", sizeBytes: 5 }] })),
  15
);
assert.strictEqual(batchBytes(batch({ entries: [{ from: "a", sizeBytes: -10 }] })), 0, "no negatives");
assert.strictEqual(describeBatch(batch()), "Trashed 1 file");
assert.strictEqual(
  describeBatch(batch({ entries: [{ from: "a", sizeBytes: 1 }, { from: "b", sizeBytes: 1 }] })),
  "Trashed 2 files"
);
assert.strictEqual(describeBatch({ ...moved, op: "move" }), "Moved 1 file");
assert.strictEqual(describeBatch({ ...moved, op: "rename" }), "Renamed a file");

// --- Loading untrusted data.json --------------------------------------------
// A malformed batch is worse than a missing one: it would offer a restore that
// fails halfway. Anything unusable is dropped.
assert.deepStrictEqual(normalizeJournal(undefined, 10), []);
assert.deepStrictEqual(normalizeJournal("nope", 10), []);
assert.deepStrictEqual(normalizeJournal({}, 10), []);
assert.deepStrictEqual(normalizeJournal([null, 5, "x", {}], 10), []);
// Missing or invalid identity/timestamp/op.
assert.deepStrictEqual(normalizeJournal([{ at: "2026-01-01", op: "trash", entries: [] }], 10), []);
assert.deepStrictEqual(normalizeJournal([{ id: "a", at: "not a date", op: "trash", entries: [{ from: "x" }] }], 10), []);
assert.deepStrictEqual(normalizeJournal([{ id: "a", at: "2026-08-04T10:00:00Z", op: "explode", entries: [{ from: "x" }] }], 10), []);
// A move without a destination cannot be reversed, so it is not a usable record.
assert.deepStrictEqual(
  normalizeJournal([{ id: "a", at: "2026-08-04T10:00:00Z", op: "move", entries: [{ from: "x" }] }], 10),
  []
);
// A trash WITHOUT a recorded destination is kept, but marked unknown so it fails closed.
{
  const [only] = normalizeJournal(
    [{ id: "a", at: "2026-08-04T10:00:00Z", op: "trash", entries: [{ from: "x.png", sizeBytes: 5 }] }],
    10
  );
  assert.strictEqual(only.trashDestination, "unknown");
  assert.strictEqual(restorability(only).restorable, false, "unknown destination is not restorable");
}
// A bogus destination string is likewise demoted rather than trusted.
{
  const [only] = normalizeJournal(
    [{ id: "a", at: "2026-08-04T10:00:00Z", op: "trash", trashDestination: "definitely-fine", entries: [{ from: "x.png" }] }],
    10
  );
  assert.strictEqual(only.trashDestination, "unknown");
}
// Junk entries inside an otherwise valid batch are dropped; sizes coerced.
{
  const [only] = normalizeJournal(
    [{
      id: "a", at: "2026-08-04T10:00:00Z", op: "trash", trashDestination: "local",
      entries: [{ from: "keep.png", sizeBytes: "big" }, { from: "" }, null, { sizeBytes: 4 }],
    }],
    10
  );
  assert.strictEqual(only.entries.length, 1);
  assert.strictEqual(only.entries[0].sizeBytes, 0, "unusable size becomes 0");
}
// The cap applies on load too, so lowering it in settings takes effect.
{
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `b${i}`, at: "2026-08-04T10:00:00Z", op: "trash", trashDestination: "local",
    entries: [{ from: `f${i}.png`, sizeBytes: 1 }],
  }));
  assert.strictEqual(normalizeJournal(many, 5).length, 5);
  assert.strictEqual(normalizeJournal(many, 0).length, 0);
}
// Nothing hostile throws.
for (const hostile of [[{ id: "a", at: "2026-08-04T10:00:00Z", op: "trash", entries: "nope" }], [[]], [{ entries: [[]] }]]) {
  assert.doesNotThrow(() => normalizeJournal(hostile, 10));
}

assert.ok(DEFAULT_JOURNAL_LIMIT > 0 && DEFAULT_JOURNAL_LIMIT <= MAX_JOURNAL_LIMIT);

console.log("actionJournal tests passed");
