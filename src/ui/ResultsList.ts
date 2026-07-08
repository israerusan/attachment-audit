import { Menu, Notice, setIcon } from "obsidian";
import type AttachmentManagerPlugin from "../main";
import type { IssueType, AttachmentIssue } from "../types";
import { formatBytes } from "../core/utils/sizes";
import { PromptModal } from "./PromptModal";

/** Short badge labels so the type chip doesn't starve the title in the sidebar. */
const BADGE_LABELS: Record<IssueType, string> = {
  unused: "Unused",
  duplicate: "Dup",
  large: "Large",
  unnamed: "Name",
  misplaced: "Moved",
  custom: "Custom",
};

export interface ResultsListOptions {
  bulkMode: boolean;
  selected: Set<string>;
  /** Hide the per-row type badge (redundant when a single type is filtered). */
  showBadge: boolean;
  onSelectionChange: () => void;
  /** Called after an in-place mutation so the header counts can refresh cheaply. */
  onCountsChanged: () => void;
}

interface SeverityTier {
  cls: string;
  label: string;
}

function severityTier(severity: number): SeverityTier {
  if (severity >= 3) return { cls: "is-high", label: "High" };
  if (severity >= 2) return { cls: "is-med", label: "Medium" };
  return { cls: "is-low", label: "Low" };
}

/** How many rows to build up front; the rest load on demand to bound first paint. */
const INITIAL_ROWS = 200;

/**
 * Render an already-sorted list of issues. Each row opens its attachment and
 * exposes mark-reviewed / ignore inline, with reveal + rename + exclude in an
 * overflow menu. Rows load incrementally and mutations update only the affected
 * rows — the whole view is never rebuilt.
 */
export function renderResultsList(
  container: HTMLElement,
  plugin: AttachmentManagerPlugin,
  issues: AttachmentIssue[],
  opts: ResultsListOptions
): void {
  if (issues.length === 0) {
    container.createDiv({ cls: "attachment-audit-empty", text: "No issues here. Nice and tidy." });
    return;
  }

  const list = container.createDiv({ cls: "attachment-audit-results" });
  const footer = container.createDiv({ cls: "attachment-audit-results-footer" });
  const rowsByPath = new Map<string, HTMLElement[]>();
  let shown = 0;

  const renderMore = (): void => {
    const slice = issues.slice(shown, shown + INITIAL_ROWS);
    for (const issue of slice) renderRow(list, plugin, issue, opts, rowsByPath);
    shown += slice.length;

    footer.empty();
    const remaining = issues.length - shown;
    if (remaining > 0) {
      const more = footer.createEl("button", {
        text: `Show ${Math.min(remaining, INITIAL_ROWS)} more (${remaining} left)`,
      });
      more.addEventListener("click", renderMore);
    }
  };

  renderMore();
}

