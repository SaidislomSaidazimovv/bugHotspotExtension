// Risk scorer — PURE core (no 'vscode' import).
//
// Fuses process metrics (churn) with a product metric (complexity) into a
// 0–100 per-file risk score, following the Tornhill hotspot model
// (RESEARCH.md §1, §3.5–3.6; ADR-2): a file is dangerous only when it is BOTH
// frequently changed AND complex. Complexity therefore acts as a multiplier on
// the process-metric core, not as an additive term.
//
// Deferred signals (hooks only — P will file follow-ups; do NOT implement here):
//   - bugfix_density  → needs gitReader to capture commit subjects + a
//                       bugfix.ts classifier. Wired via `opts.bugfixDensity`.
//   - ownership       → needs per-author commit COUNTS; ChurnMap stores only
//                       distinct author names today.
//   - change coupling → co-change mining across commits.

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
   *   complexity = ComplexityResult.total (0 when no complexity entry exists)
   */
  signals: {
    freq: number;
    churn: number;
    authors: number;
    complexity: number;
  };
}

/** Relative weights of the additive process-metric core. Defaults sum to 1. */
export interface ScoreWeights {
  freq: number;
  churn: number;
  authors: number;
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
}

const DEFAULT_WEIGHTS: ScoreWeights = { freq: 0.45, churn: 0.35, authors: 0.2 };
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

  const paths = [...churn.keys()];
  if (paths.length === 0) {
    return [];
  }

  // Gather raw signals in path order.
  const rawFreq: number[] = [];
  const rawChurn: number[] = [];
  const rawAuthors: number[] = [];
  const rawComplexity: number[] = [];
  for (const path of paths) {
    const fc = churn.get(path)!;
    rawFreq.push(fc.commits);
    rawChurn.push(fc.linesAdded + fc.linesDeleted);
    rawAuthors.push(fc.authors.length);
    rawComplexity.push(complexity.get(path)?.total ?? 0);
  }

  const nFreq = normalize(rawFreq);
  const nChurn = normalize(rawChurn);
  const nAuthors = normalize(rawAuthors);
  const nComplexity = normalize(rawComplexity);

  const results: RiskResult[] = paths.map((path, i) => {
    const core =
      weights.freq * nFreq[i] +
      weights.churn * nChurn[i] +
      weights.authors * nAuthors[i];
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
        complexity: rawComplexity[i],
      },
    };
  });

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results;
}
