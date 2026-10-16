import assert from "node:assert";
import { folderKey, isInsideFolder, samePath } from "../src/core/scan/folderMatch";
import { isExcluded, includedByFolders } from "../src/core/scan/fileFilters";
import { misplacedDetector } from "../src/core/detectors/misplacedDetector";
import type { AttachmentStat } from "../src/types";

// Every folder setting in this plugin is free-typed text. Matching it against
// vault paths with an exact, case-sensitive prefix test made two settings wrong in
// opposite directions, and both failures were silent:
//
//   - EXCLUSION under-matched: typing `templates` for a folder named `Templates`
//     excluded nothing, while the UI showed the exclusion as configured. Every
//     attachment under it became a scan candidate AND a trash candidate.
//   - MISPLACED over-matched: `attachmentFolder` of `assets` against a folder
//     named `Assets` flagged every attachment in the vault as misplaced.

const stat = (path: string): AttachmentStat => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
  extension: "png",
  size: 10,
  mtime: 0,
  inboundLinks: 0,
});

// --- folderKey ---------------------------------------------------------------
assert.strictEqual(folderKey("  Templates/  "), "templates");
assert.strictEqual(folderKey("/Assets/Images/"), "assets/images");
assert.strictEqual(folderKey(""), "");
assert.strictEqual(folderKey("   "), "");
// A Windows-style entry could never match a vault path, which always uses `/`.
// Folding it is strictly better than letting it fail quietly.
assert.strictEqual(folderKey("Assets\\Images"), "assets/images");

// --- isInsideFolder ----------------------------------------------------------
assert.ok(isInsideFolder("Templates/a.png", "templates"), "case must not matter");
assert.ok(isInsideFolder("templates/a.png", "Templates"), "in either direction");
assert.ok(isInsideFolder("Assets/Images/a.png", "assets"), "any depth beneath");
assert.ok(isInsideFolder("Assets", "assets"), "the folder itself");
// A sibling whose name merely STARTS with the folder name is not inside it.
assert.ok(!isInsideFolder("assets-old/a.png", "assets"), "prefix is not containment");
assert.ok(!isInsideFolder("notes/a.png", "assets"));
// A blank folder restricts nothing, and must never match everything.
assert.ok(!isInsideFolder("anything/a.png", ""));
assert.ok(!isInsideFolder("anything/a.png", "   "));

// --- samePath ----------------------------------------------------------------
assert.ok(samePath("Assets/Logo.PNG", "assets/logo.png"));
assert.ok(!samePath("Assets/Logo.PNG", ""), "a blank entry matches nothing");

// --- the two settings that were broken ---------------------------------------
assert.ok(
  isExcluded("Templates/x.png", [], {
    excludedFolders: ["templates"],
    excludedPaths: [],
    excludedTags: [],
  }),
  "a case-mismatched excluded folder must still exclude"
);
assert.ok(
  isExcluded("Assets/Logo.png", [], {
    excludedFolders: [],
    excludedPaths: ["assets/logo.png"],
    excludedTags: [],
  }),
  "an excluded path is compared the same way"
);
assert.strictEqual(
  misplacedDetector(stat("Assets/a.png"), "assets"),
  null,
  "a case-mismatched attachment folder must not flag every file as misplaced"
);
assert.ok(
  misplacedDetector(stat("Inbox/a.png"), "assets"),
  "a genuinely outside file is still flagged"
);

// --- include-folder restriction ---------------------------------------------
assert.ok(includedByFolders("anything.png", []), "no restriction includes everything");
assert.ok(includedByFolders("x.png", ["  ", ""]), "blank entries are not a restriction");
assert.ok(includedByFolders("Assets/x.png", ["assets"]), "case-insensitive here too");
assert.ok(!includedByFolders("Notes/x.png", ["assets"]));

// Attachments carry no tags, so the tag path must not be reached for them — this
// is the hot loop, once per vault file.
assert.ok(
  !isExcluded("a.png", [], { excludedFolders: [], excludedPaths: [], excludedTags: [] }),
  "an empty config excludes nothing"
);
assert.ok(
  isExcluded("note.md", ["#archive"], {
    excludedFolders: [],
    excludedPaths: [],
    excludedTags: ["archive"],
  }),
  "tags still work where they exist"
);

console.log("folderMatch tests passed");
