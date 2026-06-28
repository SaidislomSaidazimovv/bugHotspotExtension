// Risk scorer — PURE core (no 'vscode' import).
//
// Fuses process metrics (churn) with a product metric (complexity) into a
// 0–100 per-file risk score, following the Tornhill hotspot model
// (RESEARCH.md §1, §3.5–3.6; ADR-2): a file is dangerous only when it is BOTH
// frequently changed AND complex. Complexity therefore acts as a multiplier on
// the process-metric core, not as an additive term.
//
// Active additive-core signals (RESEARCH §3.6 weighted model, weights sum to 1):
//   - freq            → commits touching the file.
//   - churn           → lines added + deleted.
//   - recency         → time-decay recency weight (FileChurn.recencyWeight, S7-B1):
//                       Σ 0.5^(ageDays/365) back from the newest commit, so
//                       recently-churned files rank higher (RESEARCH §1 code age).
//   - authors         → distinct-author COUNT (`authors.length`).
//   - ownership       → ownership fragmentation `1 − topShare` (ownership.ts), its
//                       OWN weighted term as of S4-B1 (was borrowing the author
//                       slot in S4-A); RESEARCH lists authors AND ownership as
//                       separate dimensions. Wired via `opts.ownership`. (S4-A/B1)
//   - coupling        → change-coupling signal: a file's strongest temporal
//                       co-change strength (coupling.ts); wired via `opts.coupling`
//                       (RESEARCH §3.6). (S4-B1)
// Multiplier signals (outside the additive core):
//   - complexity      → product metric, a [0.5, 1] multiplier (Tornhill model).
//   - bugfix_density  → (1 + density) booster; wired via `opts.bugfixDensity` (S2-D).
// Each signal map is optional; an absent map contributes 0 to its term, so
// `computeRisk(churn, complexity)` with no options still works (forward-compat).

import type { ChurnMap } from './types';
import type { ComplexityResult } from './complexity';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/**
 * Display-only momentum classification (S7-B1), derived from the share of a
 * file's commits that fall inside the recency window (`recentCommits / commits`):
 *   - `rising`  → ≥ 50% of commits are recent AND ≥ 3 commits (enough history)
 *   - `cooling` → ≤ 10% of commits are recent
 *   - `stable`  → in between / too little history
 * NOT a scored signal — it annotates the result for UI badges.
 */
export type RiskTrend = 'rising' | 'stable' | 'cooling';

export interface RiskResult {
  /** Repo-relative path (matches the ChurnMap key). */
  path: string;
  /** Final risk in [0, 100], rounded. */
  score: number;
  /** Tier derived from `score` and the (configurable) thresholds. */
  tier: RiskTier;
  /**
   * RAW (pre-normalization) signal values, for display / debugging:
   *   freq       = number of commits touching the file
   *   churn      = linesAdded + linesDeleted
   *   recency    = time-decay recency weight `Σ 0.5^(ageDays/365)` (FileChurn.
   *                recencyWeight); 0 when the file has no parseable-dated commits
   *   authors    = number of distinct authors
   *   ownership  = ownership fragmentation `1 − topAuthorShare` in [0, 1); 0 when
   *                no `ownership` map was supplied
   *   coupling   = strongest change-coupling strength in [0, 1]; 0 when no
   *                `coupling` map was supplied / the file has no coupled partners
   *   complexity = ComplexityResult.total (0 when no complexity entry exists)
   */
  signals: {
    freq: number;
    churn: number;
    recency: number;
    authors: number;
    ownership: number;
    coupling: number;
    complexity: number;
  };
  /**
   * Momentum classification (S7-B1) from `recentCommits / commits`. Display-only
   * (status-bar/tree badges) — does NOT affect `score`. See {@link RiskTrend}.
   */
  trend: RiskTrend;
}

