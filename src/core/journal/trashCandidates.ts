// Pure identification of a trashed file. No Obsidian API — runs in tests.
//
// Obsidian does not report where it put a file it trashed, so restoring one means
// searching the vault's `.trash` for it. That search decides where real bytes get
// written, and `.trash` accumulates EVERYTHING the user has ever locally deleted
// — not just what this plugin did — so the pool is full of near-misses.
//
// The rule is therefore: identify, or refuse. Never guess. A refused restore is
// an inconvenience; a wrong one writes a stranger's content to a path the user
// believes is recovered AND consumes the real file from `.trash`, putting it
// beyond Obsidian's own recovery too. Two losses from one click.

/** A file sitting in `.trash`, as reported by the vault adapter. */
export interface TrashCandidate {
  path: string;
  size: number;
  mtime: number;
}

/** What we are trying to find, from the journal entry that recorded the trash. */
export interface RestoreTarget {
  /** Original vault path, e.g. `assets/logo.png`. */
  from: string;
  /** Size at the moment it was trashed. */
  sizeBytes: number;
  /** Modification time at the moment it was trashed, when it was recorded. */
  mtime?: number;
}

export type CandidateOutcome =
  | { found: TrashCandidate }
  | { found: null; reason: "no-match" | "ambiguous" };

/** Basename of a vault path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.fromCharCode(92) + "$&");
}

/**
 * Whether `candidateName` could be `wantedName`, possibly with a collision suffix.
 *
 * Deliberately narrow. An earlier version accepted `stem[ _-]?\(?\d+\)?`, which
 * matches ordinary attachment names — `report 2024.pdf` for `report.pdf`,
 * `IMG_1234.png` for `IMG.png`, `Screenshot 2023.png` for `Screenshot.png`.
 * Those are exactly the names that fill a real `.trash`.
 *
 * The counter is bounded to two digits because a collision counter is small and a
 * long run of digits is almost always meaningful — a year, a date, a camera
 * sequence number. `_` and `-` separators are gone entirely: `IMG_1234` is a
 * filename, not `IMG` with a suffix.
 *
 * This is defence in depth, not the primary defence. A false candidate still has
 * to match the recorded size exactly before {@link selectTrashCandidate} will
 * touch it.
 */
export function couldBeTrashedAs(candidateName: string, wantedName: string): boolean {
  if (candidateName === wantedName) return true;
  const wanted = splitName(wantedName);
  const candidate = splitName(candidateName);
  if (candidate.ext !== wanted.ext) return false;
  return new RegExp(`^${escapeRegExp(wanted.stem)}(?: \\d{1,2}| \\(\\d{1,2}\\))$`).test(
    candidate.stem
  );
}

/**
 * Pick the file in `.trash` that IS the one described by `target`, or explain why
 * we will not commit to one.
 *
 * Size is a hard GATE, not a preference. It was a preference at first, scoring a
 * match higher but still restoring a lone name-match of any size — which would
 * move a 50 KB stranger onto the path of a 2 MB file and report success.
 *
 * When several candidates survive, the recorded mtime must single one out.
 * Failing that we return `ambiguous` rather than picking the newest: with
 * identical names and identical sizes there is no evidence left to choose on, and
 * a coin flip here is a silent data swap.
 */
export function selectTrashCandidate(
  candidates: readonly TrashCandidate[],
  target: RestoreTarget
): CandidateOutcome {
  const wantedName = baseName(target.from);

  const byName = candidates.filter((c) => couldBeTrashedAs(baseName(c.path), wantedName));
  if (byName.length === 0) return { found: null, reason: "no-match" };

  // Hard gate. A file's size at the moment we trashed it is the strongest cheap
  // identity signal available, and a mismatch means this is not our file.
  const bySize = byName.filter((c) => c.size === target.sizeBytes);
  if (bySize.length === 0) return { found: null, reason: "no-match" };
  if (bySize.length === 1) return { found: bySize[0] };

  // Several identically-named, identically-sized files. A rename preserves mtime,
  // so the one we trashed should still carry the timestamp we recorded.
  if (target.mtime !== undefined) {
    const exact = bySize.filter((c) => c.mtime === target.mtime);
    if (exact.length === 1) return { found: exact[0] };
  }
  return { found: null, reason: "ambiguous" };
}

/** User-facing explanation for a candidate search that produced nothing. */
export function explainOutcome(reason: "no-match" | "ambiguous"): string {
  return reason === "ambiguous"
    ? "several identical files are in the trash and it is not possible to tell which one this was"
    : "it is no longer in the vault's trash";
}
