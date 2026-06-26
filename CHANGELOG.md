# Changelog

All notable changes to the **Hotspot — Bug Hotspot Predictor** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.1]: https://example.com/hotspot/releases/0.0.1
