import assert from "node:assert";
import { findMissingAttachments, describeMissing } from "../src/core/detectors/missingDetector";

// --- Only ATTACHMENT-looking links are reported -----------------------------
// Without this filter every unresolved [[Some Note]] — the normal way people
// write forward links in Obsidian — would be reported as a broken attachment.
const basic = findMissingAttachments({
  "Note A.md": {
    "assets/logo.png": 1,
    "Some Future Note": 1, // a plain forward link, NOT an attachment
    "Another Note.md": 1, // an explicit .md link is still a document
  },
});
assert.strictEqual(basic.length, 1);
assert.strictEqual(basic[0].link, "assets/logo.png");
assert.strictEqual(basic[0].name, "logo.png");
assert.deepStrictEqual(basic[0].referencedBy, ["Note A.md"]);

// --- One entry per missing file, listing every referencing note -------------
const shared = findMissingAttachments({
  "A.md": { "img/hero.jpg": 2 },
  "B.md": { "img/hero.jpg": 1 },
  "C.md": { "img/solo.png": 1 },
});
assert.strictEqual(shared.length, 2);
// Most-referenced first.
assert.strictEqual(shared[0].link, "img/hero.jpg");
assert.deepStrictEqual(shared[0].referencedBy, ["A.md", "B.md"]);
assert.deepStrictEqual(shared[1].referencedBy, ["C.md"]);

// --- Anchors and aliases are stripped before grouping -----------------------
const anchored = findMissingAttachments({
  "A.md": { "doc.pdf#page=3": 1 },
  "B.md": { "doc.pdf|The Doc": 1 },
  "C.md": { "doc.pdf": 1 },
});
assert.strictEqual(anchored.length, 1, "all three forms are the same missing file");
assert.deepStrictEqual(anchored[0].referencedBy, ["A.md", "B.md", "C.md"]);

// --- External URLs are not vault attachments --------------------------------
const external = findMissingAttachments({
  "A.md": {
    "https://example.com/pic.png": 1,
    "http://example.com/x.jpg": 1,
    "//cdn.example.com/y.gif": 1,
  },
});
assert.deepStrictEqual(external, []);

// --- Extension-less links are never attachments -----------------------------
assert.deepStrictEqual(findMissingAttachments({ "A.md": { "Some Note": 1 } }), []);
assert.deepStrictEqual(findMissingAttachments({ "A.md": { "": 1 } }), []);
assert.deepStrictEqual(findMissingAttachments({ "A.md": { "  ": 1 } }), []);

// --- Excluded sources are skipped -------------------------------------------
// Our own generated reports wikilink every unused attachment they name; counting
// them would report each one as a broken link the moment it IS trashed.
const excluded = findMissingAttachments(
  {
    "Attachment Audit Reports/Report 2026-08-03-18-30-00.md": { "gone.png": 1 },
    "Real Note.md": { "alsogone.png": 1 },
  },
  (source) => source.startsWith("Attachment Audit Reports/")
);
assert.strictEqual(excluded.length, 1);
assert.strictEqual(excluded[0].link, "alsogone.png");

// --- Empty input ------------------------------------------------------------
assert.deepStrictEqual(findMissingAttachments({}), []);

// --- Description copy -------------------------------------------------------
const one = describeMissing({ link: "a.png", name: "a.png", referencedBy: ["N.md"] });
assert.ok(one.reason.includes("1 note"), "singular wording");
assert.ok(one.details.includes("N.md"));
const many = describeMissing({
  link: "a.png",
  name: "a.png",
  referencedBy: ["1.md", "2.md", "3.md", "4.md", "5.md", "6.md", "7.md"],
});
assert.ok(many.reason.includes("7 notes"), "plural wording");
assert.ok(many.details.includes("+2 more"), "long lists are truncated");

console.log("missingDetector tests passed");
