// Manifest/versions contract — the checks Obsidian's review runs on manifest.json
// that eslint-plugin-obsidianmd's `validate-manifest` can't (eslint doesn't lint the
// JSON file without a JSON language plugin). Locks the class of issues that delist a
// plugin (redundant words in the metadata) plus release-version consistency.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

// --- Redundant words the review rejects -------------------------------------
// The review bot's validate-manifest rule does a blunt case-insensitive SUBSTRING
// check for "obsidian" and "plugin" in name/description/id — with NO exceptions.
for (const key of ["name", "description", "id"]) {
	for (const word of ["obsidian", "plugin"]) {
		assert.ok(
			!new RegExp(word, "i").test(manifest[key]),
			`manifest.${key} must not contain "${word}" (the Obsidian review bot rejects it)`
		);
	}
}

// --- Shape -------------------------------------------------------------------
assert.ok(/^[a-z0-9-]+$/.test(manifest.id), "manifest.id must be lowercase letters/digits/hyphens");
assert.ok(manifest.minAppVersion && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), "manifest.minAppVersion must be set (x.y.z)");
assert.ok(manifest.author, "manifest.author must be set");

// --- Portfolio identity: one author string across every plugin, so the community
// --- directory shows a single developer instead of several. Change CANONICAL_AUTHOR
// --- in every repo at once if it ever needs to change.
const CANONICAL_AUTHOR = "Israel Avila";
assert.equal(manifest.author, CANONICAL_AUTHOR, `manifest.author must be "${CANONICAL_AUTHOR}" across the whole portfolio`);

// --- Description policy (Obsidian community directory submission requirements).
// --- The directory card truncates long descriptions, so keep them short and benefit-first.
assert.ok(manifest.description.length <= 250, `manifest.description must be <= 250 chars (is ${manifest.description.length})`);
assert.ok(manifest.description.trim().endsWith("."), "manifest.description must end with a period");
assert.ok([...manifest.description].every((ch) => ch.codePointAt(0) < 128), "manifest.description must be ascii only (no emoji)");
assert.equal(typeof manifest.isDesktopOnly, "boolean", "manifest.isDesktopOnly must be a boolean");

// --- Release consistency (tag == manifest version, listed in versions.json) --
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must be x.y.z");
assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
assert.ok(versions[manifest.version], `versions.json must contain an entry for ${manifest.version}`);

// --- The product id must agree EVERYWHERE -------------------------------------
// Three independent copies of this string decide whether a paid key works:
// `manifest.id` names the install folder, `PRODUCT_ID` is signed into every
// license and is what `verifyLicense` compares against, and the signer writes the
// `product` field. A drift between any two is silent — the suite passed, the
// plugin loaded, and every issued key failed with a message indistinguishable
// from a forgery. `manifest.id` also names the install folder that the scan skips
// when reading other plugins' data.json, so a drift there quietly reintroduces
// the 1.2.1 bug where the plugin suppressed its own detection.
const productSrc = fs.readFileSync(path.join(root, "src", "product.ts"), "utf8");
const declaredId = /export const PRODUCT_ID = "([^"]+)"/.exec(productSrc)?.[1];
assert.equal(declaredId, manifest.id, "PRODUCT_ID in src/product.ts must equal manifest.id");

const signerSrc = fs.readFileSync(path.join(root, "scripts", "generate-license.mjs"), "utf8");
assert.ok(
	/product:\s*manifest\.id/.test(signerSrc),
	"the license signer must read the product id from manifest.json, not restate it"
);

console.log("ok  manifest-contract.test.mjs");
