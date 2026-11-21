import assert from "node:assert";
import {
  planMove,
  dirName,
  baseName,
  splitExtension,
  joinPath,
  moveTargetPath,
  dedupePath,
  uniquePath,
} from "../src/core/paths/pathRewrite";

assert.strictEqual(dirName("a/b/c.png"), "a/b");
assert.strictEqual(dirName("c.png"), "");
assert.strictEqual(baseName("a/b/c.png"), "c.png");

assert.deepStrictEqual(splitExtension("photo.png"), { stem: "photo", ext: "png" });
assert.deepStrictEqual(splitExtension("noext"), { stem: "noext", ext: "" });
assert.deepStrictEqual(splitExtension(".hidden"), { stem: ".hidden", ext: "" });

assert.strictEqual(joinPath("assets", "a.png"), "assets/a.png");
assert.strictEqual(joinPath("", "a.png"), "a.png");
assert.strictEqual(joinPath("/assets/", "a.png"), "assets/a.png");

// Move into folder keeps the filename; a file already there stays put.
assert.strictEqual(moveTargetPath("notes/a.png", "assets"), "assets/a.png");
assert.strictEqual(moveTargetPath("assets/a.png", "assets"), "assets/a.png");
assert.strictEqual(moveTargetPath("notes/a.png", ""), "notes/a.png");

// Dedupe inserts " (n)" before the extension.
assert.strictEqual(dedupePath("assets/logo.png", 2), "assets/logo (2).png");
assert.strictEqual(dedupePath("logo.png", 3), "logo (3).png");

// uniquePath returns the desired path when free, else the next free suffix.
assert.strictEqual(uniquePath("assets/a.png", () => false), "assets/a.png");
const taken = new Set(["assets/a.png", "assets/a (2).png"]);
assert.strictEqual(uniquePath("assets/a.png", (p) => taken.has(p)), "assets/a (3).png");

// --- planMove ----------------------------------------------------------------
// "Already inside" uses the misplaced detector's case-insensitive rule. With the
// setting typed `assets` and the real folder `Assets`, the move used an exact
// prefix test, so a file the detector accepted was flattened out of its subfolder.
assert.deepStrictEqual(planMove("Assets/2024/photo.png", "assets"), { action: "skip", nested: true });
assert.deepStrictEqual(planMove("Assets/photo.png", "assets"), { action: "skip", nested: false });
assert.deepStrictEqual(planMove("assets/2024/photo.png", "assets"), { action: "skip", nested: true });
assert.deepStrictEqual(planMove("notes/photo.png", "Assets"), { action: "move", target: "Assets/photo.png" });
assert.deepStrictEqual(planMove("photo.png", "media/img"), { action: "move", target: "media/img/photo.png" });
assert.deepStrictEqual(planMove("Media/IMG/a/b.png", "media/img"), { action: "skip", nested: true });
// A sibling whose name merely starts with the folder name is outside it.
assert.deepStrictEqual(planMove("assets-old/photo.png", "assets"), { action: "move", target: "assets/photo.png" });
// A blank folder moves nothing.
assert.deepStrictEqual(planMove("notes/photo.png", "  "), { action: "skip", nested: false });

console.log("pathRewrite tests passed");
