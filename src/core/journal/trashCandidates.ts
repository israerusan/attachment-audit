// Pure identification of a trashed file. No Obsidian API — runs in tests.
//
// Obsidian does not report where it put a file it trashed, so restoring one means
// searching the vault's `.trash` for it. That search decides where real bytes get
// written, and `.trash` accumulates EVERYTHING the user has ever locally deleted
// — not just what this plugin did — so the pool is full of near-misses.
//
// Verified against a real vault: the trash is FLAT (basename only, folders
// discarded), and a trashed file keeps its bytes, so the content gate below
// passes on the honest path. What remains unverified is what Obsidian names a
// COLLIDING file and whether it preserves mtime — which is exactly why neither
// is allowed to be decisive here.
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
  /** SHA-256 of the leading bytes, computed lazily only for size-matching files. */
  headHash?: string;
}

/** What we are trying to find, from the journal entry that recorded the trash. */
export interface RestoreTarget {
  /** Original vault path, e.g. `assets/logo.png`. */
  from: string;
  /** Size at the moment it was trashed. */
  sizeBytes: number;
  /** Modification time at the moment it was trashed, when it was recorded. */
  mtime?: number;
  /** Content hash of the leading bytes at the moment it was trashed. */
  headHash?: string;
}

export type CandidateOutcome =
  | { found: TrashCandidate }
  | { found: null; reason: "no-match" | "ambiguous" };

/** Basename of a vault path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Normalize a filename for comparison. macOS filesystems report decomposed
 * (NFD) names while Obsidian records the composed form, so without this an
 * accented filename matches nothing and the user is told their file is "no
 * longer in the trash" while it sits right there.
 */
function normalizeName(name: string): string {
  try {
    return name.normalize("NFC");
  } catch {
    return name;
  }
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
  // Normalize HERE, not in the caller. This is called from two places — the
  // adapter-facing pre-filter in main.ts and the selector below — and an earlier
  // version normalized only in the selector, so the pre-filter discarded every
  // NFD candidate before normalization could ever apply. The fix was inert on
  // exactly the platform it was written for, and the tests passed because they
  // exercised the selector rather than the shipped path.
  const candidate = splitName(normalizeName(candidateName));
  const wanted = splitName(normalizeName(wantedName));
  if (candidate.stem === wanted.stem && candidate.ext === wanted.ext) return true;
  if (candidate.ext !== wanted.ext) return false;
  return new RegExp(`^${escapeRegExp(wanted.stem)}(?: \\d{1,2}| \\(\\d{1,2}\\))$`).test(
    candidate.stem
  );
}

/**
 * Every collision-suffixed form of a stem that {@link couldBeTrashedAs} accepts.
 * Derived from the same two-digit bound, so the index below and the predicate can
 * never disagree about what counts as a suffix.
 */
function suffixedStems(stem: string): string[] {
  const out: string[] = [stem];
  for (let n = 1; n <= 99; n++) {
    out.push(`${stem} ${n}`);
    out.push(`${stem} (${n})`);
  }
  return out;
}

/** `.trash` paths grouped by normalized `stem\next`, for O(1) candidate lookup. */
export type TrashIndex = Map<string, string[]>;

/** The index key for a filename. */
function nameKey(name: string): string {
  const { stem, ext } = splitName(normalizeName(name));
  return `${stem}\n${ext}`;
}

/**
 * Index a `.trash` listing ONCE per restore batch.
 *
 * Restoring used to re-scan the entire listing for every journal entry, running
 * `couldBeTrashedAs` — two `String.normalize` calls and, on an extension match, a
 * freshly compiled RegExp — on each pair. That is O(entries x trash files), and
 * both factors are large by design: `MAX_JOURNAL_ENTRIES` is 5,000 and `.trash`
 * holds everything the user has ever deleted. Measured at 5,000 entries against a
 * 50,000-file trash it was 250 million comparisons and **145 seconds** of frozen
 * UI, with no progress and no way to cancel.
 *
 * The set of names that could be a given file is small and enumerable — the name
 * itself plus its bounded collision forms — so one pass to build this map turns
 * the whole search into a few hundred lookups per entry.
 */
