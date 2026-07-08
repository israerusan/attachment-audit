// Central product metadata and marketing copy. Keeping these in one place keeps
// the license binding, upsell surfaces, and settings copy consistent.

/** Signed into every license payload; a key only unlocks the product it names. */
export const PRODUCT_ID = "attachment-audit";

/** Plugin-owned folder for exported reports; always skipped by scans. */
export const REPORT_FOLDER = "Attachment Audit Reports";

export const PRODUCT_NAME = "Attachment Audit";
export const PRO_NAME = "Attachment Audit Pro";

/** Where "Unlock Pro" sends people. Confirm the real handle before release. */
export const PURCHASE_URL = "https://github.com/israerusan/attachment-audit#pro";

/** Where a happy user can leave a star/review (helps discovery). */
export const REVIEW_URL = "https://github.com/israerusan/attachment-audit";

/** One-time price. Kept in one place so every surface stays consistent. */
export const PRO_PRICE_LABEL = "$9 one-time";

/** One-line positioning statement — the wedge vs. free attachment tools. */
export const POSITIONING_LINE =
  "The Obsidian attachment cleaner safe enough to trust with bulk delete: two-signal unused detection, recoverable trash, and link-safe moves.";

/** One-line pitch for the Pro tier, reused across upsell surfaces. */
export const PRO_TAGLINE =
  "One-click safe bulk cleanup — trash, dedupe, and move across many files at once, links kept intact and everything recoverable. Plus saved profiles, custom rules, and report export. $9 one-time, no subscription, no account.";

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
  profiles: "Saved scan profiles are a Pro feature. " + PRO_TAGLINE,
  rules: "Custom rules are a Pro feature. " + PRO_TAGLINE,
  bulk: "Bulk actions (trash, dedupe, move, rename) are a Pro feature. " + PRO_TAGLINE,
  export: "Report export is a Pro feature. " + PRO_TAGLINE,
  severity: "Severity tuning is a Pro feature. " + PRO_TAGLINE,
};
