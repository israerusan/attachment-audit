import assert from "node:assert";
import {
  appendBatch,
  trimEntries,
  MAX_JOURNAL_ENTRIES,
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
  // A limit of 0 means "stop RECORDING", not "purge". Purging would discard
  // still-restorable history the instant the setting is typed, while the files
  // sit in `.trash` unreachable from the plugin. Clearing is an explicit action.
  assert.strictEqual(normalizeJournal(many, 0).length, 20, "0 does not purge on load");
  assert.strictEqual(appendBatch(many as never, batch({ id: "new" }), 0).length, 0, "...but records nothing new");
}

// --- Entry cap --------------------------------------------------------------
// The batch cap bounds nothing that matters: one vault-wide cleanup is thousands
// of entries, and `saveSettings` re-serializes the whole object on routine clicks.
{
  const big = (id: string, n: number): JournalBatch =>
    batch({ id, entries: Array.from({ length: n }, (_, i) => ({ from: `f${i}.png`, sizeBytes: 1 })) });

  // The newest batch is kept whole even when it alone blows the budget — a
  // history that truncated the action you just took would be worse than useless.
  const huge = trimEntries([big("huge", MAX_JOURNAL_ENTRIES + 1)]);
  assert.strictEqual(huge.length, 1);
  assert.strictEqual(huge[0].entries.length, MAX_JOURNAL_ENTRIES + 1);

  // ...and it must not evict everything behind it. The newest is exempt from the
  // budget, so one vault-wide cleanup does not wipe the older restorable history.
  const mixed = trimEntries([big("huge", MAX_JOURNAL_ENTRIES + 1), big("a", 10), big("b", 10)]);
  assert.deepStrictEqual(mixed.map((b) => b.id), ["huge", "a", "b"], "older batches survive");

  // An oversized batch in the MIDDLE is stepped over, not stopped at.
  const middle = trimEntries([big("new", 5), big("huge", MAX_JOURNAL_ENTRIES + 1), big("old", 5)]);
  assert.deepStrictEqual(middle.map((b) => b.id), ["new", "old"], "smaller older batches still fit");

  // The budget is enforced across batches.
  const many2 = Array.from({ length: 10 }, (_, i) => big(`b${i}`, 1000));
  const trimmed = trimEntries(many2);
  assert.ok(trimmed.length < 10, "trimmed to the entry budget");
  // The newest is exempt, so the bound is budget + newest.
  assert.ok(
    trimmed.slice(1).reduce((n, b) => n + b.entries.length, 0) <= MAX_JOURNAL_ENTRIES,
    "everything past the newest is within budget"
  );
  // Newest first, so the trim drops the oldest.
  assert.strictEqual(trimmed[0].id, "b0");
}
// Nothing hostile throws.
for (const hostile of [[{ id: "a", at: "2026-08-04T10:00:00Z", op: "trash", entries: "nope" }], [[]], [{ entries: [[]] }]]) {
  assert.doesNotThrow(() => normalizeJournal(hostile, 10));
}

assert.ok(DEFAULT_JOURNAL_LIMIT > 0 && DEFAULT_JOURNAL_LIMIT <= MAX_JOURNAL_LIMIT);

console.log("actionJournal tests passed");

// --- headHash and restoredTo round-trip through data.json -------------------
// `restoredTo` is the per-entry state that lets a partially-restored batch
// complete — the mechanism added to fix a data-loss defect, and the one part of
// that change with no coverage until now.
{
  const [only] = normalizeJournal(
    [{
      id: "a", at: "2026-08-04T10:00:00Z", op: "trash", trashDestination: "local",
      entries: [
        { from: "a.png", sizeBytes: 10, mtime: 5, headHash: "abc", restoredTo: "a.png" },
        { from: "b.png", sizeBytes: 20 },
      ],
    }],
    10
  );
  assert.strictEqual(only.entries[0].headHash, "abc");
  assert.strictEqual(only.entries[0].restoredTo, "a.png");
  assert.strictEqual(only.entries[0].mtime, 5);
  // Absent optionals stay absent rather than becoming empty strings.
  assert.strictEqual(only.entries[1].headHash, undefined);
  assert.strictEqual(only.entries[1].restoredTo, undefined);
  assert.strictEqual(only.entries[1].mtime, undefined);
}
// Junk in those fields is dropped, not trusted.
{
  const [only] = normalizeJournal(
    [{
      id: "a", at: "2026-08-04T10:00:00Z", op: "trash", trashDestination: "local",
      entries: [{ from: "a.png", sizeBytes: 1, headHash: 42, restoredTo: "", mtime: "soon" }],
    }],
    10
  );
  assert.strictEqual(only.entries[0].headHash, undefined);
  assert.strictEqual(only.entries[0].restoredTo, undefined);
  assert.strictEqual(only.entries[0].mtime, undefined);
}

console.log("actionJournal headHash/restoredTo tests passed");
