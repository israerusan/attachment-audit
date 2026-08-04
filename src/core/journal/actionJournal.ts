// Pure cleanup-history bookkeeping. No Obsidian API — runs in tests under Node.
//
// This plugin's whole pitch is that it is safe enough to trust with bulk delete,
// and until now everything backing that claim was PROSE: a README section, a
// confirm dialog, a two-signal safety contract the user has to take on faith.
// A journal turns the claim into something inspectable — here is exactly what
// was changed, when, and whether it can be put back.
//
// The restorability rules below are the load-bearing part. Promising an undo the
// filesystem cannot deliver would be worse than promising nothing, so a batch is
// only ever reported restorable when the recorded facts prove it is.

import type { TrashDestination } from "../../types";

/** What a recorded batch did. */
export type CleanupOp = "trash" | "move" | "rename";

/** One file's part in a batch. */
export interface JournalEntry {
  /** Where the file was BEFORE the action. */
  from: string;
  /** Where it is AFTER (move/rename). Absent for a trash. */
  to?: string;
  /**
   * Size at the moment of the action — shown in the history, and a hard gate when
   * identifying the file in the trash. Read from the file immediately before the
   * mutation, NOT from the scan: a file edited between the scan and the trash
   * would otherwise carry a stale size and never be identifiable again.
   */
  sizeBytes: number;
  /**
   * Modification time at the moment of the action. Used only as a weak tiebreak:
   * whether Obsidian's trash preserves mtime is not documented and could not be
   * verified, so this is never allowed to REJECT a candidate.
   */
  mtime?: number;
  /**
   * SHA-256 of the file's first {@link HEAD_HASH_BYTES} bytes, plus its size, taken
   * at the moment of the action. This is the real identity check.
   *
   * Name, size and mtime are all circumstantial: `.trash` holds everything the
   * user ever deleted, Obsidian's collision naming is undocumented, and mtime
   * preservation is unverified. Content is not circumstantial.
   *
   * Hashing only the head bounds the DIGEST, not the read — `DataAdapter` has no
   * ranged read, so the whole file is loaded either way. Files above
   * {@link HASH_MAX_BYTES} are therefore not hashed at all, and fall back to the
   * weaker name-and-size check; that degradation is deliberate rather than a
   * silent out-of-memory failure on the largest files.
   */
  headHash?: string;
  /**
   * Where this entry was actually restored to, once it has been. Per-entry state,
   * so a partially-restored batch can be re-run to completion without
   * re-searching — and without pulling a second file out of the trash for an
   * entry that already came back.
   */
  restoredTo?: string;
}

/** How many leading bytes {@link JournalEntry.headHash} covers. */
export const HEAD_HASH_BYTES = 64 * 1024;

/**
 * Files above this size are not hashed at all.
 *
 * `DataAdapter` has no ranged read, so hashing 64 KB still loads the WHOLE file.
 * Without this ceiling, bulk-trashing a media library would read tens of
 * gigabytes before the trash even starts — and a file large enough to fail the
 * ArrayBuffer allocation would throw, get swallowed, and silently fall back to
 * the weaker check. Making the fallback explicit and size-based means the
 * degradation is a decision rather than an accident on exactly the biggest files.
 */
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

/** One user-visible action, however many files it touched. */
export interface JournalBatch {
  id: string;
  /** ISO timestamp of when the action ran. */
  at: string;
  op: CleanupOp;
  /**
   * Where trashed files went, captured AT THE TIME. Read live it would be a lie:
   * the user can change their "Deleted files" setting between the trash and the
   * restore, and what matters is where the file actually went.
   */
  trashDestination?: TrashDestination;
  entries: JournalEntry[];
  /** Set once reverted, so a batch can never be reverted twice. */
  revertedAt?: string;
}

/** How many batches to keep. Older ones fall off the end. */
export const DEFAULT_JOURNAL_LIMIT = 50;

/** Hard ceiling on batch count, so a corrupt setting cannot grow `data.json` without bound. */
export const MAX_JOURNAL_LIMIT = 500;

/**
 * Hard ceiling on total ENTRIES across the whole journal.
 *
 * The batch cap alone bounds nothing that matters: one "trash every unused file"
 * on a large vault is easily thousands of entries, each carrying a full path, and
 * `saveSettings` re-serializes the entire settings object on routine UI actions
 * like toggling "reviewed". Without this, a few big cleanups put tens of
 * megabytes of JSON on the main thread every time the user clicks a row.
 */
export const MAX_JOURNAL_ENTRIES = 5000;

/**
 * Add a batch to the front of the journal and trim to `limit`. Newest first, so
 * the history reads top-down and the trim drops the oldest.
 */
export function appendBatch(
  journal: readonly JournalBatch[],
  batch: JournalBatch,
  limit: number = DEFAULT_JOURNAL_LIMIT
): JournalBatch[] {
  const capped = Math.max(0, Math.min(MAX_JOURNAL_LIMIT, Math.floor(limit)));
  if (capped === 0) return [];
  return trimEntries([batch, ...journal].slice(0, capped));
}

/**
 * Drop the oldest batches until the journal holds at most
 * {@link MAX_JOURNAL_ENTRIES} entries in total. The newest batch is always kept
 * whole, even if it alone exceeds the budget — a history that silently truncated
 * the action you just took would be worse than useless.
 */
export function trimEntries(journal: readonly JournalBatch[]): JournalBatch[] {
  if (journal.length === 0) return [];
  // The newest batch is kept whole and EXEMPT from the budget. A history that
  // truncated the action you just took would be worse than useless — and
  // counting it would mean one vault-wide cleanup evicted every older
  // still-restorable batch behind it, which is the opposite of the point.
  const out: JournalBatch[] = [journal[0]];
  let total = 0;
  for (let i = 1; i < journal.length; i++) {
    const batch = journal[i];
    // Skip, don't STOP: an oversized batch in the middle should not discard the
    // smaller older ones that still fit behind it.
    if (total + batch.entries.length > MAX_JOURNAL_ENTRIES) continue;
    out.push(batch);
    total += batch.entries.length;
  }
  return out;
}

