import type { CustomRule, CustomRuleCondition, AttachmentStat } from "../../types";
import { isOlderThanDays } from "../utils/dates";
import { checkRegexSafety } from "./regexSafety";
import { isInsideFolder } from "../scan/folderMatch";

/** A custom rule that fired on an attachment: which rule, its weight, and why. */
export interface CustomRuleHit {
  ruleId: string;
  severity: number;
  reason: string;
}

// Folder matching goes through `folderMatch`, the same case-insensitive rule the
// misplaced detector and the exclusion settings use. This file used to carry its
// own exact-prefix copy whose comment claimed it "behaves identically" to the
// misplaced check — it did not: once that check became case-insensitive, a rule
// scoped to `assets` silently never fired for files in `Assets/`, and a rule
// folder typed with a Windows backslash matched nothing at all.

/**
 * True when an attachment falls within a rule's scope. A rule with folders set
 * matches only files inside one of them; an empty scope matches every file.
 */
export function ruleInScope(stat: AttachmentStat, scope: CustomRule["scope"]): boolean {
  const folders = scope.folders ?? [];
  if (folders.length > 0) {
    const inFolder = folders.some((f) => isInsideFolder(stat.path, f));
    if (!inFolder) return false;
  }
  return true;
}

// Compile name-match patterns once; a malformed OR catastrophically-backtracking
// pattern is cached as null so it is skipped without recompiling and can never
// hang the scan. Screening happens here (not only in the settings UI) because a
// rule can also arrive from a hand-edited data.json or an older version.
const patternCache = new Map<string, RegExp | null>();
function compilePattern(pattern: string): RegExp | null {
  if (patternCache.has(pattern)) return patternCache.get(pattern) ?? null;
  let re: RegExp | null = null;
  if (checkRegexSafety(pattern).safe) {
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = null;
    }
  }
  patternCache.set(pattern, re);
  return re;
}

function conditionTrue(stat: AttachmentStat, condition: CustomRuleCondition, now: number): boolean {
  switch (condition.type) {
    case "extension-is":
      return stat.extension === condition.extension.trim().toLowerCase().replace(/^\./, "");
    case "larger-than-kb":
      return stat.size > Math.max(0, condition.kb) * 1024;
    case "in-folder":
      return isInsideFolder(stat.path, condition.folder);
    case "name-matches": {
      const re = compilePattern(condition.pattern);
      // Test the basename (extension stripped), matching the junk-name detector's
      // convention; cap length so a catastrophic-backtracking pattern can't hang.
      // Trimmed as well as capped, matching `matchesJunkName` exactly. Without
      // the trim a basename with a leading space matched `^IMG` through the
      // junk-name detector but not through an identical custom rule.
      return re ? re.test(stat.basename.trim().slice(0, 256)) : false;
    }
    case "older-than-days":
      return isOlderThanDays(stat.mtime, condition.days, now);
  }
}

/**
 * Evaluate one custom rule against an attachment. Returns a hit when the rule is
 * enabled, the file is in scope, and the condition is TRUE. Otherwise `null`.
 * When the rule's `message` is empty, a short reason is synthesized.
 */
export function evaluateRule(
  stat: AttachmentStat,
  rule: CustomRule,
  now: number
): CustomRuleHit | null {
  if (!rule.enabled) return null;
  if (!ruleInScope(stat, rule.scope)) return null;
  if (!conditionTrue(stat, rule.condition, now)) return null;

  const reason = rule.message.trim().length > 0 ? rule.message : synthesizeReason(rule.condition);
  return { ruleId: rule.id, severity: rule.severity, reason };
}

/** Run every rule against an attachment, returning the hits in rule order. */
export function runCustomRules(
  stat: AttachmentStat,
  rules: CustomRule[],
  now: number
): CustomRuleHit[] {
  const hits: CustomRuleHit[] = [];
  for (const rule of rules) {
    const hit = evaluateRule(stat, rule, now);
    if (hit) hits.push(hit);
  }
  return hits;
}

function synthesizeReason(condition: CustomRuleCondition): string {
  switch (condition.type) {
    case "extension-is":
      return `Extension is .${condition.extension}`;
    case "larger-than-kb":
      return `Larger than ${condition.kb} KB`;
    case "in-folder":
      return `In folder "${condition.folder}"`;
    case "name-matches":
      return `Name matches /${condition.pattern}/`;
    case "older-than-days":
      return `Older than ${condition.days} days`;
  }
}
