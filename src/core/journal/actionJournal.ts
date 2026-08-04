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
  /** Size at the time — shown in the history, and used to identify the file in the trash. */
  sizeBytes: number;
}

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

/** Hard ceiling, so a corrupt setting cannot make `data.json` grow without bound. */
export const MAX_JOURNAL_LIMIT = 500;

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
  return [batch, ...journal].slice(0, capped);
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

  const capped = Math.max(0, Math.min(MAX_JOURNAL_LIMIT, Math.floor(limit)));
  return out.slice(0, capped);
}