/** Replace one batch by id, leaving the rest untouched. */
export function replaceBatch(
  journal: readonly JournalBatch[],
  id: string,
  update: (batch: JournalBatch) => JournalBatch
): JournalBatch[] {
  return journal.map((b) => (b.id === id ? update(b) : b));
}

/** Total bytes a batch moved or removed. */
export function batchBytes(batch: JournalBatch): number {
  return batch.entries.reduce((sum, e) => sum + Math.max(0, e.sizeBytes), 0);
}

export interface Restorability {
  restorable: boolean;
  /** Why not, phrased for the history UI. Always present when `restorable` is false. */
  reason?: string;
}

/**
 * Whether a batch can be put back, and if not, why not.
 *
 * The negative cases matter more than the positive one. Obsidian's "Deleted
 * files" setting decides where a trashed file goes, and only one of the three
 * destinations is reachable from a plugin:
 *
 *   local     -> `.trash/` inside the vault, which we can read and move back
 *   system    -> the OS recycle bin, which no plugin API can reach
 *   permanent -> gone; there is nothing to restore
 *
 * Moves and renames are always reversible: the file still exists, and reversing
 * a rename through Obsidian re-updates every link it updated on the way out.
 */
export function restorability(batch: JournalBatch): Restorability {
  if (batch.revertedAt) {
    return { restorable: false, reason: "Already restored." };
  }
  if (batch.entries.length === 0) {
    return { restorable: false, reason: "Nothing was changed." };
  }
  if (batch.op === "move" || batch.op === "rename") {
    return { restorable: true };
  }
  switch (batch.trashDestination) {
    case "local":
      return { restorable: true };
    case "system":
      return {
        restorable: false,
        reason: "These went to your system trash — restore them from there.",
      };
    case "permanent":
      return {
        restorable: false,
        reason: "Your “Deleted files” setting was “Permanently delete”, so these are gone.",
      };
    default:
      return {
        restorable: false,
        reason: "Where these files went could not be determined, so they cannot be put back.",
      };
  }
}

/** One-line description of a batch, e.g. `Trashed 14 files`. */
export function describeBatch(batch: JournalBatch): string {
  const n = batch.entries.length;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  switch (batch.op) {
    case "trash":
      return `Trashed ${files}`;
    case "move":
      return `Moved ${files}`;
    case "rename":
      return n === 1 ? "Renamed a file" : `Renamed ${files}`;
  }
}

/**
 * Coerce anything loaded from `data.json` into a valid journal, dropping entries
 * that cannot be acted on. A malformed batch is worse than a missing one: the
 * history would offer a restore that then fails halfway.
 */
export function normalizeJournal(value: unknown, limit: number): JournalBatch[] {
  // A limit of 0 means "stop RECORDING", not "purge what is already there".
  // Purging would silently discard restorable history the moment the setting is
  // typed, while the files themselves sit in `.trash` and become unreachable from
  // this plugin. Clearing history is an explicit, confirmed action.
  const effectiveLimit = limit <= 0 ? MAX_JOURNAL_LIMIT : limit;
  if (!Array.isArray(value)) return [];
  const ops = new Set<CleanupOp>(["trash", "move", "rename"]);
  const destinations = new Set<TrashDestination>(["local", "system", "permanent", "unknown"]);
  const out: JournalBatch[] = [];

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.id !== "string" || !b.id) continue;
    if (typeof b.at !== "string" || Number.isNaN(Date.parse(b.at))) continue;
    if (typeof b.op !== "string" || !ops.has(b.op as CleanupOp)) continue;
    if (!Array.isArray(b.entries)) continue;

    const entries: JournalEntry[] = [];
    for (const rawEntry of b.entries) {
      if (typeof rawEntry !== "object" || rawEntry === null) continue;
      const e = rawEntry as Record<string, unknown>;
      if (typeof e.from !== "string" || !e.from) continue;
      // A move or rename without a destination cannot be reversed or even shown
      // honestly, so it is not a usable record.
      if (b.op !== "trash" && (typeof e.to !== "string" || !e.to)) continue;
      entries.push({
        from: e.from,
        to: typeof e.to === "string" && e.to ? e.to : undefined,
        sizeBytes:
          typeof e.sizeBytes === "number" && Number.isFinite(e.sizeBytes)
            ? Math.max(0, e.sizeBytes)
            : 0,
        mtime:
          typeof e.mtime === "number" && Number.isFinite(e.mtime) ? e.mtime : undefined,
        headHash: typeof e.headHash === "string" && e.headHash ? e.headHash : undefined,
        restoredTo: typeof e.restoredTo === "string" && e.restoredTo ? e.restoredTo : undefined,
      });
    }
    if (entries.length === 0) continue;

    out.push({
      id: b.id,
      at: b.at,
      op: b.op as CleanupOp,
      trashDestination:
        typeof b.trashDestination === "string" && destinations.has(b.trashDestination as TrashDestination)
          ? (b.trashDestination as TrashDestination)
          : b.op === "trash"
            ? "unknown"
            : undefined,
      entries,
      revertedAt:
        typeof b.revertedAt === "string" && !Number.isNaN(Date.parse(b.revertedAt))
          ? b.revertedAt
          : undefined,
    });
  }

  const capped = Math.max(0, Math.min(MAX_JOURNAL_LIMIT, Math.floor(effectiveLimit)));
  return trimEntries(out.slice(0, capped));
}
