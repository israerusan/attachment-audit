// Pure identification of the Markdown reports THIS plugin exports. No Obsidian
// API — runs in tests under Node.
//
// Why this exists: an exported report lists every unused attachment as a
// `[[wikilink]]`. Those links resolve, so without special handling a single
// exported report would permanently suppress the "unused" flag on every file it
// names. The fix used to be "ignore the whole report folder" — but that also
// blinded both safety signals to any note the USER chose to keep in that folder,
// so an attachment embedded only from `Attachment Audit Reports/Index.md` looked
// unused and could be trashed. Matching the generated filenames exactly means we
// discount only our own output and treat every other note in the folder as the
// real source it is.

/** Filename shape `exportReport` writes: `Report 2026-08-03-18-30-00.md`, plus ` (2)` on collision. */
const GENERATED_REPORT_NAME = /^Report \d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}( \(\d+\))?\.md$/;

/**
 * True only for a file this plugin generated: directly inside `reportFolder` and
 * matching the exact timestamped name `exportReport` produces. A user's own note
 * in that folder — or a report they renamed — is NOT a generated report, and is
 * therefore still honoured as a reference source.
 */
export function isGeneratedReport(path: string, reportFolder: string): boolean {
  const prefix = reportFolder + "/";
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.includes("/")) return false; // only the folder's top level
  return GENERATED_REPORT_NAME.test(rest);
}
