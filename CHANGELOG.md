# Changelog

All notable changes to the **Hotspot — Bug Hotspot Predictor** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] — Unreleased

### Added

- **Ownership-fragmentation signal** — the risk score now accounts for how concentrated a
  file's authorship is (`1 − the top author's commit share`). Code spread across many
  low-share contributors (weak ownership) raises risk (Bird et al., 2011).
- **Change-coupling signal** — detects files that historically change together
  (`shared commits / max(revisions)`); a file's strongest hidden co-change dependency now
  feeds the score.
- **`Hotspot: Show Coupled Files`** — a Quick Pick of a file's co-change partners
  ("you probably also need to edit X"), from the Command Palette and the editor context menu.
- **`Hotspot: Show Top Hotspots`** — a Quick Pick jump-list of the riskiest files; the
  status-bar item now opens it on click (was: trigger a rescan).
- Setting `hotspot.topHotspotsCount` — how many files Show Top Hotspots lists (default 20).

### Changed

- Risk score rebalanced to five process signals — change frequency, code churn, author
  spread, ownership fragmentation, and change coupling — shaped by the complexity
  multiplier and bug-fix density booster.

### Fixed

- Extension-discovery integration tests now resolve the extension by manifest name, fixing
  failures introduced by the `thomasarisu` publisher rename.

## [0.0.2] — 2026-06-26

### Changed

- New extension icon.

## [0.0.1] — 2026-06-26

Initial release.

### Added

- **Analysis core** (pure TypeScript, no editor dependencies):
  - Git churn reader — one streamed `git log --numstat` pass aggregated into per-file
    change history (commits, lines added/deleted, distinct authors, first/last seen),
    with rename awareness.
  - Indentation-proxy complexity metric (language-agnostic, no parser).
  - Bug-fix commit classifier (keyword + issue-reference heuristic) and per-file
    bug-fix density.
  - Risk scorer — log-dampened, min–max normalized signals combined into a relative
    0–100 score with low / medium / high / critical tiers.
- **Editor integration:**
  - `Hotspot: Scan Workspace` command.
  - Explorer file decorations colored by risk tier.
  - Status-bar item showing the active file's score and tier.
  - "Risk Report" activity-bar panel listing the riskiest files; click to open.
- Activation only in git workspaces (`workspaceContains:.git`).
- 100% local and offline — no account, no network, no telemetry.

[0.0.3]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/releases/tag/v0.0.2
[0.0.1]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/releases/tag/v0.0.1
