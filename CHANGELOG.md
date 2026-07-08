# Changelog

All notable changes to Attachment Audit are documented here. This project adheres to [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-06

Initial release.

### Added
- Attachment scan with five detectors: unused, duplicates, large files, poorly named, and misplaced.
- Two-signal unused detection (resolved links + raw-content mention scan across notes, frontmatter, and canvas files) to avoid false positives.
- Duplicate detection via size-bucketed SHA-256 hashing.
- Dashboard with a reclaimable-space total, per-type tiles, and a one-at-a-time review queue.
- Free per-attachment actions: open, reveal, link-safe rename, ignore, exclude, mark reviewed.
- Pro ($9 one-time): safe bulk actions (trash unused, trash duplicate copies, move to attachment folder), saved scan profiles, custom rules, severity tuning, and Markdown report export.
- Offline Ed25519 license verification (no account, no server).
