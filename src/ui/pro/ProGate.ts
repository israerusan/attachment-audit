import type { App } from "obsidian";
import { PRO_UPSELL } from "../../product";
import { ProUpsellModal } from "./ProUpsellModal";

/** Anything carrying the resolved Pro entitlement and an app handle. */
export interface ProHost {
  isPro: boolean;
  app: App;
}

export function isPro(host: ProHost): boolean {
  return host.isPro;
}

/**
 * The one place Pro features are gated. Runs `action` when Pro is active,
 * otherwise opens an actionable upsell for `feature`. Keeping every gate here
 * avoids scattered `if (isPro)` checks drifting out of sync.
 */
export function requirePro(
  host: ProHost,
  feature: keyof typeof PRO_UPSELL,
  action: () => void,
  /** Optional concrete hook shown in the upsell (e.g. the reclaimable total). */
  context?: string
): boolean {
  if (host.isPro) {
    action();
    return true;
  }
  new ProUpsellModal(host.app, feature, context).open();
  return false;
}
