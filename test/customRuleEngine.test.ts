import assert from "node:assert";
import { evaluateRule, runCustomRules, ruleInScope } from "../src/core/rules/customRuleEngine";
import type { CustomRule } from "../src/types";
import { makeStat } from "./_helpers";

const NOW = Date.parse("2026-07-06T00:00:00Z");

function rule(over: Partial<CustomRule>): CustomRule {
  return {
    id: over.id ?? "r1",
    name: over.name ?? "Rule",
    enabled: over.enabled ?? true,
    scope: over.scope ?? {},
    condition: over.condition ?? { type: "extension-is", extension: "png" },
    severity: over.severity ?? 2,
    message: over.message ?? "",
  };
}

// extension-is (normalizes a leading dot + case).
assert.notStrictEqual(evaluateRule(makeStat({ extension: "png" }), rule({ condition: { type: "extension-is", extension: ".PNG" } }), NOW), null);
assert.strictEqual(evaluateRule(makeStat({ extension: "jpg" }), rule({ condition: { type: "extension-is", extension: "png" } }), NOW), null);

// larger-than-kb.
assert.notStrictEqual(evaluateRule(makeStat({ size: 2048 }), rule({ condition: { type: "larger-than-kb", kb: 1 } }), NOW), null);
assert.strictEqual(evaluateRule(makeStat({ size: 512 }), rule({ condition: { type: "larger-than-kb", kb: 1 } }), NOW), null);

// in-folder.
assert.notStrictEqual(evaluateRule(makeStat({ path: "old/a.png" }), rule({ condition: { type: "in-folder", folder: "old" } }), NOW), null);
assert.strictEqual(evaluateRule(makeStat({ path: "new/a.png" }), rule({ condition: { type: "in-folder", folder: "old" } }), NOW), null);

// name-matches (against the BASENAME, extension stripped); malformed regex is safe.
assert.notStrictEqual(evaluateRule(makeStat({ name: "scan001.png", basename: "scan001" }), rule({ condition: { type: "name-matches", pattern: "^scan\\d+" } }), NOW), null);
// An anchored pattern matches the basename, not the full filename with extension.
assert.notStrictEqual(evaluateRule(makeStat({ name: "tmp.pdf", basename: "tmp" }), rule({ condition: { type: "name-matches", pattern: "^tmp$" } }), NOW), null);
assert.strictEqual(evaluateRule(makeStat({ name: "photo.png", basename: "photo" }), rule({ condition: { type: "name-matches", pattern: "(" } }), NOW), null);
// in-folder tolerates a leading slash (matches misplacedDetector normalization).
assert.notStrictEqual(evaluateRule(makeStat({ path: "Assets/x.png" }), rule({ condition: { type: "in-folder", folder: "/Assets" } }), NOW), null);

// older-than-days.
const old = makeStat({ mtime: NOW - 100 * 24 * 3600 * 1000 });
assert.notStrictEqual(evaluateRule(old, rule({ condition: { type: "older-than-days", days: 90 } }), NOW), null);

// Disabled rule never fires.
assert.strictEqual(evaluateRule(makeStat({ extension: "png" }), rule({ enabled: false }), NOW), null);

// Scope: a folder-scoped rule skips out-of-scope files.
assert.strictEqual(ruleInScope(makeStat({ path: "a/x.png" }), { folders: ["b"] }), false);
assert.strictEqual(ruleInScope(makeStat({ path: "b/x.png" }), { folders: ["b"] }), true);
assert.strictEqual(ruleInScope(makeStat({ path: "any.png" }), {}), true);

// Custom message wins over synthesized; empty message synthesizes.
assert.strictEqual(evaluateRule(makeStat({ extension: "png" }), rule({ message: "Too big!" }), NOW)?.reason, "Too big!");
assert.strictEqual(evaluateRule(makeStat({ extension: "png" }), rule({ message: "" }), NOW)?.reason, "Extension is .png");

// runCustomRules returns hits in order.
const hits = runCustomRules(
  makeStat({ extension: "png", size: 5000 }),
  [
    rule({ id: "a", condition: { type: "extension-is", extension: "png" } }),
    rule({ id: "b", condition: { type: "larger-than-kb", kb: 1 } }),
    rule({ id: "c", condition: { type: "extension-is", extension: "gif" } }),
  ],
  NOW
);
assert.deepStrictEqual(hits.map((h) => h.ruleId), ["a", "b"]);

// Folder matching is case-insensitive and backslash-tolerant, exactly like the
// misplaced detector and the exclusion settings. The engine used to carry its own
// exact-prefix copy, so a rule scoped to `assets` never fired for `Assets/`.
assert.notStrictEqual(
  evaluateRule(makeStat({ path: "Assets/old/x.png" }), rule({ condition: { type: "in-folder", folder: "assets/old" } }), NOW),
  null,
  "in-folder must ignore case"
);
assert.notStrictEqual(
  evaluateRule(makeStat({ path: "Assets/old/x.png" }), rule({ condition: { type: "in-folder", folder: "assets\\old" } }), NOW),
  null,
  "in-folder must fold a typed backslash"
);
assert.strictEqual(ruleInScope(makeStat({ path: "Scans/x.png" }), { folders: ["scans"] }), true, "scope must ignore case");
assert.strictEqual(ruleInScope(makeStat({ path: "Scansmore/x.png" }), { folders: ["scans"] }), false, "still a folder boundary");
assert.strictEqual(ruleInScope(makeStat({ path: "x.png" }), { folders: [""] }), false, "a blank scope entry matches nothing");

console.log("customRuleEngine tests passed");
