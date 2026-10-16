import type { AttachmentStat, DetectorHit } from "../../types";
import { isInsideFolder } from "../scan/folderMatch";

/**
 * Flags an attachment that lives outside the configured attachment folder — a
 * candidate to move so attachments stay organized in one place. A blank folder
 * disables the check (the user hasn't declared where attachments should live).
 * The folder is trimmed and its trailing slash removed for prefix matching, and
 * the comparison is case-insensitive: with `assets` configured against a folder
 * actually named `Assets`, an exact match flagged every attachment in the vault
 * as misplaced.
 */
export function misplacedDetector(stat: AttachmentStat, attachmentFolder: string): DetectorHit | null {
  const folder = attachmentFolder.trim().replace(/^\/+|\/+$/g, "");
  if (!folder) return null;
  if (isInsideFolder(stat.path, folder)) return null;
  return { reason: `Outside "${folder}"` };
}
