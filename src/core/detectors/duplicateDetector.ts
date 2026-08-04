import type { AttachmentStat, DetectorHit } from "../../types";

/**
 * Flags an attachment that is byte-identical to at least one other. `hashToPaths`
 * maps a content hash to every path sharing it (built by the boundary from
 * size-bucketed SHA-256 hashing). A stat with no `hash` was never a size-collision
 * candidate, so it cannot be a duplicate. The reason names how many twins exist;
 * `details` lists a few of them.
 */
export function duplicateDetector(
  stat: AttachmentStat,
  hashToPaths: Map<string, string[]>
): DetectorHit | null {
  if (!stat.hash) return null;
  const paths = hashToPaths.get(stat.hash);
  if (!paths || paths.length < 2) return null;

  // Count and sample in ONE allocation-free pass. This runs once per cluster
  // member, so the old `paths.filter(...)` allocated a (k-1)-element array per
  // member — O(k^2) pointers of garbage. A pathological cluster is easy to
  // produce (thousands of zero-byte files from a broken sync share one hash),
  // and only the count plus the first 5 names are ever used.
  let count = 0;
  const sample: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    if (paths[i] === stat.path) continue;
    count++;
    if (sample.length < 5) sample.push(paths[i]);
  }
  if (count === 0) return null;

  const more = count > sample.length ? `, +${count - sample.length} more` : "";
  return {
    reason: `Identical to ${count} other file${count === 1 ? "" : "s"}`,
    details: `Same content as: ${sample.join(", ")}${more}`,
  };
}
