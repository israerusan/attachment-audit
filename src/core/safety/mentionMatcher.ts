// Aho-Corasick multi-pattern substring matcher. No Obsidian API — runs in tests.
//
// The unused-attachment safety scan must check whether ANY of thousands of
// candidate filenames appears in ANY of tens of thousands of note/canvas/text
// sources. Doing that as (candidates x sources x substring) is O(n^2) and takes
// minutes on a large vault. Aho-Corasick scans each source text ONCE against all
// patterns at the same time, so total cost is O(total pattern length + total text
// length + matches) — the whole corpus is read once, not once per candidate.

interface ACNode {
  next: Map<number, number>;
  fail: number;
  /** Owner ids (candidate indices) of every pattern ending at/through this node. */
  outputs: number[];
}

/**
 * Build with `addPattern(text, ownerId)` for each pattern (case-insensitive —
 * patterns are lowercased), call `build()` once, then `scanInto(lowerText, hits)`
 * for each source text (already lowercased). Any owner whose pattern is found is
 * added to `hits`.
 */
export class MentionMatcher {
  private nodes: ACNode[] = [{ next: new Map(), fail: 0, outputs: [] }];
  private owners: number[] = [];
  private built = false;

  addPattern(text: string, ownerId: number): void {
    // Adding after build() would leave the new node's fail links unwired; force a
    // rebuild so a late pattern can never be silently missed.
    this.built = false;
    const t = text.toLowerCase();
    if (!t) return;
    let node = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      let nxt = this.nodes[node].next.get(c);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        this.nodes[node].next.set(c, nxt);
      }
      node = nxt;
    }
    const pid = this.owners.length;
    this.owners.push(ownerId);
    this.nodes[node].outputs.push(pid);
  }

  build(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      for (const [c, v] of this.nodes[u].next) {
        let f = this.nodes[u].fail;
        while (f !== 0 && !this.nodes[f].next.has(c)) f = this.nodes[f].fail;
        const fnext = this.nodes[f].next.get(c);
        this.nodes[v].fail = fnext !== undefined && fnext !== v ? fnext : 0;
        // Fail nodes are shallower, so their outputs are already merged (BFS order).
        const failOut = this.nodes[this.nodes[v].fail].outputs;
        if (failOut.length) this.nodes[v].outputs.push(...failOut);
        queue.push(v);
      }
    }
    this.built = true;
  }

  /** Scan an already-lowercased text, adding the owner of every matched pattern. */
  scanInto(textLower: string, hits: Set<number>): void {
    if (!this.built) this.build();
    let node = 0;
    for (let i = 0; i < textLower.length; i++) {
      const c = textLower.charCodeAt(i);
      while (node !== 0 && !this.nodes[node].next.has(c)) node = this.nodes[node].fail;
      node = this.nodes[node].next.get(c) ?? 0;
      const outs = this.nodes[node].outputs;
      for (let k = 0; k < outs.length; k++) hits.add(this.owners[outs[k]]);
    }
  }
}

/**
 * The distinct lower-cased search forms of a filename that a reference might use:
 * the raw name and its URL-encoded form (which covers spaces → %20, `&` → %26,
 * parentheses, and non-ASCII). Both are matched so an HTML/CSS/SVG `src` that
 * percent-encodes the name still suppresses an "unused" flag.
 */
export function fileNameVariants(fileName: string): string[] {
  // Normalize to NFC so an NFD-composed reference (common on macOS, e.g. "café"
  // as e + combining accent) matches an NFC filename — a missed match here could
  // let a still-referenced file be flagged unused and trashed.
  const normalized = fileName.normalize("NFC");
  const raw = normalized.toLowerCase();
  const variants = [raw];
  let encoded: string;
  try {
    encoded = encodeURIComponent(normalized).toLowerCase();
  } catch {
    encoded = raw;
  }
  if (encoded !== raw) variants.push(encoded);
  // encodeURIComponent leaves parentheses (and a few others) literal, but URLs
  // often encode them — add a variant with () percent-encoded so an HTML/CSS src
  // like "photo%20%281%29.png" still suppresses the unused flag.
  const parensEncoded = encoded.replace(/\(/g, "%28").replace(/\)/g, "%29");
  if (parensEncoded !== encoded && !variants.includes(parensEncoded)) {
    variants.push(parensEncoded);
  }
  return variants;
}
