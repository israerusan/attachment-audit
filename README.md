# Attachment Audit

**Safe attachment cleanup with evidence, not guesswork.**

Attachment Audit scans your vault for truly unused attachments, duplicates, oversized files, junk-named pastes, and misplaced files — then shows exactly what is reclaimable before you touch anything.

<!-- SCREENSHOT SLOT — drop a real Obsidian capture here to lift conversions.
     ![Attachment Audit dashboard: reclaimable-space total with files grouped by detector](docs/assets/hero.png)
     Suggested shot: the dashboard showing the reclaimable-space total and a few flagged files (unused / duplicate / large). Save as docs/assets/hero.png -->


Free lets you scan and clean one file at a time. Pro unlocks bulk cleanup, saved scan profiles, custom rules, severity tuning, and Markdown reports.

> Built for the moment when "I think these files are junk" is not good enough and you want evidence before you start deleting.

## Why Attachment Audit exists

Most attachment tools optimize for naming or filing. Useful, sure. But that is not the scary part.

The scary part is cleanup:
- which files are truly unused
- which ones are duplicated waste
- which giant files are eating your vault alive
- which ones can be moved or trashed safely

Attachment Audit exists to make that decision with evidence instead of vibes.

## What it finds

- **Unused** — attachments no note truly references
- **Duplicates** — byte-identical copies grouped with SHA-256
- **Large files** — oversized attachments worth reviewing first
- **Poorly named** — junk like `Pasted image...`, `Screenshot...`, `IMG_1234`, or `Untitled`
- **Misplaced** — attachments living outside your chosen attachment folder

## Why it is safer than a generic orphan finder

Attachment Audit does not flag an attachment as unused from resolved Markdown links alone.

It cross-checks two independent signals:
- resolved links
- a raw-content mention scan across note bodies, frontmatter, and canvas files

That means a file referenced only in canvas, frontmatter, or raw HTML is far less likely to be misclassified as trash.

It also keeps cleanup sane:
- nothing is hard-deleted
- moves and renames preserve links
- duplicate cleanup never trashes every copy
- destructive actions re-validate before acting

## Free vs Pro

Free proves value. Pro is for doing cleanup at scale.

| Feature | Free | Pro |
| --- | :---: | :---: |
| All five detectors | ✓ | ✓ |
| Dashboard with reclaimable-space total | ✓ | ✓ |
| One-file-at-a-time cleanup | ✓ | ✓ |
| Open / reveal / rename / ignore / exclude / mark reviewed | ✓ | ✓ |
| Per-detector thresholds and exclusions | ✓ | ✓ |
| Bulk cleanup across many files |  | ✓ |
| Saved scan profiles |  | ✓ |
| Custom rules |  | ✓ |
| Severity tuning |  | ✓ |
| Markdown report export |  | ✓ |

Purchase: [Buy Me a Coffee — Attachment Audit Pro](https://buymeacoffee.com/vaultspotlight/e/560207). License keys are verified **offline** (Ed25519) — no account, server, or subscription.

**Activate Pro**

1. Purchase via [Buy Me a Coffee — Attachment Audit Pro](https://buymeacoffee.com/vaultspotlight/e/560207).
2. Your license key is emailed to you **automatically, within seconds** — delivery is fully automated, no waiting.
3. Paste it into the plugin's settings — Pro unlocks instantly, verified offline.

## Install

**Community plugins**

Open **Settings → Community plugins**, search **Attachment Audit**, and install it — one click, auto-updates.

**Manual install**

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/attachment-audit/` in your vault, then enable the plugin.

## Getting started

1. Run **Attachment Audit: Run attachment scan** from the command palette.
2. Optionally set an attachment folder to enable misplaced-file checks and one-click moves.
3. Review the reclaimable-space summary and work through the flagged files.

## Safety

Attachment Audit touches files, so safety is the whole business model:

- trash respects your Obsidian deleted-files setting
- "unused" requires two signals to agree
- duplicate cleanup keeps at least one copy and avoids referenced files
- moves and renames use Obsidian's link-updating rename flow
- every destructive action confirms and re-checks before acting

## Pro

Attachment Audit Pro uses an offline license key.

- one-time payment
- no account required
- no always-online checks
- validated locally in your vault

Pro is for people who want to reclaim space in batches instead of babysitting one file at a time.

## Buy Pro

Attachment Audit Pro uses an offline license key and a one-time payment.

**Buy Attachment Audit Pro — $9 one-time:** https://buymeacoffee.com/vaultspotlight/e/560207

What you get:
- bulk cleanup across many files
- saved scan profiles
- custom rules
- severity tuning
- Markdown report export

Delivery model:
- one-time purchase
- no account required
- offline license verification
- license key delivered automatically by email, in seconds

## Privacy

Everything runs locally in your vault.

- no network calls
- no telemetry
- no account
- offline license validation

## Pricing

- **Free** — full audit plus one-file-at-a-time cleanup
- **Pro — $9 one-time** — bulk cleanup, saved profiles, custom rules, severity tuning, and Markdown report export

## FAQ

**Why not just use a free orphan finder?**
Because "lists possible orphans" and "safe enough to bulk-delete" are not the same thing.

**Does Pro require an account?**
No. Pro uses a one-time offline license key.

**Does Attachment Audit upload my files anywhere?**
No. It runs locally in your vault.

## Support

Open an issue at [github.com/israerusan/attachment-audit](https://github.com/israerusan/attachment-audit/issues).