function renderRow(
  list: HTMLElement,
  plugin: AttachmentManagerPlugin,
  issue: AttachmentIssue,
  opts: ResultsListOptions,
  rowsByPath: Map<string, HTMLElement[]>
): void {
  const row = list.createDiv({ cls: "attachment-audit-row" });
  if (plugin.isReviewed(issue)) row.addClass("is-reviewed");
  const bucket = rowsByPath.get(issue.attachmentPath) ?? [];
  bucket.push(row);
  rowsByPath.set(issue.attachmentPath, bucket);

  if (opts.bulkMode) {
    const check = row.createEl("input", { type: "checkbox", cls: "attachment-audit-check" });
    check.checked = opts.selected.has(issue.id);
    check.setAttribute("aria-label", `Select ${issue.attachmentName}`);
    check.addEventListener("change", () => {
      if (check.checked) opts.selected.add(issue.id);
      else opts.selected.delete(issue.id);
      opts.onSelectionChange();
    });
  }

  const tier = severityTier(issue.severity);
  const tierEl = row.createSpan({ cls: `attachment-audit-sev ${tier.cls}`, text: tier.label[0] });
  tierEl.setAttribute("aria-label", `${tier.label} severity`);

  if (opts.showBadge) {
    row.createSpan({
      cls: `attachment-audit-badge is-${issue.issueType}`,
      text: BADGE_LABELS[issue.issueType],
    });
  }

  const main = row.createDiv({ cls: "attachment-audit-row-main" });
  const title = main.createEl("button", { cls: "attachment-audit-row-title", text: issue.attachmentName });
  title.setAttribute("aria-label", issue.attachmentPath);
  title.addEventListener("click", () => void plugin.openAttachment(issue.attachmentPath));
  const slash = issue.attachmentPath.lastIndexOf("/");
  if (slash > 0) {
    main.createDiv({ cls: "attachment-audit-row-folder", text: issue.attachmentPath.slice(0, slash) });
  }
  const reason = `${issue.reason} · ${formatBytes(issue.sizeBytes)}`;
  const reasonEl = main.createDiv({ cls: "attachment-audit-row-reason", text: reason });
  reasonEl.setAttribute("aria-label", issue.details ?? reason);

  const actions = row.createDiv({ cls: "attachment-audit-row-actions" });
  iconButton(actions, "check", "Mark reviewed", () => {
    void plugin.setReviewed(issue, true).then(() => {
      row.remove();
      opts.onCountsChanged();
      // Match Ignore's undo affordance so an accidental review is recoverable.
      const frag = createFragment((f) => {
        f.appendText(`Marked "${issue.attachmentName}" reviewed. `);
        const undo = f.createEl("button", { text: "Undo", cls: "attachment-audit-inline-link" });
        undo.addEventListener("click", () => {
          void plugin.setReviewed(issue, false).then(() => plugin.refreshViews());
        });
      });
      new Notice(frag, 6000);
    });
  });

  // The value action, inline (not buried in the overflow menu): reclaim space in
  // one click on an unused file — the free "aha" moment.
  if (issue.issueType === "unused") {
    const trashBtn = iconButton(
      actions,
      "trash-2",
      `Trash file — free ${formatBytes(issue.sizeBytes)}`,
      () => {
        plugin.confirmDestructive(
          "Trash unused attachment",
          `No note links to or mentions "${issue.attachmentName}", so removing it won't break anything. ` +
            `Move it to trash, freeing ${formatBytes(issue.sizeBytes)}? ${plugin.trashDestinationNote()}`,
          "Trash file",
          () =>
            void plugin.bulkTrashUnused([issue], true).then((c) => {
              // Trashing an unused file changes nothing else — drop it from the
              // results instantly instead of a full-vault rescan.
              if (c.length) plugin.handleTrashed(c);
            })
        );
      }
    );
    trashBtn.addClass("is-danger");
  }

  const ignoreBtn = iconButton(actions, "eye-off", "Ignore this result", () => {
    void plugin.setIgnored(issue, true).then(() => {
      row.remove();
      opts.onCountsChanged();
      const frag = createFragment((f) => {
        f.appendText(`Ignored "${issue.attachmentName}". `);
        const undo = f.createEl("button", { text: "Undo", cls: "attachment-audit-inline-link" });
        undo.addEventListener("click", () => {
          void plugin.setIgnored(issue, false).then(() => plugin.refreshViews());
        });
      });
      new Notice(frag, 6000);
    });
  });
  ignoreBtn.addClass("is-danger");

  iconButton(actions, "more-horizontal", "More actions", (evt) => {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Reveal in file explorer")
        .setIcon("folder-open")
        .onClick(() => void plugin.revealAttachment(issue.attachmentPath))
    );
    menu.addItem((item) =>
      item
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(() => {
          const { name, path } = { name: issue.attachmentName, path: issue.attachmentPath };
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 ? name.slice(0, dot) : name;
          new PromptModal(
            plugin.app,
            `Rename "${name}"`,
            [{ key: "name", label: "New name (without extension)", placeholder: stem }],
            (v) => {
              const next = v.name.trim();
              if (!next) return;
              void plugin.renameAttachment(path, next).then((newPath) => {
                if (newPath) void plugin.settleCacheThenRescan([newPath]);
              });
            }
          ).open();
        })
    );
    // Free single-file cleanup: move any file; trash only two-signal-unused files.
    if (plugin.settings.attachmentFolder.trim()) {
      menu.addItem((item) =>
        item
          .setTitle("Move to attachment folder")
          .setIcon("folder-input")
          .onClick(() => {
            plugin.confirmDestructive(
              "Move to attachment folder",
              `Move "${issue.attachmentName}" into "${plugin.settings.attachmentFolder.trim()}"? ` +
                "Markdown, wikilink, and canvas links are updated; raw HTML <img src> and frontmatter path strings are not.",
              "Move file",
              () =>
                void plugin.bulkMoveToAttachmentFolder([issue]).then((c) => {
                  if (c.length) void plugin.settleCacheThenRescan(c);
                })
            );
          })
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Exclude from future scans")
        .setIcon("ban")
        .onClick(() => {
          void plugin.excludeAttachment(issue.attachmentPath).then(() => {
            for (const r of rowsByPath.get(issue.attachmentPath) ?? []) r.remove();
            opts.onCountsChanged();
          });
        })
    );
    menu.showAtMouseEvent(evt);
  });
}

function iconButton(
  parent: HTMLElement,
  icon: string,
  tooltip: string,
  onClick?: (evt: MouseEvent) => void
): HTMLButtonElement {
  const btn = parent.createEl("button", { cls: "attachment-audit-icon-btn clickable-icon" });
  setIcon(btn, icon);
  if (tooltip) btn.setAttribute("aria-label", tooltip);
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}
