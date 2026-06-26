# Hotspot — Bug Hotspot Predictor

**CodeScene-style churn × complexity bug-risk prediction — but free, 100% offline, and shown inline where you code.**

Hotspot ranks the files in your repository by how **bug-prone** they are, fusing three evidence-backed signals — git change history, bug-fix history, and code complexity — into a single 0–100 risk score, surfaced right in the editor.

> ### "Bug hotspot" ≠ "security hotspot"
> Hotspot flags files that are *statistically likely to contain defects*, based on how they have changed over time. It is **not** a security scanner — it does **not** identify security-sensitive code the way SonarLint's "security hotspots" do.

---

## Why it exists

Decades of defect-prediction research (Rahman & Devanbu, ICSE 2013) found that **how code changes** predicts bugs better than **what the code looks like** statically. Adam Tornhill's hotspot model sharpens this: a file is dangerous only when it is **both** complex **and** frequently changed — and roughly 1–2% of a codebase tends to account for ~70% of its change activity. Hotspot puts that ranking one command away.

## How the score works

For every file with git history, Hotspot combines:

- **Change frequency** — number of commits touching the file
- **Code churn** — lines added + deleted
- **Author spread** — number of distinct authors
- **Complexity** — an indentation proxy (language-agnostic, no parser), applied as a multiplier
- **Bug-fix density** — the fraction of touching commits that were bug fixes (detected from commit messages), applied as a booster

Signals are log-dampened and min–max normalized **across your repository**, then combined (Tornhill model: process metrics × complexity multiplier × bug-fix factor) into a score from 0–100 and a tier — **low / medium / high / critical**.

> **Scores are relative rankings, not absolute probabilities.** A score of 80 means "among the riskiest files *in this repo*," not "80% likely to be buggy." Comparing scores across different repositories is not meaningful.

## Features

- **`Hotspot: Scan Workspace`** — run from the Command Palette to analyze the repository.
- **Explorer decorations** — a colored badge marks each file's risk tier in the Explorer.
- **Status bar** — the active file's risk score and tier at a glance.
- **Risk Report panel** — a dedicated activity-bar view listing the riskiest files top-down; click an entry to open the file.

## Requirements

- A workspace that is a **git repository** (the extension activates on `workspaceContains:.git`).
- `git` available on your `PATH`.

## Privacy

100% local and offline. Hotspot reads your local git history and file contents **on your machine** and never sends code, history, or telemetry anywhere. No account, no API key, no time limit.

## Known limitations

- **Relative by design.** Scores rank files *within one repo*; they are not cross-repo comparable and are not literal bug probabilities.
- **Cold start / small history.** A brand-new repo, a single-file change set, or files where every signal is equal yield low/zero discriminating scores — there simply isn't enough history yet to rank.
- **Heuristic bug-fix detection.** Bug-fix commits are inferred from commit-message keywords and issue-closing references. Unconventional commit messages may be mis-labelled.
- **Indentation-based complexity.** v1 uses an indentation proxy (correlated with cyclomatic complexity, but not a parse). Deeply reformatted or unusually-indented files can skew it.
- **Not yet included:** ownership concentration and change-coupling signals are planned but **not** part of the score today (see Roadmap).

## How it compares

| Tool | Local | Free | Inline in editor | Churn × complexity |
|------|:----:|:----:|:----------------:|:------------------:|
| **Hotspot** | ✅ | ✅ | ✅ | ✅ |
| CodeScene | ☁️ paid | ❌ | partial | ✅ |
| SonarLint | ✅ | ✅ | ✅ | ❌ (rule-based) |
| Code Climate | ☁️ | ❌ | ❌ | ✅ |
| GitAudit | ✅ | ✅ | ❌ (treemap) | ❌ (git-only) |

Hotspot's wedge: the only tool that is fully local, fuses churn + bug-history + complexity, and shows the result **inline** where you edit.

## Roadmap

Not yet built — tracked for future releases:

- Ownership-concentration and change-coupling signals ("you probably also need to edit X")
- Per-function risk via CodeLens
- More accurate complexity (escomplex / tree-sitter) as an optional mode
- A webview heatmap dashboard
- Optional, opt-in AI explanations (local-first; off by default)

## License

[MIT](./LICENSE).
