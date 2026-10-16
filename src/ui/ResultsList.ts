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
  missing: "Broken",
  custom: "Custom",
};

/** Extensions we will render as an inline preview. Everything else gets an icon. */
const PREVIEWABLE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"]);

/**
 * Files above this size get an icon instead of a preview. An `<img>` decodes at
 * full resolution regardless of its CSS box, so a 40 MB TIFF-sized PNG would cost
 * hundreds of megabytes of bitmap for a 32px thumbnail.
 */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

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

/**
 * How many rows to build up front; the rest load on demand to bound first paint.
 * Deliberately small: each row carries focusable controls, so 200 rows put ~600
 * tab stops between the top of the list and the "show more" button, and 200 rows
 * of a ~300px pane is ~11,000px of scroll nobody reads.
 */
const INITIAL_ROWS = 50;

/**
 * How many members of one duplicate cluster to build up front. Same reasoning as
 * {@link INITIAL_ROWS}, applied inside a cluster — which previously had no bound
 * at all, so a single cluster of identical copies could render thousands of rows
 * on first paint however small the page budget was.
 */
const CLUSTER_ROWS = 12;

/** Either a standalone issue or a group of byte-identical copies. */
type ListEntry = AttachmentIssue | AttachmentIssue[];

/**
 * Group duplicate issues by their content hash, keeping every other issue where
 * it is. Duplicates are the one type where a row means nothing on its own — five
 * identical copies rendered as five independent rows (often with the SAME
 * filename in different folders) gives the user no way to see what "keep one copy"
 * is going to keep. The group takes the list position of its first member so the
 * caller's sort order is preserved.
 */
function groupDuplicateClusters(issues: AttachmentIssue[]): ListEntry[] {
  const out: ListEntry[] = [];
  const byCluster = new Map<string, AttachmentIssue[]>();
  for (const issue of issues) {
    if (issue.issueType !== "duplicate" || !issue.clusterId) {
      out.push(issue);
      continue;
    }
    const existing = byCluster.get(issue.clusterId);
    if (existing) {
      existing.push(issue);
      continue;
    }
    const fresh = [issue];
    byCluster.set(issue.clusterId, fresh);
    out.push(fresh);
  }
  return out;
}

/**
 * Render an already-sorted list of issues. Each row opens its attachment and
 * exposes its most valuable action inline, with everything else in an overflow
 * menu. Rows load incrementally and mutations update only the affected rows —
 * the whole view is never rebuilt.
 */
export function renderResultsList(
  container: HTMLElement,
  plugin: AttachmentManagerPlugin,
  issues: AttachmentIssue[],
  opts: ResultsListOptions
): void {
  if (issues.length === 0) {
    renderEmptyState(container, plugin, opts);
    return;
  }

  const entries = groupDuplicateClusters(issues);
  const list = container.createDiv({ cls: "attachment-audit-results" });
  const footer = container.createDiv({ cls: "attachment-audit-results-footer" });
  const rowsByPath = new Map<string, HTMLElement[]>();
  let shown = 0;

  const renderMore = (): void => {
    // Build off-tree and append once: rows carry ~4 setIcon() SVG injections each,
    // and inserting them one at a time into a live tree forces repeated layout.
    const frag = createFragment();
    // Page by ROWS, not by entries — a single cluster can hold hundreds of copies,
    // which would render in one go and defeat the first-paint bound entirely.
    let rowsThisPage = 0;
    while (shown < entries.length && rowsThisPage < INITIAL_ROWS) {
      const entry = entries[shown];
      if (Array.isArray(entry)) {
        renderCluster(frag, plugin, entry, opts, rowsByPath);
        // Only the rows actually built count toward the page budget; the rest of
        // the cluster is behind its own "show more".
        rowsThisPage += Math.min(entry.length, CLUSTER_ROWS);
      } else {
        renderRow(frag, plugin, entry, opts, rowsByPath);
        rowsThisPage++;
      }
      shown++;
    }
    list.appendChild(frag);

    footer.empty();
    const remaining = entries.length - shown;
    if (remaining > 0) {
      const more = footer.createEl("button", {
        text: `Show more · ${remaining} left`,
      });
      more.addEventListener("click", renderMore);
    }
  };

  renderMore();
}

