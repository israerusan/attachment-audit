// Pure folder-path matching for user-typed folder configuration. No Obsidian API.
//
// Every folder setting in this plugin is free-typed text in a textarea: excluded
// folders, included folders, the attachment folder. Matching it against vault
// paths with an exact, case-sensitive prefix test made two settings silently
// wrong in opposite and equally bad directions:
//
//  - EXCLUSION under-matched. A user who typed `templates` while the folder is
//    `Templates` excluded nothing, yet the UI showed the exclusion as
//    configured — so every attachment under it became a scan candidate AND a
//    trash candidate.
//  - The MISPLACED detector over-matched. With `attachmentFolder` set to
//    `assets` and the real folder named `Assets`, every attachment in the vault
//    was flagged as living outside it.
//
// Both resolve to the same cause, so both now go through here. Vault paths are
// always `/`-separated, so a backslash a Windows user types could never match
// anything; it is folded to `/` rather than left to fail quietly.

/**
 * Canonical comparison key for a folder or path: trimmed, backslashes folded to
 * forward slashes, surrounding slashes stripped, case-folded.
 *
 * Case folding is the deliberate choice on every platform, not just the
 * case-insensitive ones. The input is something a person typed to name a folder
 * they can see; `Templates` and `templates` are the same intent, and the failure
 * mode of honouring the difference is silent.
 */
export function folderKey(folder: string): string {
  return folder.trim().split("\\").join("/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** True when `path` IS `folder` or lives anywhere beneath it. Case-insensitive. */
export function isInsideFolder(path: string, folder: string): boolean {
  const key = folderKey(folder);
  if (!key) return false;
  const p = folderKey(path);
  return p === key || p.startsWith(`${key}/`);
}

/** True when `path` and `candidate` name the same file. Case-insensitive. */
export function samePath(path: string, candidate: string): boolean {
  const key = folderKey(candidate);
  return key !== "" && folderKey(path) === key;
}