/** Relative weights of the additive process-metric core. Defaults sum to 1. */
export interface ScoreWeights {
  freq: number;
  churn: number;
  /** Time-decay recency term (S7-B1): recently-churned files rank higher. */
  recency: number;
  authors: number;
  ownership: number;
  coupling: number;
}

/** Upper bounds (exclusive) for each tier; `>= critical` is `critical`. */
export interface ScoreThresholds {
  /** score < medium → low */
  medium: number;
  /** score < high → medium */
  high: number;
  /** score < critical → high; otherwise critical */
  critical: number;
}

export interface ScoreOptions {
  weights?: Partial<ScoreWeights>;
  thresholds?: Partial<ScoreThresholds>;
  /**
   * Forward-compat hook for the deferred bug-fix-density signal: per-path
   * density in [0, ∞) that boosts the score via a `(1 + density)` multiplier.
   * Absent / missing entry ⇒ 0 ⇒ multiplier 1 (no effect), so this can be
   * wired in later with no API change.
   */
  bugfixDensity?: Map<string, number>;
  /**
   * Ownership-fragmentation signal (S4-A/B1): per-path `1 − topAuthorShare` in
   * [0, 1) (see {@link buildOwnership}). As of S4-B1 this is its OWN weighted
   * term (`weights.ownership`), separate from the distinct-author count, matching
   * RESEARCH's separate authors/ownership dimensions (Bird et al. 2011). Absent /
   * missing entry ⇒ 0 ⇒ the ownership term contributes nothing (forward-compat).
   */
  ownership?: Map<string, number>;
  /**
   * Change-coupling signal (S4-B1): per-path strongest temporal co-change
   * strength in [0, 1] (see {@link buildCoupling}), feeding `weights.coupling`.
   * Absent / missing entry ⇒ 0 ⇒ the coupling term contributes nothing
   * (forward-compat).
   */
  coupling?: Map<string, number>;
}

// RESEARCH §3.6 weighted model (sum = 1.0). S4-B1 split ownership + coupling into
// their own terms; S7-B1 added the recency term and rebalanced freq/churn/authors
// down to make room (0.30/0.25/0.15 → 0.22/0.18/0.10) while keeping the sum 1.0.
export const DEFAULT_WEIGHTS: ScoreWeights = {
  freq: 0.22,
  churn: 0.18,
  recency: 0.2,
  authors: 0.1,
  ownership: 0.15,
  coupling: 0.15,
};
const DEFAULT_THRESHOLDS: ScoreThresholds = { medium: 25, high: 50, critical: 75 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Normalize a right-skewed signal: `log1p` to dampen the long tail, then
 * min–max to [0, 1]. When all values are equal (`max === min`, e.g. a single
 * file) there is no discriminating signal, so every value normalizes to 0.
 *
 * Exported so the Risk Explainability layer (S8-A, `core/explain.ts`) can
 * re-derive each signal's normalized contribution from the SAME formula the
 * scorer used — keeping the displayed "% share" breakdown faithful to the score.
 */
export function normalize(values: number[]): number[] {
  const logged = values.map((v) => Math.log1p(v));
  let min = Infinity;
  let max = -Infinity;
  for (const v of logged) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span === 0) {
    return logged.map(() => 0);
  }
  return logged.map((v) => (v - min) / span);
}

function toTier(score: number, t: ScoreThresholds): RiskTier {
  if (score < t.medium) return 'low';
  if (score < t.high) return 'medium';
  if (score < t.critical) return 'high';
  return 'critical';
}

/**
 * Classify a file's momentum from its recent-commit share (S7-B1). `rising`
 * needs both a majority-recent history AND enough commits to be meaningful;
 * `cooling` is a near-dormant file; everything else is `stable`. Pure +
 * display-only — never feeds the score.
 */
