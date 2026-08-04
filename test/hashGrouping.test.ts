import assert from "node:assert";
import { sizeCollisionCandidates, groupByHash } from "../src/core/dedupe/hashGrouping";

// Only files sharing a size with another survive.
const files = [
  { path: "a", size: 100 },
  { path: "b", size: 100 },
  { path: "c", size: 200 }, // unique size -> dropped
  { path: "d", size: 300 },
  { path: "e", size: 300 },
];
const collide = sizeCollisionCandidates(files);
assert.deepStrictEqual(collide.map((f) => f.path).sort(), ["a", "b", "d", "e"]);

// groupByHash keeps only clusters of 2+.
const grouped = groupByHash([
  { path: "a", hash: "x" },
  { path: "b", hash: "x" },
  { path: "c", hash: "y" }, // singleton -> dropped
  { path: "d" }, // no hash -> ignored
]);
assert.strictEqual(grouped.size, 1);
assert.deepStrictEqual(grouped.get("x"), ["a", "b"]);
assert.strictEqual(grouped.has("y"), false);

console.log("hashGrouping tests passed");

// --- Zero-byte files must never form a duplicate cluster --------------------
// Every empty file shares the SHA-256 of the empty string, so a folder of failed
// downloads (.png, .pdf, .zip) would otherwise become ONE cluster reported as
// "identical" — and "trash duplicate copies" would delete hundreds of unrelated
// files to reclaim exactly 0 bytes.
const empties = sizeCollisionCandidates([
  { path: "a.png", size: 0 },
  { path: "b.pdf", size: 0 },
  { path: "c.zip", size: 0 },
]);
assert.deepStrictEqual(empties, [], "empty files are never hashing candidates");

// Mixed: the real collision is still found, the empties are still excluded.
const mixed = sizeCollisionCandidates([
  { path: "empty1.png", size: 0 },
  { path: "empty2.png", size: 0 },
  { path: "real1.png", size: 100 },
  { path: "real2.png", size: 100 },
  { path: "unique.png", size: 55 },
]);
assert.deepStrictEqual(
  mixed.map((f) => f.path),
  ["real1.png", "real2.png"]
);

// A negative size (defensive: a stat that failed) is treated the same way.
assert.deepStrictEqual(
  sizeCollisionCandidates([
    { path: "x.png", size: -1 },
    { path: "y.png", size: -1 },
  ]),
  []
);

console.log("hashGrouping zero-byte tests passed");
