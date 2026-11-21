// Pure path math for the move/rename actions. No Obsidian API — runs in tests.
// The impure `fileManager.renameFile` call lives in main.ts; the target-path
// computation is here so it can be unit-tested exhaustively.

import { isInsideFolder } from "../scan/folderMatch";

/** Directory portion of a vault path ("" for a root-level file). */
export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Filename portion of a vault path (with extension). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Split a filename into stem + extension. `ext` includes no dot; "" when none. */
export function splitExtension(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { stem: fileName, ext: "" };
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot + 1) };
}

/** Join a folder and filename into a vault path, tolerating a blank/"/" folder. */
export function joinPath(folder: string, fileName: string): string {
  const clean = folder.trim().replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/${fileName}` : fileName;
}

/**
 * The path an attachment would have if moved into `attachmentFolder`, keeping its
 * filename. Returns the original path when the folder is blank or the file is
 * already directly inside it.
 */
export function moveTargetPath(currentPath: string, attachmentFolder: string): string {
  const folder = attachmentFolder.trim().replace(/^\/+|\/+$/g, "");
  if (!folder) return currentPath;
  const target = joinPath(folder, baseName(currentPath));
  return target === currentPath ? currentPath : target;
}

/**
 * Insert " (n)" before the extension to dodge a name collision, e.g.
 * `assets/logo.png` → `assets/logo (2).png`. Used to compute a free path when a
 * move/rename would otherwise overwrite an existing file.
 */
export function dedupePath(path: string, n: number): string {
  const dir = dirName(path);
  const { stem, ext } = splitExtension(baseName(path));
  const name = ext ? `${stem} (${n}).${ext}` : `${stem} (${n})`;
  return dir ? `${dir}/${name}` : name;
}

/**
 * Find a collision-free path at or near `desired`, using `exists` to probe the
 * vault. Returns `desired` when it is free, otherwise `desired` with " (2)",
 * " (3)", … appended before the extension.
 */
export function uniquePath(desired: string, exists: (p: string) => boolean): string {
  if (!exists(desired)) return desired;
  for (let n = 2; n < 10000; n++) {
    const candidate = dedupePath(desired, n);
    if (!exists(candidate)) return candidate;
  }
  return desired; // pathological; caller re-checks before writing
}

/** What the move action should do with one file. See {@link planMove}. */
export type MovePlan =
  | { action: "move"; target: string }
  /** Already inside the folder; `nested` when it sits in a subfolder of it. */
  | { action: "skip"; nested: boolean };

/**
 * Decide what "move to attachment folder" does with `currentPath`.
 *
 * "Already inside" is decided with the same case-insensitive rule the misplaced
 * detector uses (`isInsideFolder`). The move used to test an exact,
 * case-sensitive prefix instead, so with the setting typed as `assets` and the
 * folder actually named `Assets`, a file the detector had accepted as correctly
 * placed — `Assets/2024/photo.png` — was treated as outside it and targeted at
 * `assets/photo.png`: flattening the very subfolder structure the confirm dialog
 * promises to leave alone (or, on a case-insensitive disk, failing every move).
 *
 * `folder` should be the folder's REAL path when it exists, so a target lands in
 * the existing folder rather than in a case-variant twin of it.
 */
export function planMove(currentPath: string, folder: string): MovePlan {
  const clean = folder.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return { action: "skip", nested: false };
  if (isInsideFolder(currentPath, clean)) {
    const depth = clean.split("/").length;
    return { action: "skip", nested: currentPath.split("/").length > depth + 1 };
  }
  return { action: "move", target: joinPath(clean, baseName(currentPath)) };
}
