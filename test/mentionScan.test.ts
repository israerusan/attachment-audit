import assert from "node:assert";
import { extractCanvasFilePaths } from "../src/core/safety/mentionScan";
import { MentionMatcher, fileNameVariants } from "../src/core/safety/mentionMatcher";

// The mention semantics that used to be tested against `buildMentionCorpus` /
// `isMentioned` are asserted here against the LIVE path (Aho-Corasick), so
// removing those superseded helpers loses no coverage.
function mentioned(fileName: string, sources: string[]): boolean {
  const matcher = new MentionMatcher();
  for (const variant of fileNameVariants(fileName)) matcher.addPattern(variant, 0);
  matcher.build();
  const hits = new Set<number>();
  for (const source of sources) matcher.scanInto(source.toLowerCase(), hits);
  return hits.has(0);
}

const SOURCES = [
  "See ![[assets/Logo.png]] and a banner: cover.JPG",
  '<img src="assets/my%20photo.png">',
];

// Full filename matches, case-insensitively, path-embedded.
assert.strictEqual(mentioned("Logo.png", SOURCES), true);
assert.strictEqual(mentioned("logo.png", SOURCES), true);
assert.strictEqual(mentioned("cover.jpg", SOURCES), true);

// Percent-encoded spaces match a filename that contains a space.
assert.strictEqual(mentioned("my photo.png", SOURCES), true);

// An unrelated file is not mentioned.
assert.strictEqual(mentioned("unused.png", SOURCES), false);

// An empty name never suppresses a flag.
assert.strictEqual(mentioned("", SOURCES), false);

// A CSS snippet's url() reference counts — this is the case that made the old
// narrow source list unsafe (snippets live outside vault.getFiles()).
assert.strictEqual(mentioned("bg.png", ['body { background-image: url("Attachments/bg.png"); }']), true);

// A LaTeX include in a .tex note counts.
assert.strictEqual(mentioned("fig1.png", ["\\includegraphics{assets/fig1.png}"]), true);

// Canvas file extraction pulls out embedded file paths; malformed JSON is safe.
const canvas = JSON.stringify({
  nodes: [
    { type: "file", file: "assets/diagram.png" },
    { type: "text", text: "hello" },
    { type: "file", file: "assets/photo.jpg" },
  ],
});
assert.deepStrictEqual(extractCanvasFilePaths(canvas), ["assets/diagram.png", "assets/photo.jpg"]);
assert.deepStrictEqual(extractCanvasFilePaths("{ not json"), []);
assert.deepStrictEqual(extractCanvasFilePaths("{}"), []);
assert.deepStrictEqual(extractCanvasFilePaths(""), []);
// A canvas whose nodes are not an array must not throw.
assert.deepStrictEqual(extractCanvasFilePaths('{"nodes":"nope"}'), []);

console.log("mentionScan tests passed");
