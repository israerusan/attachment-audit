// Pure raw-content mention matching. No Obsidian API — runs in tests under Node.
import { fileNameVariants } from "./mentionMatcher";
//
// The unused detector's SECOND signal. `resolvedLinks` misses several ways a note
// can reference an attachment (frontmatter plain-string paths, raw <img src>,
// canvas `file` values, references from SVG/HTML/CSS). Before we ever call a file
// "unused" — and offer to trash it — we also check whether its filename appears
// anywhere in a corpus of raw source text. Any match SUPPRESSES the flag, so the
// bias is firmly toward NOT flagging a file that might still be in use.

/**
 * Build the lowercased search corpus once from all raw source texts (note bodies
 * incl. frontmatter, canvas `file` values, text-attachment contents). Lowercasing
 * up front lets `isMentioned` do a plain case-insensitive substring test.
 */
export function buildMentionCorpus(sources: string[]): string {
  // NFC-normalize so NFD-composed references match NFC filenames (see fileNameVariants).
  return sources.join("\n").normalize("NFC").toLowerCase();
}

/**
 * True when a reference to `fileName` (the FULL filename including extension)
 * appears in the corpus. We match the whole filename — not the bare basename —
 * because a bare stem like "image" would clear far too many real unused files;
 * a genuine reference almost always includes the extension. Every URL-encoded
 * form ({@link fileNameVariants}: raw + percent-encoded, covering spaces `%20`,
 * `&` `%26`, parentheses, and non-ASCII) is checked, since HTML/CSS/SVG `src`
 * attributes and some link forms encode the name.
 */
export function isMentioned(fileName: string, corpusLower: string): boolean {
  if (!fileName) return false;
  for (const variant of fileNameVariants(fileName)) {
    if (corpusLower.includes(variant)) return true;
  }
  return false;
}

/**
 * Extract every `file` path referenced by a `.canvas` document's JSON. Canvas
 * attachment embeds never appear in `resolvedLinks`, so the boundary feeds these
 * into the corpus. Malformed JSON yields an empty list (never throws).
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
