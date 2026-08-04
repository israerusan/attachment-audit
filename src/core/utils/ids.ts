import type { IssueType } from "../../types";

/** Field separator for issue keys. A newline can't occur in a vault path, so the
 *  note-path prefix is always unambiguously recoverable (a colon is legal on
 *  macOS/Linux and would break `path::type` parsing). */
export const ISSUE_KEY_SEP = "\n";

/** Stable identity for an issue, so ignore/reviewed state survives re-scans. */
export function issueKey(
  notePath: string,
  issueType: IssueType,
  sourceRuleId?: string
): string {
  const base = `${notePath}${ISSUE_KEY_SEP}${issueType}`;
  return sourceRuleId ? `${base}${ISSUE_KEY_SEP}${sourceRuleId}` : base;
}

/** Recover the note-path prefix from an issue key. */
export function issueKeyPath(key: string): string {
  const i = key.indexOf(ISSUE_KEY_SEP);
  return i === -1 ? key : key.slice(0, i);
}

/** Recover the issue type from an issue key, or "" if the key is malformed. */
export function issueKeyType(key: string): string {
  const first = key.indexOf(ISSUE_KEY_SEP);
  if (first === -1) return "";
  const second = key.indexOf(ISSUE_KEY_SEP, first + 1);
  return second === -1 ? key.slice(first + 1) : key.slice(first + 1, second);
}

/**
 * A short unique id for profiles and rules. Runs in the plugin runtime (not the
 * pure test path), so `crypto.randomUUID` / `Date.now` are available.
 */
export function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
