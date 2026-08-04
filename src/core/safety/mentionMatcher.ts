// Aho-Corasick multi-pattern substring matcher. No Obsidian API — runs in tests.
//
// The unused-attachment safety scan must check whether ANY of thousands of
// candidate filenames appears in ANY of tens of thousands of note/canvas/text
// sources. Doing that as (candidates x sources x substring) is O(n^2) and takes
// minutes on a large vault. Aho-Corasick scans each source text ONCE against all
// patterns at the same time, so total cost is O(total pattern length + total text
// length + matches) — the whole corpus is read once, not once per candidate.

interface ACNode {
  /**
   * Child transitions, allocated LAZILY. Most nodes in a filename trie are leaves
   * or single-child chain links that never take a second child, and an empty `Map`
   * costs ~80-100 bytes — on a vault with thousands of unused candidates that
   * eager allocation alone accounted for the bulk of the trie's footprint.
   */
  next: Map<number, number> | null;
  fail: number;
  /** Owner ids (candidate indices) of every pattern ending at/through this node. */
  outputs: number[] | null;
}

/**
 * ASCII fan-out width for the root's dense transition row. Over 95% of scan
 * positions sit at the root, where the map is widest and hashing is slowest, so
 * a flat array there buys most of the throughput of a fully-dense automaton at a
 * tiny fraction of the memory. Non-ASCII root transitions fall back to the Map.
 */
const DENSE_ROOT_WIDTH = 128;

/**
 * Build with `addPattern(text, ownerId)` for each pattern (case-insensitive —
 * patterns are lowercased), call `build()` once, then `scanInto(lowerText, hits)`
 * for each source text (already lowercased). Any owner whose pattern is found is
 * added to `hits`.
 */
export class MentionMatcher {
  private nodes: ACNode[] = [{ next: null, fail: 0, outputs: null }];
  private owners: number[] = [];
  private built = false;
  /** Dense ASCII transition row for node 0, filled by {@link build}. */
  private root = new Int32Array(DENSE_ROOT_WIDTH);
  /**
   * Each node's OWN pattern ids — the ids of patterns that literally end there,
   * before any fail-link outputs are merged in. This, not `node.outputs`, is the
   * source of truth: `node.outputs` is derived from it on every build.
   */
  private ownOutputs: number[][] = [];

