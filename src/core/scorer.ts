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
    authors: number;
    ownership: number;
    coupling: number;
    complexity: number;
  };
}

/** Relative weights of the additive process-metric core. Defaults sum to 1. */
export interface ScoreWeights {
  freq: number;
  churn: number;
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

// RESEARCH §3.6 weighted model (sum = 1.0). S4-B1 rebalanced the S4-A defaults
// (0.45/0.35/0.2) to split ownership + coupling into their own terms.
const DEFAULT_WEIGHTS: ScoreWeights = {
  freq: 0.3,
  churn: 0.25,
  authors: 0.15,
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
 */
function normalize(values: number[]): number[] {
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
  const rawAuthors: number[] = [];
  const rawOwnership: number[] = [];
  const rawCoupling: number[] = [];
  const rawComplexity: number[] = [];
  for (const path of paths) {
    const fc = churn.get(path)!;
    rawFreq.push(fc.commits);
    rawChurn.push(fc.linesAdded + fc.linesDeleted);
    rawAuthors.push(fc.authors.length);
    rawOwnership.push(ownership?.get(path) ?? 0);
    rawCoupling.push(coupling?.get(path) ?? 0);
    rawComplexity.push(complexity.get(path)?.total ?? 0);
  }

  const nFreq = normalize(rawFreq);
  const nChurn = normalize(rawChurn);
  const nAuthors = normalize(rawAuthors);
  const nOwnership = normalize(rawOwnership);
  const nCoupling = normalize(rawCoupling);
  const nComplexity = normalize(rawComplexity);

  const results: RiskResult[] = paths.map((path, i) => {
    const core =
      weights.freq * nFreq[i] +
      weights.churn * nChurn[i] +
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
        authors: rawAuthors[i],
        ownership: rawOwnership[i],
        coupling: rawCoupling[i],
        complexity: rawComplexity[i],
      },
    };
  });

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results;
}
