// Exercises the real shared verifier with ephemeral keypairs, so it needs no
// signing key. Skips cleanly on a keyless env only if tweetnacl is missing.
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nacl from "tweetnacl";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { verifyLicense } = await import(
  pathToFileURL(path.join(root, "src", "shared", "verifyLicense.mjs")).href
);

const PRODUCT = "attachment-audit";

function b64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeKey(secretKey, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = nacl.sign.detached(bytes, secretKey);
  return `${b64url(bytes)}.${b64url(sig)}`;
}

const kp = nacl.sign.keyPair();
const pub = Buffer.from(kp.publicKey).toString("base64");

// Valid key for this product.
const good = makeKey(kp.secretKey, {
  product: PRODUCT,
  email: "buyer@example.com",
  issued: "2026-07-05T00:00:00Z",
});
let r = verifyLicense(good, PRODUCT, pub);
assert.ok(r.valid, "a correctly-signed key for this product must verify");
assert.equal(r.email, "buyer@example.com", "verified email is returned");

// Wrong product.
const wrongProduct = makeKey(kp.secretKey, { product: "some-other-plugin", email: "x@y.z" });
r = verifyLicense(wrongProduct, PRODUCT, pub);
assert.ok(!r.valid, "a key for a different product must be rejected");

// Tampered payload (signature no longer matches).
const [payloadPart, sigPart] = good.split(".");
const tamperedPayload = b64url(
  new TextEncoder().encode(
    JSON.stringify({ product: PRODUCT, email: "attacker@example.com" })
  )
);
r = verifyLicense(`${tamperedPayload}.${sigPart}`, PRODUCT, pub);
assert.ok(!r.valid, "a tampered payload must fail the signature check");

// Wrong public key.
const other = nacl.sign.keyPair();
r = verifyLicense(good, PRODUCT, Buffer.from(other.publicKey).toString("base64"));
assert.ok(!r.valid, "a key must not verify against the wrong public key");

// Malformed inputs.
assert.ok(!verifyLicense("", PRODUCT, pub).valid, "empty key rejected");
assert.ok(!verifyLicense("notadotkey", PRODUCT, pub).valid, "no-dot key rejected");
assert.ok(!verifyLicense(`${payloadPart}.@@@`, PRODUCT, pub).valid, "bad base64 rejected");

console.log("license verification tests passed");