/**
 * The empty state has two very different meanings — a genuinely clean vault, and
 * a filter with nothing in it. The second needs a way out.
 */
function renderEmptyState(
  container: HTMLElement,
  plugin: AttachmentManagerPlugin,
  opts: ResultsListOptions
): void {
  const empty = container.createDiv({ cls: "attachment-audit-empty" });
  setIcon(empty.createDiv({ cls: "attachment-audit-empty-icon" }), "check-circle");
  empty.createDiv({
    cls: "attachment-audit-empty-title",
    text: "Nothing flagged here",
  });
  empty.createDiv({
    cls: "attachment-audit-empty-hint",
    text: opts.showBadge
      ? "Your attachments are tidy — nothing needs attention."
      : "No results of this type. Other categories may still have some.",
  });
  if (!opts.showBadge) {
    const clear = empty.createEl("button", { text: "Show all results" });
    clear.addEventListener("click", () => plugin.clearDashboardFilter());
  }
}

function renderCluster(
  parent: ParentNode,
  plugin: AttachmentManagerPlugin,
  group: AttachmentIssue[],
  opts: ResultsListOptions,
  rowsByPath: Map<string, HTMLElement[]>
): void {
  // A single-member "cluster" is just a row.
  if (group.length === 1) {
    renderRow(parent, plugin, group[0], opts, rowsByPath);
    return;
  }

  const wrap = createDiv({ cls: "attachment-audit-cluster" });
  const head = wrap.createDiv({ cls: "attachment-audit-cluster-head" });
  // Everything past the first copy is the recoverable waste.
  const wasted = group.slice(1).reduce((n, i) => n + i.sizeBytes, 0);
  head.createSpan({
    cls: "attachment-audit-cluster-title",
    text: `${group.length} identical copies`,
  });
  head.createSpan({
    cls: "attachment-audit-cluster-waste",
    text: `${formatBytes(wasted)} wasted`,
  });
  // Members are PAGED like the top-level list, not rendered all at once.
  //
  // The outer loop pages by rows and counts `entry.length` toward the budget, but
  // it counts it AFTER this function has already built every row, so the budget
  // could not bound a cluster. One `cp -r` of a photo library produces a single
  // cluster of thousands of byte-identical copies, and that cluster alone put
  // thousands of rows — each with four `setIcon` SVGs and several tab stops — into
  // the DOM on first paint, inside a ~300px sidebar.
  const body = wrap.createDiv({ cls: "attachment-audit-cluster-body" });
  const more = wrap.createDiv({ cls: "attachment-audit-cluster-more" });
  let drawn = 0;
  const drawMembers = (): void => {
    const frag = createFragment();
    const until = Math.min(group.length, drawn + CLUSTER_ROWS);
    for (; drawn < until; drawn++) renderRow(frag, plugin, group[drawn], opts, rowsByPath);
    body.appendChild(frag);
    more.empty();
    const left = group.length - drawn;
    if (left > 0) {
      const button = more.createEl("button", { text: `Show ${left} more ${plural(left, "copy")}` });
      button.addEventListener("click", drawMembers);
    }
  };
  drawMembers();
  parent.appendChild(wrap);
}

/** English plural for the cluster's "show more" button. */
function plural(n: number, word: string): string {
  if (n === 1) return word;
  return word === "copy" ? "copies" : `${word}s`;
}

