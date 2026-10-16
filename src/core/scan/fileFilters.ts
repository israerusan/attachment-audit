// Pure path/tag filtering for the vault scan. No Obsidian API — folder matching
// is prefix-based on the vault-relative path so it runs the same in tests.
//
// Path and folder comparison is CASE-INSENSITIVE, via `folderMatch`. These
// entries are free-typed by the user; see that module for why an exact match was
// the wrong rule here.

import { isInsideFolder, samePath } from "./folderMatch";

/** Which notes the scan should skip, by exact path, folder subtree, or tag. */
export interface ExclusionConfig {
  excludedFolders: string[];
  excludedPaths: string[];
  excludedTags: string[];
}

/** Normalize a tag for comparison: trimmed, lower-cased, without a leading '#'. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

/**
 * True when a note should be excluded from the scan: its path exactly matches an
 * excluded path, it lives inside an excluded folder, or it carries an excluded
 * tag (compared case-insensitively, ignoring a leading '#'). Empty or
 * whitespace-only config entries are ignored.
 */
export function isExcluded(
  path: string,
  tags: string[],
  config: ExclusionConfig
): boolean {
  for (const excluded of config.excludedPaths) {
    if (samePath(path, excluded)) return true;
  }
  for (const folder of config.excludedFolders) {
    if (isInsideFolder(path, folder)) return true;
  }
  // Guarded, not just filtered. This function runs once per vault file, and
  // attachments carry no tags at all — so on a 70,000-file vault the two array
  // allocations below were 140,000 guaranteed-empty throwaway arrays per scan.
  if (config.excludedTags.length === 0 || tags.length === 0) return false;
  const excludedTags = config.excludedTags
    .map(normalizeTag)
    .filter((t) => t.length > 0);
  if (excludedTags.length > 0) {
    const noteTags = new Set(tags.map(normalizeTag));
    for (const tag of excludedTags) {
      if (noteTags.has(tag)) return true;
    }
  }
  return false;
}

/**
 * True when a note passes the include-folder restriction: either there is no
 * restriction (empty list) or the path lives inside one of the folders. Empty or
 * whitespace-only folder entries are ignored.
 */
export function includedByFolders(
  path: string,
  includedFolders: string[]
): boolean {
  // Same reasoning as above: called once per vault file, and the common case is
  // no include restriction at all, so check that before allocating anything.
  if (includedFolders.length === 0) return true;
  const folders = includedFolders.filter((f) => f.trim().length > 0);
  if (folders.length === 0) return true;
  return folders.some((folder) => isInsideFolder(path, folder));
}
