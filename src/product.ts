// Central product metadata and marketing copy. Keeping these in one place keeps
// the license binding, upsell surfaces, and settings copy consistent.

/** Signed into every license payload; a key only unlocks the product it names. */
export const PRODUCT_ID = "attachment-audit";

/** Plugin-owned folder for exported reports; always skipped by scans. */
export const REPORT_FOLDER = "Attachment Audit Reports";

export const PRODUCT_NAME = "Attachment Audit";
export const PRO_NAME = "Attachment Audit Pro";

/** Where "Unlock Pro" sends people. Confirm the real handle before release. */
export const PURCHASE_URL = "https://buymeacoffee.com/vaultspotlight/e/560207";

/** Where a happy user can leave a star/review (helps discovery). */
export const REVIEW_URL = "https://github.com/israerusan/attachment-audit";

/** One-time price. Kept in one place so every surface stays consistent. */
export const PRO_PRICE_LABEL = "$9 one-time";

/** One-line pitch for the Pro tier, reused across upsell surfaces. */
export const PRO_TAGLINE =
  "One-click safe bulk cleanup — trash, dedupe, and move across many files at once, links kept intact and everything recoverable. Plus saved profiles, custom rules, and report export. $9 one-time, no subscription, no account.";

/** Contextual upsell copy, keyed by the feature the user reached for. */
/**
 * The features that are actually gated, as a closed union.
 *
 * `Record<string, string>` let a misspelled key compile and render "undefined"
 * into the upsell modal's body. It also hid two keys that contradicted shipped
 * behaviour: `export` claimed report export was Pro (it is free, deliberately —
 * see `exportReportCommand`) and `severity`/`rules` were never passed to
 * `requirePro` at all, because the settings tab gates those with its own locked
 * heading. Only what `requirePro` is actually called with belongs here.
 */
export type ProFeature = "profiles" | "bulk";

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<ProFeature, string> = {
  profiles: "Saved scan profiles are a Pro feature. " + PRO_TAGLINE,
  bulk: "Bulk actions (trash, dedupe, move, rename) are a Pro feature. " + PRO_TAGLINE,
};
