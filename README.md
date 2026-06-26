# Hotspot — Bug Hotspot Predictor

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/thomasarisu.hotspot?label=Marketplace&color=0d1117)](https://marketplace.visualstudio.com/items?itemName=thomasarisu.hotspot)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/thomasarisu.hotspot)](https://marketplace.visualstudio.com/items?itemName=thomasarisu.hotspot)
[![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/thomasarisu.hotspot)](https://marketplace.visualstudio.com/items?itemName=thomasarisu.hotspot&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**CodeScene-style churn × complexity bug-risk prediction — but free, 100% offline, and shown inline where you code.**

Hotspot ranks the files in your repository by how **bug-prone** they are, fusing five evidence-backed history signals — change frequency, code churn, author spread, **code ownership**, and **change coupling** — shaped by code complexity and bug-fix history into a single 0–100 risk score, surfaced right in the editor.

> ### "Bug hotspot" ≠ "security hotspot"
> Hotspot flags files that are *statistically likely to contain defects*, based on how they have changed over time. It is **not** a security scanner — it does **not** identify security-sensitive code the way SonarLint's "security hotspots" do.

---

## Demo

![Hotspot scanning a repository and ranking its riskiest files](media/demo.gif)

| Risk Report panel | Show Coupled Files |
| :---: | :---: |
| ![Risk Report panel listing the riskiest files](media/risk-report.png) | ![Show Coupled Files quick pick](media/coupled-files.png) |

> The GIF and screenshots above are captured by a maintainer — see [`media/ASSETS.md`](media/ASSETS.md) for the exact shot list.

---

## Why it exists

Decades of defect-prediction research (Rahman & Devanbu, ICSE 2013) found that **how code changes** predicts bugs better than **what the code looks like** statically. Adam Tornhill's hotspot model sharpens this: a file is dangerous only when it is **both** complex **and** frequently changed — and roughly 1–2% of a codebase tends to account for ~70% of its change activity. Hotspot puts that ranking one command away.

## How the score works

For every file with git history, Hotspot fuses five process signals into an additive core, then shapes that core with complexity and bug-fix history.

**Process signals (the additive core):**

- **Change frequency** *(0.30)* — number of commits touching the file
- **Code churn** *(0.25)* — lines added + deleted
- **Author spread** *(0.15)* — number of distinct authors
- **Ownership fragmentation** *(0.15)* — `1 − the top author's commit share`; code spread thin across many low-share "minor contributors" (weak ownership) correlates strongly with defects (Bird et al., *Don't Touch My Code!*, 2011)
- **Change coupling** *(0.15)* — the file's strongest hidden co-change dependency (`shared commits / max(revisions)`); files that historically change together but live apart are easy to update inconsistently

**Shaping factors:**

- **Complexity** — an indentation proxy (language-agnostic, no parser), applied as a ×[0.5–1] multiplier
- **Bug-fix density** — the fraction of touching commits that were bug fixes (detected from commit messages), applied as a `(1 + density)` booster

Signals are log-dampened and min–max normalized **across your repository**, then combined into a score from 0–100 and a tier — **low / medium / high / critical**.

> **Scores are relative rankings, not absolute probabilities.** A score of 80 means "among the riskiest files *in this repo*," not "80% likely to be buggy." Comparing scores across different repositories is not meaningful.

## Features

- **`Hotspot: Scan Workspace`** — run from the Command Palette to analyze the repository.
- **Explorer decorations** — a colored badge marks each file's risk tier in the Explorer.
- **Status bar** — the active file's risk score and tier at a glance; **click it to open Top Hotspots**.
- **Risk Report panel** — a dedicated activity-bar view listing the riskiest files top-down; click an entry to open the file.
- **`Hotspot: Show Top Hotspots`** — a Quick Pick jump-list of the highest-risk files; pick one to open it instantly.
- **`Hotspot: Show Coupled Files`** — for the active file, a Quick Pick of the files that historically change *with* it ("you probably also need to edit X"). Available from the Command Palette **and** the editor right-click menu.

## Settings

- `hotspot.scanOnStartup` *(default `true`)* — scan automatically when a git workspace opens (reuses the cached history when `HEAD` is unchanged).
- `hotspot.topHotspotsCount` *(default `20`)* — how many files **Show Top Hotspots** lists.

## Requirements

- A workspace that is a **git repository** (the extension activates on `workspaceContains:.git`).
- `git` available on your `PATH`.

## Privacy

100% local and offline. Hotspot reads your local git history and file contents **on your machine** and never sends code, history, or telemetry anywhere. No account, no API key, no time limit.

## Known limitations

- **Relative by design.** Scores rank files *within one repo*; they are not cross-repo comparable and are not literal bug probabilities.
- **Cold start / small history.** A brand-new repo, a single-file change set, or files where every signal is equal yield low/zero discriminating scores — there simply isn't enough history yet to rank. Change-coupling in particular needs files to have co-changed several times before it reports a partner.
- **Heuristic bug-fix detection.** Bug-fix commits are inferred from commit-message keywords and issue-closing references. Unconventional commit messages may be mis-labelled.
- **Indentation-based complexity.** v1 uses an indentation proxy (correlated with cyclomatic complexity, but not a parse). Deeply reformatted or unusually-indented files can skew it.

## How it compares

| Tool | Local | Free | Inline in editor | Churn × complexity |
|------|:----:|:----:|:----------------:|:------------------:|
| **Hotspot** | ✅ | ✅ | ✅ | ✅ |
| CodeScene | ☁️ paid | ❌ | partial | ✅ |
| SonarLint | ✅ | ✅ | ✅ | ❌ (rule-based) |
| Code Climate | ☁️ | ❌ | ❌ | ✅ |
| GitAudit | ✅ | ✅ | ❌ (treemap) | ❌ (git-only) |

Hotspot's wedge: the only tool that is fully local, fuses churn + bug-history + complexity + ownership + change-coupling, and shows the result **inline** where you edit.

## Roadmap

Not yet built — tracked for future releases:

- Per-function risk via CodeLens
- More accurate complexity (escomplex / tree-sitter) as an optional mode
- A webview heatmap dashboard
- Optional, opt-in AI explanations (local-first; off by default)

## License

[MIT](./LICENSE).
