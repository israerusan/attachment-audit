// Pure Markdown report builder. No Obsidian API — runs in tests under Node.

import { ISSUE_TYPE_LABELS, ISSUE_TYPES, AttachmentIssue } from "../../types";
import { formatBytes } from "../utils/sizes";
import { computeReclaim } from "../reclaim/reclaimableSpace";

/** Everything needed to render a scan into a Markdown report. */
export interface ReportInput {
  /** Human-readable timestamp of when the scan ran. */
  scannedAt: string;
  /** Optional name of the profile that produced the scan. */
  profileName?: string;
  /** Total number of attachments scanned. */
  totalFiles: number;
  /** The issues found, in any order; grouped by type during rendering. */
  issues: AttachmentIssue[];
}

/**
 * Render a scan result into a Markdown report string. Opens with a title, date,
 * optional profile line, and a reclaimable-space summary, then one section per
 * issue type that has at least one issue (in {@link ISSUE_TYPES} order). Each
 * issue is an embed-safe wiki-link bullet with its size and reason.
 */
export function buildMarkdownReport(input: ReportInput): string {
  const lines: string[] = [];
  const reclaim = computeReclaim(input.issues);

  lines.push("# Attachment Audit Report");
  lines.push(`Date: ${input.scannedAt}`);
  if (input.profileName) lines.push(`Profile: ${input.profileName}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Attachments scanned: ${input.totalFiles}`);
  lines.push(`- Issues found: ${input.issues.length}`);
  lines.push(`- Reclaimable now (unused): ${formatBytes(reclaim.unusedBytes)}`);
  if (reclaim.duplicateExtraBytes > 0) {
    lines.push(`- In duplicate copies: ${formatBytes(reclaim.duplicateExtraBytes)}`);
  }
  for (const issueType of ISSUE_TYPES) {
    const count = input.issues.filter((i) => i.issueType === issueType).length;
    if (count > 0) lines.push(`- ${ISSUE_TYPE_LABELS[issueType]}: ${count}`);
  }
  lines.push("");

  for (const issueType of ISSUE_TYPES) {
    const group = input.issues.filter((i) => i.issueType === issueType);
    if (group.length === 0) continue;
    lines.push(`## ${ISSUE_TYPE_LABELS[issueType]}`);
    for (const issue of group) {
      // Link by full path so attachments that share a basename resolve correctly.
      const link = `- [[${issue.attachmentPath}]]`;
      const why = issue.details ?? issue.reason;
      const size = formatBytes(issue.sizeBytes);
      lines.push(`${link} — ${why} (${size})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
