// Risk Explainability Breakdown — PURE core (no 'vscode' import). (S8-A)
//
// Answers the #1 user question — "why is this file risky?" — by decomposing each
// file's ADDITIVE CORE into a per-signal % share + a named dominant driver, in
// plain language. READ-ONLY: it re-derives the breakdown from the already-computed
// `RiskResult`s at display time; it never re-scores, mutates a `RiskResult`, or
// bumps the churn cache (ADR-7).
//
// CRITICAL (recon-confirmed): `RiskResult.signals` holds RAW values — counts
// (freq/churn/authors) mixed with fractions (recency/ownership/coupling) — so a
// share CANNOT be read off them directly. The real per-signal contribution to the
// score is `effectiveWeight.X × normalize(allRawX)[i]`, where `normalize` is the
// SAME whole-set log1p→min-max the scorer ran (scorer.ts). We reproduce exactly
// that, then divide by the per-file core sum to get shares that sum to 100%.
//
// Only the additive core is decomposed. The complexity multiplier ([0.5, 1]) and
// the bug-fix `(1 + density)` booster are NOT additive terms, so they are out of
// scope of the share breakdown (documented, by design).

import { normalize, DEFAULT_WEIGHTS } from './scorer';
import type { RiskResult, ScoreWeights } from './scorer';

/** The six additive-core signals, in canonical (weight-key) order. */
export const CORE_SIGNALS = [
  'freq',
  'churn',
  'recency',
  'authors',
  'ownership',
  'coupling',
] as const;
export type CoreSignal = (typeof CORE_SIGNALS)[number];

/** Per-file decomposition of the additive core. */
export interface Explanation {
  /**
   * Each signal's fraction of the additive core, in [0, 1]. Sums to 1 (100%)
   * across the six signals when the core is non-zero; all 0 when the core is 0
   * (single file / no discriminating history).
   */
  shares: Record<CoreSignal, number>;
  /**
   * The single largest contributor, or `null` when there is no discriminating
   * signal (`coreSum === 0`: a single-file repo or thin history). Callers treat
   * `null` as "not enough history to attribute".
   */
  dominant: CoreSignal | null;
  /**
   * The additive core as a 0–100 value (`round(100 · coreSum)`). This is NOT the
   * final risk score — the score also folds in the complexity multiplier and the
   * bug-fix booster, which are deliberately excluded from this additive breakdown.
   */
  corePct: number;
}

/** A friendly verb-phrase per signal for the one-sentence "why" summary. */
export const SIGNAL_PHRASE: Record<CoreSignal, string> = {
  freq: 'changes very frequently',
  churn: 'has a lot of code churn',
  recency: 'was changed recently',
  authors: 'has many contributors',
  ownership: 'has fragmented ownership',
  coupling: 'is coupled to other files',
};

/** A compact label per signal for the "freq 48% · churn 15% · …" breakdown line. */
export const SIGNAL_LABEL: Record<CoreSignal, string> = {
  freq: 'freq',
  churn: 'churn',
  recency: 'recency',
  authors: 'authors',
  ownership: 'ownership',
  coupling: 'coupling',
};

/**
 * The framing caveat appended to every explanation: scores are a within-repo
 * relative ranking, not a probability, and can move from one scan to the next
 * (acceptance g). Kept in one place so all three surfaces stay consistent.
 */
export const RELATIVE_CAVEAT =
  'Relative ranking within this repo — not a probability, and can shift scan-to-scan.';

/**
 * Merge a raw (possibly user-supplied) weights object onto {@link DEFAULT_WEIGHTS},
 * keeping only finite, non-negative values for the six known keys. Pure: the host
 * reads `hotspot.weights` and passes the raw value here so the display-time shares
 * use the SAME effective weights the scan scored with (acceptance h). Mirrors the
 * sanitization in `scanService.getWeights()`.
 */
export function effectiveWeights(raw: unknown): ScoreWeights {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of CORE_SIGNALS) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        w[key] = v;
      }
    }
  }
  return w;
}

/**
 * Decompose every file's additive core into per-signal shares + a dominant driver.
 * Must be given the WHOLE result set (the scored universe) because `normalize` is
 * a whole-set min–max — a single file in isolation has no discriminating signal.
 *
 * `weights` is the EFFECTIVE weight vector (defaults merged with user overrides,
 * see {@link effectiveWeights}); a missing key falls back to its default.
 */
