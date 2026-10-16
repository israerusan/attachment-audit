// Pure detection of broken attachment links. No Obsidian API — runs in tests.
//
// The inverse of every other detector: instead of a file nothing points at, this
// finds a POINTER with no file. Obsidian hands the whole dataset over in
// `metadataCache.unresolvedLinks` (source note -> link text -> count), so the
// work here is filtering that down to links that actually look like attachments.

import { extensionOf, KNOWN_ATTACHMENT_EXTENSIONS } from "../scan/attachmentFilter";

/** One absent attachment, plus the notes still pointing at it. */
export interface MissingAttachment {
  /** The link text as written, e.g. `assets/logo.png`. */
  link: string;
  /** Just the filename, for display. */
  name: string;
  /** Paths of the notes containing the broken link, sorted, de-duplicated. */
  referencedBy: string[];
}

/**
 * A link is only reported when it carries a RECOGNISED attachment extension.
 *
 * "Has an extension that is not md/canvas/base" is not good enough, and shipped
 * as a permanent noise source: `extensionOf` is "everything after the last dot",
 * so `[[2024.01.15]]` has extension `15` and `[[v1.2 plan]]` has `2 plan`. Both
 * passed, so a vault using dotted daily notes — or any forward link to an
 * uncreated note with a dot in its title — collected a severity-3 "broken
 * attachment" issue per link on every single scan.
 *
 * An allowlist is the right trade here because of what this detector can do:
 * nothing. A missing link is reported, never acted on, so an unrecognised
 * extension costs one absent line, while a false positive costs the credibility
 * of the whole report.
 */
function looksLikeAttachmentLink(link: string): boolean {
  // Strip a heading/block anchor and any display alias before testing.
  const bare = link.split("#")[0].split("|")[0].trim();
  if (!bare) return false;
  // An external URL is not a vault attachment.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) || bare.startsWith("//")) return false;
  const ext = extensionOf(bare);
  if (!ext) return false;
  return KNOWN_ATTACHMENT_EXTENSIONS.has(ext);
}

/**
 * Collapse `unresolvedLinks` into one entry per missing attachment.
 * `isExcluded` lets the caller drop links coming from notes the scan excludes.
 */
export function findMissingAttachments(
  unresolvedLinks: Record<string, Record<string, number>>,
  isExcludedSource: (path: string) => boolean = () => false
): MissingAttachment[] {
  const byLink = new Map<string, Set<string>>();
  for (const source in unresolvedLinks) {
    if (isExcludedSource(source)) continue;
    const links = unresolvedLinks[source];
    for (const link in links) {
      if (!looksLikeAttachmentLink(link)) continue;
      const bare = link.split("#")[0].split("|")[0].trim();
      const sources = byLink.get(bare);
      if (sources) sources.add(source);
      else byLink.set(bare, new Set([source]));
    }
  }

  const out: MissingAttachment[] = [];
  for (const [link, sources] of byLink) {
    out.push({
      link,
      name: link.slice(link.lastIndexOf("/") + 1),
      referencedBy: [...sources].sort(),
    });
  }
  // Stable, useful order: the most-referenced breakages first.
  out.sort((a, b) => b.referencedBy.length - a.referencedBy.length || a.link.localeCompare(b.link));
  return out;
}

/** The human reason and detail shown for one missing attachment. */
export function describeMissing(missing: MissingAttachment): { reason: string; details: string } {
  const n = missing.referencedBy.length;
  const shown = missing.referencedBy.slice(0, 5).join(", ");
  const more = n > 5 ? `, +${n - 5} more` : "";
  return {
    reason: `Linked from ${n} note${n === 1 ? "" : "s"}, but the file is missing`,
    details: `Referenced by: ${shown}${more}`,
  };
}