function renderRow(
  parent: ParentNode,
  plugin: AttachmentManagerPlugin,
  issue: AttachmentIssue,
  opts: ResultsListOptions,
  rowsByPath: Map<string, HTMLElement[]>
): void {
  const row = createDiv({ cls: "attachment-audit-row" });
  parent.appendChild(row);
  if (plugin.isReviewed(issue)) row.addClass("is-reviewed");
  const bucket = rowsByPath.get(issue.attachmentPath) ?? [];
  bucket.push(row);
  rowsByPath.set(issue.attachmentPath, bucket);

  const tier = severityTier(issue.severity);
  // A full-height 3px rail rather than a 25px lettered chip: in a ~300px sidebar
  // that chip cost a tenth of the row's width, and the severity WORD now appears
  // in the meta line, so the tier never depends on colour alone.
  const rail = row.createDiv({ cls: `attachment-audit-sev ${tier.cls}` });
  rail.setAttribute("aria-hidden", "true");

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

  renderThumb(row, plugin, issue);

  const main = row.createDiv({ cls: "attachment-audit-row-main" });
  const titleRow = main.createDiv({ cls: "attachment-audit-row-titlerow" });
  const title = titleRow.createEl("button", {
    cls: "attachment-audit-row-title",
    text: issue.attachmentName,
  });
  // `title`, NOT aria-label: aria-label REPLACES the accessible name, so the
  // button announced as its folder path and voice control could not match the
  // visible filename (WCAG 2.5.3). The tooltip is also what sighted users need,
  // since the name is ellipsized.
  // A "missing" issue names a file that does not exist, so there is nothing to
  // open — take the user to the note carrying the broken link instead, which is
  // where the fix actually happens.
  const firstSource = issue.referencedBy?.[0];
  title.title = issue.exists === false && firstSource
    ? `Missing: ${issue.attachmentPath} — open ${firstSource}`
    : issue.attachmentPath;
  title.addEventListener("click", () => {
    if (issue.exists === false) {
      if (firstSource) void plugin.openAttachment(firstSource);
      return;
    }
    void plugin.openAttachment(issue.attachmentPath);
  });

  if (opts.showBadge) {
    titleRow.createSpan({
      cls: `attachment-audit-badge is-${issue.issueType}`,
      text: BADGE_LABELS[issue.issueType],
    });
  }

  // One meta line instead of three stacked ones at three different sizes. The
  // severity word lives here so the colour rail is never the only signal.
  const meta = main.createDiv({ cls: "attachment-audit-row-meta" });
  meta.createSpan({ cls: `attachment-audit-sev-word ${tier.cls}`, text: tier.label });
  const size = issue.sizeBytes > 0 ? ` · ${formatBytes(issue.sizeBytes)}` : "";
  meta.createSpan({ text: ` · ${issue.reason}${size}` });
  const slash = issue.attachmentPath.lastIndexOf("/");
  if (slash > 0) {
    meta.createSpan({
      cls: "attachment-audit-row-folder",
      text: ` · ${issue.attachmentPath.slice(0, slash)}`,
    });
  }
  // `details` is the fuller explanation; a div's aria-label is ignored, a title is not.
  if (issue.details) meta.title = issue.details;

  const actions = row.createDiv({ cls: "attachment-audit-row-actions" });

  // ONE primary action, chosen by issue type — the rest go in the overflow menu.
  // Four always-visible buttons ate ~94px of a ~260px row, and two of them were
  // styled with the same danger red, which trains the user to ignore the red.
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
            }),
          [issue.attachmentPath]
        );
      }
    );
    trashBtn.addClass("is-danger");
  } else {
    iconButton(actions, "check", "Mark reviewed", () => markReviewed(plugin, issue, row, opts));
  }

  iconButton(actions, "more-horizontal", "More actions", (evt) => {
    const menu = new Menu();
    if (issue.issueType === "unused") {
      menu.addItem((item) =>
        item
          .setTitle("Mark reviewed")
          .setIcon("check")
          .onClick(() => markReviewed(plugin, issue, row, opts))
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Ignore this result")
        .setIcon("eye-off")
        .onClick(() => {
          void plugin.setIgnored(issue, true).then(() => {
            row.remove();
            opts.onCountsChanged();
            notifyUndo(`Ignored "${issue.attachmentName}".`, () => {
              void plugin.setIgnored(issue, false).then(() => plugin.refreshViews());
            });
          });
        })
    );
    // Reveal / rename / move all operate on a file that must exist. A "missing"
    // issue names a link with no file behind it, so offering them would present
    // actions that can only ever silently no-op.
    const fileExists = issue.exists !== false;
    if (fileExists) {
      menu.addItem((item) =>
        item
          .setTitle("Reveal in file explorer")
          .setIcon("folder-open")
          .onClick(() => void plugin.revealAttachment(issue.attachmentPath))
      );
    }
    if (issue.referencedBy && issue.referencedBy.length > 0) {
      // The useful action for a broken link: go to a note that still points at it.
      for (const source of issue.referencedBy.slice(0, 5)) {
        menu.addItem((item) =>
          item
            .setTitle(`Open ${source}`)
            .setIcon("file-search")
            .onClick(() => void plugin.openAttachment(source))
        );
      }
    }
    if (fileExists) {
      menu.addItem((item) =>
        item
          .setTitle("Rename…")
          .setIcon("pencil")
          .onClick(() => {
            const name = issue.attachmentName;
            const path = issue.attachmentPath;
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
    }
    // Free single-file cleanup: move any file; trash only two-signal-unused files.
    if (fileExists && plugin.settings.attachmentFolder.trim()) {
      menu.addItem((item) =>
        item
          .setTitle("Move to attachment folder")
          .setIcon("folder-input")
          .onClick(() => {
            plugin.confirmDestructive(
              "Move to attachment folder",
              plugin.describeMoveAction(1),
              "Move file",
              () =>
                void plugin.bulkMoveToAttachmentFolder([issue]).then((c) => {
                  if (c.length) void plugin.settleCacheThenRescan(c);
                }),
              [issue.attachmentPath]
            );
          })
      );
    }
    // Exclusion works on FILE paths. A "missing" issue's path is link text with no
    // file behind it, and the scan applies exclusions to the source note instead —
    // so offering this would hide the row now and bring the broken link straight
    // back on the next scan. Ignore (above) is the action that actually sticks.
    if (fileExists) {
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
    }
    menu.showAtMouseEvent(evt);
  });
}

function markReviewed(
  plugin: AttachmentManagerPlugin,
  issue: AttachmentIssue,
  row: HTMLElement,
  opts: ResultsListOptions
): void {
  void plugin.setReviewed(issue, true).then(() => {
    row.remove();
    opts.onCountsChanged();
    notifyUndo(`Marked "${issue.attachmentName}" reviewed.`, () => {
      void plugin.setReviewed(issue, false).then(() => plugin.refreshViews());
    });
  });
}

/** A Notice with an inline, keyboard-operable Undo button. */
function notifyUndo(text: string, onUndo: () => void): void {
  const frag = createFragment((f) => {
    f.appendText(`${text} `);
    const undo = f.createEl("button", { text: "Undo", cls: "attachment-audit-inline-link" });
    undo.addEventListener("click", onUndo);
  });
  new Notice(frag, 6000);
}

/**
 * A small inline preview. The `unnamed` detector exists precisely because names
 * like `Pasted image 20260101.png` carry no information — and then the UI asks the
 * user to make an irreversible decision based on that name. A thumbnail answers
 * "which one is this?" at a glance.
 */
function renderThumb(
  row: HTMLElement,
  plugin: AttachmentManagerPlugin,
  issue: AttachmentIssue
): void {
  if (!plugin.settings.showThumbnails) return;
  if (issue.exists === false) {
    const ph = row.createDiv({ cls: "attachment-audit-thumb is-missing" });
    ph.setAttribute("aria-hidden", "true");
    setIcon(ph, "unlink");
    return;
  }
  const ext = issue.attachmentPath.slice(issue.attachmentPath.lastIndexOf(".") + 1).toLowerCase();
  const file = plugin.app.vault.getFileByPath(issue.attachmentPath);

  if (file && PREVIEWABLE.has(ext) && issue.sizeBytes <= PREVIEW_MAX_BYTES) {
    const img = row.createEl("img", { cls: "attachment-audit-thumb" });
    img.src = plugin.app.vault.getResourcePath(file);
    img.loading = "lazy";
    img.alt = ""; // decorative — the filename beside it is the real label
    // A corrupt or unreadable image would otherwise leave a broken-image glyph.
    img.addEventListener("error", () => {
      img.remove();
      placeholderThumb(row, ext);
    });
    return;
  }
  placeholderThumb(row, ext);
}

function placeholderThumb(row: HTMLElement, ext: string): void {
  const ph = row.createDiv({ cls: "attachment-audit-thumb is-file" });
  ph.setAttribute("aria-hidden", "true");
  setIcon(ph, iconForExtension(ext));
}

function iconForExtension(ext: string): string {
  if (PREVIEWABLE.has(ext)) return "image";
  if (ext === "pdf") return "file-text";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "file-audio";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "file-video";
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return "file-archive";
  return "file";
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
