# Architecture

Three invariants hold this plugin together. Each existed only as a comment in one
file before this document, which is how two of the three had already been broken
once. If you change anything here, change this file too.

## 1. `src/core/**` is pure and Node-testable

Nothing under `src/core` imports `obsidian`, with exactly one exception named
below. That is what lets 38 test files run under plain Node with no Obsidian
harness, and it is why the detectors, the regex screen, the settings normalizer
and the restore selector are all testable at all.

**Self-enforcing.** `eslint.config.mjs` applies `no-restricted-imports` to
`src/core/**/*.ts`, so a stray `import { Notice } from "obsidian"` in a detector
fails `npm run lint` rather than silently ending the property.

## 2. `src/core/scan/scanVault.ts` is the only boundary

It is the single file allowed to touch the Obsidian API from the core. It gathers
plain data (`RawAttachmentInput`), then hands it to pure functions:

```
one vault walk
  -> partition into attachment candidates + reference sources
  -> inbound link map          (from metadataCache.resolvedLinks)
  -> size-bucketed SHA-256     (duplicate detection, byte-budgeted)
  -> two-signal "unused" scan  (Aho-Corasick over all source text)
  -> pure detectors
  -> sort + reclaimable total
```

Being the one exempt file makes it a natural place for pure logic to accumulate,
and pure logic hiding behind the exemption is unreachable from the tests. Resist
it; move anything that does not need `app` out.

## 3. Nothing is trashed without BOTH signals, re-checked live

This is the product. A file is only ever trash-eligible when:

1. **No inbound resolved link** — nothing in `metadataCache.resolvedLinks`
   points at it, and
2. **No content mention** — its filename appears in no note body, frontmatter,
   canvas `file` value, CSS snippet, theme, other plugin's `data.json`, or
   non-binary attachment.

The second signal exists because the first cannot see a canvas embed, a raw HTML
`<img src>`, a frontmatter path string, or a `background-image: url(...)` in a
snippet. Obsidian does not resolve those, so without signal 2 every one of them
is an orphan that is actually in use.

Three rules follow, and all three were learned the hard way:

- **The scan's verdict is a snapshot; the action re-checks.** Every destructive
  action calls `findMentionedAttachments` immediately beforehand, and re-checks
  again mid-batch whenever `mutationEpoch` has moved (a sync client, the user, or
  another plugin wrote something). A verdict that was fresh when taken and stale
  when used is the same bug as no verdict at all.
- **Unreadable means blind, never empty.** Any source we cannot read or list —
  a file, a directory, a config folder — marks *every* candidate as mentioned.
  Degrading to "found no references" turns a permissions error into data loss.
- **Classification errs toward reading.** Reference sources are defined by a
  binary *denylist* (`BINARY_ATTACHMENT_EXTS`), not a text allowlist. An
  allowlist makes every format nobody thought of into a file we will delete
  things on behalf of but never read.

## Where things live

| Path | Holds |
| --- | --- |
| `src/core/scan/` | the boundary, attachment classification, folder matching |
| `src/core/detectors/` | one pure function per issue type |
| `src/core/safety/` | the Aho-Corasick mention matcher, canvas path extraction |
| `src/core/journal/` | the cleanup journal and trashed-file identification |
| `src/core/rules/` | custom rules, the regex safety screen, severity sorting |
| `src/core/settings/` | defaults, migrations, normalization of untrusted `data.json` |
| `src/ui/` | the dashboard, results list, modals — DOM only |
| `src/main.ts` | plugin lifecycle, commands, and the destructive actions |

`src/main.ts` is the known weak point: it still carries scan orchestration, the
destructive actions, the restore subsystem, and persisted-state bookkeeping in
one class. The extractions worth doing, in order of value, are the restore
subsystem (`recordBatch` through `ensureParentFolder`), the cleanup actions, and
the path-remapping helpers (`migratePath`, `remapLastResult`, `dropPath`), which
are pure and currently untested.

## Identity

`manifest.id`, `PRODUCT_ID` in `src/product.ts`, and the `product` field the
license signer writes must all be the same string. `manifest.id` names the
install folder the scan skips when reading other plugins' data; `PRODUCT_ID` is
signed into every license key. A drift between any two is silent, and
`test/manifest-contract.test.mjs` is what catches it.

## Testing

`npm test` = typecheck + ESLint (the Obsidian review bot's own ruleset, plus the
purity boundary) + `node test/run.mjs`, which esbuild-bundles every
`test/*.test.ts` against a minimal `obsidian` stub.

Two suites are property tests rather than example tests, and both guard proofs
that have been wrong before:

- `regexSafetySoundness.test.ts` — every pattern the screen accepts as a
  repeated alternation must really have disjoint branches.
- `regexSafetyBudget.test.ts` — every pattern the screen accepts must actually
  run fast on adversarial input at the 255-character cap, because that pattern
  runs once per attachment on the UI thread.
