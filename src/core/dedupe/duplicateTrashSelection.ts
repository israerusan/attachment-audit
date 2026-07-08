// Pure selection logic for the duplicate-copy trash action — the single most
// consequential decision in the plugin (a bug could delete a user's only copy).
// Extracted from the Obsidian boundary so its safety invariants are unit-tested.

import type { AttachmentIssue } from "../../types";

/**
 * Decide which byte-identical copies are safe to trash.
 *
 * Given the user's `selected` duplicate issues, `allIssues` from the last scan
 * (for full cluster membership so "keep one" counts every copy), the two-signal
 * `unused` path set, and current `inbound` reference counts, return the paths
 * eligible to trash. Guarantees:
 *  - only copies that are two-signal unused AND currently unreferenced are eligible;
 *  - at least one copy of every cluster always survives (never trash the last copy);
 *  - unselected copies are never trashed (selection scope is respected);
 *  - keep-one is applied per cluster, independently.
 */
export function selectDuplicateCopiesToTrash(
  selected: readonly AttachmentIssue[],
  allIssues: readonly AttachmentIssue[],
  unused: ReadonlySet<string>,
  inbound: ReadonlyMap<string, number>
): string[] {
  const membersByCluster = new Map<string, string[]>();
  for (const i of allIssues) {
    if (i.issueType === "duplicate" && i.clusterId) {
      const b = membersByCluster.get(i.clusterId) ?? [];
      if (!b.includes(i.attachmentPath)) b.push(i.attachmentPath);
      membersByCluster.set(i.clusterId, b);
    }
  }

  const selectedByCluster = new Map<string, string[]>();
  for (const i of selected) {
    if (i.issueType !== "duplicate" || !i.clusterId) continue;
    const b = selectedByCluster.get(i.clusterId) ?? [];
    if (!b.includes(i.attachmentPath)) b.push(i.attachmentPath);
    selectedByCluster.set(i.clusterId, b);
  }

  const toTrash: string[] = [];
  for (const [cid, sel] of selectedByCluster) {
    const members = membersByCluster.get(cid) ?? sel;
    // Eligible = selected copies that are two-signal unused AND still unreferenced.
    const eligible = sel.filter((p) => unused.has(p) && (inbound.get(p) ?? 0) <= 0);
    const survivors = members.filter((p) => !eligible.includes(p));
    let trashList = eligible;
    // Never remove the last surviving copy of the content.
    if (survivors.length === 0 && trashList.length > 0) trashList = trashList.slice(1);
    toTrash.push(...trashList);
  }
  return toTrash;
}
