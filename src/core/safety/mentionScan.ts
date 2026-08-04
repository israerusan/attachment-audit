// Pure canvas reference extraction. No Obsidian API — runs in tests under Node.
//
// This file used to also host `buildMentionCorpus` / `isMentioned`, a
// concatenate-everything-then-substring-search implementation of the unused
// detector's SECOND signal. That approach was O(candidates x corpus) and has been
// replaced by the Aho-Corasick matcher in `./mentionMatcher`, which scans each
// source once against every candidate at the same time. The old pair was left
// exported and unused, with a docblock still describing it as the live second
// signal — actively misleading in a file that decides what gets deleted.

/**
 * Extract every `file` path referenced by a `.canvas` document's JSON. Canvas
 * attachment embeds never appear in `resolvedLinks`, so the scan boundary feeds
 * these into the mention corpus. Malformed JSON yields an empty list (never throws).
 */
export function extractCanvasFilePaths(canvasJson: string): string[] {
  try {
    const data = JSON.parse(canvasJson) as { nodes?: Array<{ type?: string; file?: string }> };
    if (!data || !Array.isArray(data.nodes)) return [];
    const paths: string[] = [];
    for (const node of data.nodes) {
      if (node && typeof node.file === "string" && node.file) paths.push(node.file);
    }
    return paths;
  } catch {
    return [];
  }
}
