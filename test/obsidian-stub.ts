// Minimal stand-in for the `obsidian` module so any test that transitively
// imports it can be bundled and executed under Node. The core (detectors, rule
// engine, severity, reports) is pure and does not import `obsidian`; this exists
// only as a safety net for the esbuild alias.
export const apiVersion = "1.5.0";

/** Minimal stand-in so modules that import `normalizePath` bundle under Node.
 *  (Only the pure `resolveScanConfig` path is exercised in tests; it doesn't
 *  actually call this — the export just needs to exist for the import to resolve.) */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

// --- Class stand-ins so `src/main.ts` itself can be bundled -----------------
// The plugin's destructive loops (trash, move, restore) live in main.ts, which
// extends `Plugin` and imports UI classes at module scope. These empty shells let
// a test build the real module and drive its methods against a fake vault;
// nothing here implements Obsidian behaviour.
export class App {}
export class Component {}
export class Plugin {}
export class ItemView {}
export class Modal {}
export class FuzzySuggestModal {}
export class PluginSettingTab {}
export class Setting {}
export class Menu {}
export class WorkspaceLeaf {}
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export const Platform = { isMobile: false, isDesktopApp: true };
export function setIcon(): void {}

/** Every Notice message shown, so tests can assert on what the user was told. */
export const notices: string[] = [];
export class Notice {
  constructor(message: unknown) {
    notices.push(typeof message === "string" ? message : "[fragment]");
  }
}
