// Author-only tool. Signs a Attachment Audit Pro license key for a customer.
// Requires scripts/.license-private.key (never commit or publish it).
//
//   npm run license:generate -- customer@email.com
//
import fs from "fs";
import path from "path";
import nacl from "tweetnacl";
import { fileURLToPath } from "url";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKeyPath = path.join(__dirname, ".license-private.key");
// The plugin id, read from the one place that defines it rather than restated.
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);

function toBase64(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run license:generate -- customer@email.com");
  process.exit(1);
}

if (!fs.existsSync(privateKeyPath)) {
  console.error("Missing scripts/.license-private.key — cannot sign licenses.");
  process.exit(1);
}

const secretKey = fromBase64(fs.readFileSync(privateKeyPath, "utf8").trim());
// Read from manifest.json, never restated. The signed `product` must equal the
// plugin id that `verifyLicense` checks, and this repo has already been renamed
// once (attachment-manager -> attachment-audit). A hardcoded copy here would keep
// minting keys for the old product after the next rename: every paid key would
// fail with "This key is not for Attachment Audit Pro" — indistinguishable from a
// forgery — and the whole test suite would still pass.
const payload = {
  product: manifest.id,
  email,
  issued: new Date().toISOString(),
};
const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
const signature = nacl.sign.detached(payloadBytes, secretKey);
const licenseKey = `${toBase64(payloadBytes)}.${toBase64(signature)}`;

console.log("\nAttachment Audit — Pro license\n");
console.log(`Email: ${email}`);
console.log(`Key:   ${licenseKey}\n`);