  addPattern(text: string, ownerId: number): void {
    // Adding after build() would leave the new node's fail links unwired; force a
    // rebuild so a late pattern can never be silently missed.
    this.built = false;
    const t = text.toLowerCase();
    if (!t) return;
    let node = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      const cur = this.nodes[node];
      let map = cur.next;
      if (map === null) {
        map = new Map();
        cur.next = map;
      }
      let nxt = map.get(c);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({ next: null, fail: 0, outputs: null });
        map.set(c, nxt);
      }
      node = nxt;
    }
    const pid = this.owners.length;
    this.owners.push(ownerId);
    // Recorded against the node's OWN list, never against `node.outputs` — which
    // build() overwrites with the merged result.
    const own = this.ownOutputs[node];
    if (own === undefined) this.ownOutputs[node] = [pid];
    else own.push(pid);
  }

  build(): void {
    // Idempotent: a second build must not re-merge fail-link outputs into arrays
    // that already contain them (which would grow them multiplicatively).
    if (this.built) return;

    // Rebuild every node's outputs from its OWN ids before merging. `addPattern`
    // clears `built` so a late pattern gets wired, which means the guard above
    // does not protect an addPattern/build/addPattern/build sequence — and
    // re-merging already-merged arrays compounds: measured 36 -> 157 -> 2570 ->
    // 149851 entries over six rebuilds, ending in a RangeError.
    for (let n = 0; n < this.nodes.length; n++) {
      const own = this.ownOutputs[n];
      this.nodes[n].outputs = own !== undefined && own.length > 0 ? own.slice() : null;
    }

    const queue: number[] = [];
    const rootNext = this.nodes[0].next;
    this.root = new Int32Array(DENSE_ROOT_WIDTH);
    if (rootNext) {
      for (const [c, child] of rootNext) {
        this.nodes[child].fail = 0;
        if (c < DENSE_ROOT_WIDTH) this.root[c] = child;
        queue.push(child);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const uNext = this.nodes[u].next;
      if (uNext === null) continue;
      for (const [c, v] of uNext) {
        let f = this.nodes[u].fail;
        for (;;) {
          const fNext = this.nodes[f].next;
          if (f === 0 || (fNext !== null && fNext.has(c))) break;
          f = this.nodes[f].fail;
        }
        const fnext = this.nodes[f].next?.get(c);
        this.nodes[v].fail = fnext !== undefined && fnext !== v ? fnext : 0;
        // Fail nodes are shallower, so their outputs are already merged (BFS order).
        const failOut = this.nodes[this.nodes[v].fail].outputs;
        if (failOut !== null && failOut.length > 0) {
          const own = this.nodes[v].outputs;
          // Explicit loop, not `push(...failOut)`: the spread passes each element
          // as an argument and throws RangeError once the list exceeds V8's
          // argument limit — reachable in a SINGLE build given enough
          // mutually-suffixing filenames.
          if (own === null) this.nodes[v].outputs = failOut.slice();
          else for (let k = 0; k < failOut.length; k++) own.push(failOut[k]);
        }
        queue.push(v);
      }
    }
    this.built = true;
  }

  /** Scan an already-lowercased text, adding the owner of every matched pattern. */
  scanInto(textLower: string, hits: Set<number>): void {
    if (!this.built) this.build();
    const nodes = this.nodes;
    const root = this.root;
    let node = 0;
    for (let i = 0; i < textLower.length; i++) {
      const c = textLower.charCodeAt(i);
      // Fast path: at the root (where the scan spends most of its time) an ASCII
      // character is one array index instead of a Map hash.
      if (node === 0 && c < DENSE_ROOT_WIDTH) {
        node = root[c];
        if (node === 0) continue; // no transition and nowhere to fail back to
      } else {
        for (;;) {
          const next = nodes[node].next;
          // One `get` instead of `has` + `get`: two hash lookups per character
          // across a 100 MB corpus is ~100M redundant probes.
          const step = next === null ? undefined : next.get(c);
          if (step !== undefined) {
            node = step;
            break;
          }
          if (node === 0) break;
          node = nodes[node].fail;
        }
      }
      const outs = nodes[node].outputs;
      if (outs !== null) {
        for (let k = 0; k < outs.length; k++) hits.add(this.owners[outs[k]]);
      }
    }
  }
}

/**
 * Every distinct lower-cased form a reference to `fileName` might take. Each one
 * we fail to generate is a way for a live file to be reported unused and trashed,
 * so this errs on the side of more patterns:
 *
 * - **NFC and NFD.** macOS stores filenames decomposed ("café" as `e` + combining
 *   accent) while most editors write composed text. The source text is scanned
 *   verbatim (normalizing 100 MB of corpus per pass is far more expensive than
 *   emitting one extra pattern per name), so BOTH forms must be patterns.
 * - **Percent-encoded, for each of those.** HTML/CSS/SVG `src` attributes encode
 *   spaces, `&`, and non-ASCII — and a percent-encoded NFD path (`cafe%CC%81.png`)
 *   shares no substring with the composed name.
 * - **Parenthesis-encoded.** `encodeURIComponent` leaves `()` literal but URLs
 *   frequently encode them: `photo%20%281%29.png`.
 * - **HTML-entity-encoded `&`.** Pasted web content writes `a&amp;b.png`.
 *
 * Cheap in the common case: a pure-ASCII name with no spaces or `&` is identical
 * in all forms and yields exactly one pattern.
 */
export function fileNameVariants(fileName: string): string[] {
  const variants: string[] = [];
  const add = (v: string): void => {
    if (v && !variants.includes(v)) variants.push(v);
  };

  for (const form of ["NFC", "NFD"] as const) {
    let normalized: string;
    try {
      normalized = fileName.normalize(form);
    } catch {
      normalized = fileName;
    }
    const raw = normalized.toLowerCase();
    add(raw);
    // `&` written as an HTML entity in pasted markup.
    if (raw.includes("&")) add(raw.replace(/&/g, "&amp;"));

    let encoded: string;
    try {
      encoded = encodeURIComponent(normalized).toLowerCase();
    } catch {
      encoded = raw;
    }
    add(encoded);
    add(encoded.replace(/\(/g, "%28").replace(/\)/g, "%29"));
  }
  return variants;
}