export function indexTrashListing(paths: readonly string[]): TrashIndex {
  const index: TrashIndex = new Map();
  for (const path of paths) {
    const key = nameKey(baseName(path));
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [path]);
    else bucket.push(path);
  }
  return index;
}

/**
 * Paths in `.trash` that could be `wantedName`. Equivalent to filtering the whole
 * listing through {@link couldBeTrashedAs}, but by lookup rather than by scan.
 */
export function trashCandidatePaths(index: TrashIndex, wantedName: string): string[] {
  const { stem, ext } = splitName(normalizeName(wantedName));
  const out: string[] = [];
  for (const candidateStem of suffixedStems(stem)) {
    const bucket = index.get(`${candidateStem}\n${ext}`);
    if (bucket !== undefined) for (const path of bucket) out.push(path);
  }
  return out;
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
  target: RestoreTarget,
  options?: { requireContentMatch?: boolean }
): CandidateOutcome {
  const wantedName = normalizeName(baseName(target.from));

  // When the SAME BATCH trashed two files sharing a basename, name and size carry
  // no information about which trashed file belongs to which entry, and the
  // `exactName` preference below actively picks wrong: trashing `a/logo.png` and
  // `b/logo.png` yields `.trash/logo.png` and `.trash/logo 1.png`, and the
  // unsuffixed one is not preferentially either entry's file. Restoring in
  // reverse order gave the first entry the unsuffixed file and the second
  // whatever was left — both paths restored with the other's content, reported as
  // a clean success. Without a content hash there is no evidence here at all, so
  // refuse; this is the "identify, or refuse" rule the module header states.
  if (options?.requireContentMatch && target.headHash === undefined) {
    return { found: null, reason: "ambiguous" };
  }

  const byName = candidates.filter((c) => couldBeTrashedAs(baseName(c.path), wantedName));
  if (byName.length === 0) return { found: null, reason: "no-match" };

  // Gate 1 — size. Cheap, and a mismatch is decisive: this is not our file.
  const bySize = byName.filter((c) => c.size === target.sizeBytes);
  if (bySize.length === 0) return { found: null, reason: "no-match" };

  // Gate 2 — CONTENT. This is the one that actually establishes identity.
  // Everything else is circumstantial: `.trash` holds every file the user has
  // ever deleted, Obsidian's collision naming is undocumented, and whether the
  // trash preserves mtime could not be verified. Content is not circumstantial.
  // A recorded hash is therefore allowed to REJECT, not merely to rank.
  let pool = bySize;
  if (target.headHash !== undefined) {
    const hashed = pool.filter((c) => c.headHash !== undefined);
    // Only apply the gate where it can be evaluated. A candidate we could not
    // hash (unreadable) is dropped rather than trusted.
    pool = hashed.filter((c) => c.headHash === target.headHash);
    if (pool.length === 0) return { found: null, reason: "no-match" };
  }
  if (pool.length === 1) return { found: pool[0] };

  // Several survivors. Prefer the exact filename over a collision-suffixed one:
  // it is strictly stronger evidence, and refusing when we have it would be
  // over-cautious.
  const exactName = pool.filter((c) => normalizeName(baseName(c.path)) === wantedName);
  if (exactName.length === 1) return { found: exactName[0] };

  // mtime is only ever a TIEBREAK, never a gate — whether the trash preserves it
  // is unverified, so a mismatch cannot be treated as evidence of anything.
  if (target.mtime !== undefined) {
    const sameTime = pool.filter((c) => c.mtime === target.mtime);
    if (sameTime.length === 1) return { found: sameTime[0] };
  }

  // Everything still standing has the same size AND the same leading bytes. That
  // is not a proof of byte-equality — two large files can share a preamble — but
  // it is far stronger evidence than name alone, and the realistic case that
  // reaches here is genuine duplicates, where restoring either is correct.
  // Refusing instead would make duplicate cleanup unrestorable, which is worse.
  if (target.headHash !== undefined) return { found: pool[0] };
  return { found: null, reason: "ambiguous" };
}

/** User-facing explanation for a candidate search that produced nothing. */
export function explainOutcome(reason: "no-match" | "ambiguous"): string {
  return reason === "ambiguous"
    ? "several identical files are in the trash and it is not possible to tell which one this was"
    : "it is no longer in the vault's trash";
}