export function explainScore(
  results: readonly RiskResult[],
  weights?: Partial<ScoreWeights>,
): Map<string, Explanation> {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const out = new Map<string, Explanation>();
  if (results.length === 0) {
    return out;
  }

  // Re-run the scorer's whole-set normalization per signal over the RAW values.
  const normalized: Record<CoreSignal, number[]> = {
    freq: normalize(results.map((r) => r.signals.freq)),
    churn: normalize(results.map((r) => r.signals.churn)),
    recency: normalize(results.map((r) => r.signals.recency)),
    authors: normalize(results.map((r) => r.signals.authors)),
    ownership: normalize(results.map((r) => r.signals.ownership)),
    coupling: normalize(results.map((r) => r.signals.coupling)),
  };

  results.forEach((r, i) => {
    const contrib = {} as Record<CoreSignal, number>;
    let coreSum = 0;
    for (const key of CORE_SIGNALS) {
      const c = w[key] * normalized[key][i];
      contrib[key] = c;
      coreSum += c;
    }

    const shares = {} as Record<CoreSignal, number>;
    let dominant: CoreSignal | null = null;
    if (coreSum > 0) {
      let best = -Infinity;
      for (const key of CORE_SIGNALS) {
        shares[key] = contrib[key] / coreSum;
        // Strict `>` + canonical iteration order ⇒ deterministic tie-break.
        if (contrib[key] > best) {
          best = contrib[key];
          dominant = key;
        }
      }
    } else {
      // No discriminating signal (single file / thin history): every share is 0
      // and there is no dominant driver. Guards against NaN (acceptance d).
      for (const key of CORE_SIGNALS) {
        shares[key] = 0;
      }
    }

    out.set(r.path, { shares, dominant, corePct: Math.round(100 * coreSum) });
  });

  return out;
}

/** Signals paired with their share, sorted descending (canonical-order tie-break). */
export function rankedShares(exp: Explanation): { signal: CoreSignal; share: number }[] {
  return CORE_SIGNALS.map((signal) => ({ signal, share: exp.shares[signal] })).sort(
    (a, b) =>
      b.share - a.share || CORE_SIGNALS.indexOf(a.signal) - CORE_SIGNALS.indexOf(b.signal),
  );
}

/** Compact "freq 48% · recency 22% · churn 15% · …" line (descending share). */
export function breakdownLine(exp: Explanation): string {
  return rankedShares(exp)
    .map(({ signal, share }) => `${SIGNAL_LABEL[signal]} ${Math.round(share * 100)}%`)
    .join(' · ');
}

/**
 * One-sentence plain-language "why this score?" summary built from the top one or
 * two drivers, always closed with {@link RELATIVE_CAVEAT}. When `couplingPartner`
 * is supplied and coupling is a top driver, the partner is named (resolved
 * host-side — it is NOT on `RiskResult`, acceptance f). `dominant === null` ⇒ a
 * neutral "not enough history" message.
 */
export function explainSentence(
  exp: Explanation,
  opts: { couplingPartner?: string } = {},
): string {
  if (exp.dominant === null) {
    return `Not enough history to attribute this score. ${RELATIVE_CAVEAT}`;
  }
  const top = rankedShares(exp)
    .filter((d) => d.share > 0)
    .slice(0, 2);
  const phrases = top.map(({ signal, share }) => {
    const pct = Math.round(share * 100);
    if (signal === 'coupling' && opts.couplingPartner) {
      return `is coupled to ${opts.couplingPartner} (${pct}%)`;
    }
    return `${SIGNAL_PHRASE[signal]} (${pct}%)`;
  });
  const because = phrases.length === 1 ? phrases[0] : `${phrases[0]} and ${phrases[1]}`;
  return `Mostly because it ${because}. ${RELATIVE_CAVEAT}`;
}

/** An {@link Explanation} plus the rendered display strings, for the UI surfaces. */
export interface ExplanationView extends Explanation {
  /** Compact descending-share line (see {@link breakdownLine}). */
  line: string;
  /** One-sentence summary with the relative-ranking caveat (see {@link explainSentence}). */
  sentence: string;
}

/**
 * Build ready-to-render explanations for every result, keeping the three UI
 * surfaces (Risk Report tooltip, Top Hotspots, export) in sync (acceptance i).
 * `getCouplingPartner` resolves a file's strongest co-change partner name
 * host-side (e.g. `service.getCoupledFiles(path)[0]?.path`); it is only consulted
 * when coupling actually contributes, so passing it is cheap.
 */
export function buildExplanations(
  results: readonly RiskResult[],
  weights?: Partial<ScoreWeights>,
  getCouplingPartner?: (path: string) => string | undefined,
): Map<string, ExplanationView> {
  const base = explainScore(results, weights);
  const out = new Map<string, ExplanationView>();
  for (const r of results) {
    const exp = base.get(r.path)!;
    const partner =
      exp.shares.coupling > 0 ? getCouplingPartner?.(r.path) : undefined;
    out.set(r.path, {
      ...exp,
      line: breakdownLine(exp),
      sentence: explainSentence(exp, { couplingPartner: partner }),
    });
  }
  return out;
}
