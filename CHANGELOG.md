# Changelog

All notable changes to the **Hotspot — Bug Hotspot Predictor** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] — 2026-06-28

### Added

- **Recency signal (time-decay)** — the risk score now includes a sixth process signal:
  recently-changed files rank higher. Each commit touching a file contributes
  `0.5 ^ (ageDays / 365)` (a 365-day half-life), measured from the newest commit in the
  history walk — so a file's risk cools off as its changes age.
- **Trend badge** — each file in the Risk Report shows a trend arrow (↑ rising / → stable /
  ↓ cooling) derived from the share of its commits in the last 90 days. Display-only — it
  never affects the score.
- **Low-confidence note** — when the git history is too thin to rank reliably (fewer than 5
  scored files, or a top score under 15), the Risk Report and status bar now say so instead
  of implying a confident ranking.
- **Generated-file exclude globs** — `hotspot.exclude` keeps generated, vendored, and
  lockfile paths (e.g. `dist/`, `node_modules/`, `*.min.js`, `package-lock.json`) out of the
  ranking and out of coupling partners. Defaults to a sensible list; set to `[]` to disable.
- **Per-region risk CodeLens** — an inline `⚠ Risk: <severity> · depth N · M lines` CodeLens
  appears above risky code blocks, gated by `hotspot.codeRiskMinSeverity`. Toggle with
  `hotspot.codeLensEnabled` (default `true`).
- **Configurable scoring** — `hotspot.weights` (per-signal weights), `hotspot.thresholds`
  (tier cutoffs), and `hotspot.sinceMonths` (limit history to the last N months, 0 = all).
  Invalid or missing keys fall back to the built-in defaults; changes trigger a debounced
  rescan.
- **`Hotspot: Export Risk Report`** — export the current ranking as Markdown or JSON into a
  new editor, for sharing or tracking risk over time.

### Changed

- The risk model now includes a recency signal and rebalanced weights, so file rankings
  shift versus 0.0.3 — this is an accuracy improvement, not a regression. The additive core
  is now six signals: `freq .22 / churn .18 / recency .20 / authors .10 / ownership .15 /
  coupling .15` (sum 1.0), still shaped by the complexity multiplier and bug-fix density
  booster.

### Notes

- The churn cache format bumps from v3 to v4 (per-file records gain `recencyWeight` +
  `recentCommits`). Old caches are invalidated automatically, so the first scan after
  upgrading does one cold rescan.

## [0.0.3] — 2026-06-27

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
- **Code-level risk highlights** — risky code *regions* (deeply-nested / long blocks) are now
  marked in the editor with a gutter icon, a faint tint, and a hover that explains why — for
  files of any tier, not just critical ones. Tunable via `hotspot.codeRiskEnabled` and
  `hotspot.codeRiskMinSeverity`.

### Changed

- Risk score rebalanced to five process signals — change frequency, code churn, author
  spread, ownership fragmentation, and change coupling — shaped by the complexity
  multiplier and bug-fix density booster.
- **Show Top Hotspots** now lists all five signals (including ownership + coupling) plus a
  plain-language reason per file — matching the Risk Report panel — and reliably opens the
  selected file (with a clear message if it has moved or been deleted).

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

[0.0.4]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/releases/tag/v0.0.2
[0.0.1]: https://github.com/SaidislomSaidazimovv/bugHotspotExtension/releases/tag/v0.0.1