function toTrend(recentCommits: number, commits: number): RiskTrend {
  // No history → neutral. Guard FIRST so a 0-commit (malformed/empty) file is not
  // mislabeled 'cooling' by the ratio≤0.1 rule below. Unreachable from real churn
  // (aggregated files have commits ≥ 1), but keeps the classifier total.
  if (commits <= 0) return 'stable';
  const ratio = recentCommits / commits;
  if (ratio >= 0.5 && commits >= 3) return 'rising';
  if (ratio <= 0.1) return 'cooling';
  return 'stable';
}

/**
 * Compute per-file risk scores from churn + complexity, sorted descending by
 * score (ties broken by path for determinism). Pure function of its inputs.
 *
 * The scored universe is the set of files in `churn`; complexity is looked up
 * per path and defaults to 0 when absent. An empty `churn` yields `[]`.
 */
export function computeRisk(
  churn: ChurnMap,
  complexity: Map<string, ComplexityResult>,
  opts: ScoreOptions = {},
): RiskResult[] {
  const weights: ScoreWeights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const thresholds: ScoreThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const bugfixDensity = opts.bugfixDensity;
  const ownership = opts.ownership;
  const coupling = opts.coupling;

  const paths = [...churn.keys()];
  if (paths.length === 0) {
    return [];
  }

  // Gather raw signals in path order. Authors (count), ownership (fragmentation)
  // and coupling (strongest co-change) are now SEPARATE additive terms (S4-B1);
  // an absent signal map ⇒ that raw value is 0 ⇒ after normalize the term is 0.
  const rawFreq: number[] = [];
  const rawChurn: number[] = [];
  const rawRecency: number[] = [];
  const rawAuthors: number[] = [];
  const rawOwnership: number[] = [];
  const rawCoupling: number[] = [];
  const rawComplexity: number[] = [];
  for (const path of paths) {
    const fc = churn.get(path)!;
    rawFreq.push(fc.commits);
    rawChurn.push(fc.linesAdded + fc.linesDeleted);
    // `?? 0`: a pre-S7-B1 cache or hand-built FileChurn may lack recencyWeight ⇒
    // 0 ⇒ after normalize the recency term contributes nothing (forward-compat).
    rawRecency.push(fc.recencyWeight ?? 0);
    rawAuthors.push(fc.authors.length);
    rawOwnership.push(ownership?.get(path) ?? 0);
    rawCoupling.push(coupling?.get(path) ?? 0);
    rawComplexity.push(complexity.get(path)?.total ?? 0);
  }

  const nFreq = normalize(rawFreq);
  const nChurn = normalize(rawChurn);
  const nRecency = normalize(rawRecency);
  const nAuthors = normalize(rawAuthors);
  const nOwnership = normalize(rawOwnership);
  const nCoupling = normalize(rawCoupling);
  const nComplexity = normalize(rawComplexity);

  const results: RiskResult[] = paths.map((path, i) => {
    const fc = churn.get(path)!;
    const core =
      weights.freq * nFreq[i] +
      weights.churn * nChurn[i] +
      weights.recency * nRecency[i] +
      weights.authors * nAuthors[i] +
      weights.ownership * nOwnership[i] +
      weights.coupling * nCoupling[i];
    const density = bugfixDensity?.get(path) ?? 0;
    // Complexity multiplier in [0.5, 1]: a process-hot file with no complexity
    // signal still scores half; a complex one scores full. Bug-fix density is a
    // (1 + d) booster (d = 0 today ⇒ no effect).
    const raw = core * (0.5 + 0.5 * nComplexity[i]) * (1 + density);
    const score = Math.round(100 * clamp(raw, 0, 1));
    return {
      path,
      score,
      tier: toTier(score, thresholds),
      signals: {
        freq: rawFreq[i],
        churn: rawChurn[i],
        recency: rawRecency[i],
        authors: rawAuthors[i],
        ownership: rawOwnership[i],
        coupling: rawCoupling[i],
        complexity: rawComplexity[i],
      },
      trend: toTrend(fc.recentCommits ?? 0, fc.commits),
    };
  });

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results;
}
