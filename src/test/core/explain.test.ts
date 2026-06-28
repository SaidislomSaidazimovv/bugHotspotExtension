// Unit tests for the Risk Explainability layer (S8-A). Synthetic RiskResult[]
// only — no git, no vscode. Runner: Vitest (`npm run unit`).

import { describe, it, expect } from 'vitest';

import {
  explainScore,
  effectiveWeights,
  explainSentence,
  breakdownLine,
  buildExplanations,
  rankedShares,
  CORE_SIGNALS,
  RELATIVE_CAVEAT,
} from '../../core/explain';
import { DEFAULT_WEIGHTS, type RiskResult } from '../../core/scorer';

/** Build a RiskResult with all signals 0 except the ones overridden. */
function makeResult(path: string, signals: Partial<RiskResult['signals']> = {}): RiskResult {
  return {
    path,
    score: 0,
    tier: 'low',
    trend: 'stable',
    signals: {
      freq: 0,
      churn: 0,
      recency: 0,
      authors: 0,
      ownership: 0,
      coupling: 0,
      complexity: 0,
      ...signals,
    },
  };
}

function sumShares(shares: Record<string, number>): number {
  return CORE_SIGNALS.reduce((acc, k) => acc + shares[k], 0);
}

describe('explainScore — share decomposition', () => {
  it('shares sum to 100% of the additive core for every non-zero file', () => {
    const results = [
      makeResult('a.ts', { freq: 100, churn: 40, recency: 9, authors: 5, ownership: 0.7, coupling: 0.8 }),
      makeResult('b.ts', { freq: 10, churn: 200, recency: 1, authors: 2, ownership: 0.2, coupling: 0.1 }),
      makeResult('c.ts', { freq: 3, churn: 5, recency: 0.2, authors: 1, ownership: 0, coupling: 0 }),
    ];
    const map = explainScore(results);
    for (const path of ['a.ts', 'b.ts']) {
      const exp = map.get(path)!;
      expect(Math.abs(sumShares(exp.shares) - 1)).toBeLessThan(1e-9);
    }
  });

  it('derives the dominant driver from WEIGHTED·NORMALIZED contributions, not raw signals', () => {
    // freq raw (10) > recency raw (8), and both are the column max ⇒ each
    // normalizes to 1, so the *weight* decides: freq (0.22) beats recency (0.20).
    const results = [
      makeResult('hot.ts', { freq: 10, recency: 8 }),
      makeResult('cold.ts', { freq: 2, recency: 1 }),
    ];
    const exp = explainScore(results).get('hot.ts')!;
    expect(exp.dominant).toBe('freq');
    expect(exp.shares.freq).toBeGreaterThan(exp.shares.recency);
    // corePct = 100·(0.22 + 0.20) = 42 (additive core only; no complexity/bugfix).
    expect(exp.corePct).toBe(42);
  });

  it('uses EFFECTIVE (user-overridden) weights when supplied', () => {
    const results = [
      makeResult('hot.ts', { freq: 10, recency: 8 }),
      makeResult('cold.ts', { freq: 2, recency: 1 }),
    ];
    // Crank recency above freq ⇒ recency now dominates the same data.
    const exp = explainScore(results, { recency: 0.9 }).get('hot.ts')!;
    expect(exp.dominant).toBe('recency');
    expect(exp.shares.recency).toBeGreaterThan(exp.shares.freq);
  });

  it('normalized reordering beats raw: a column-max fraction outranks a bigger-but-not-max count', () => {
    // x.ts: freq=50 is NOT the column max (y.ts has 1000) ⇒ normalizes to 0;
    //       ownership=0.9 IS the column max ⇒ normalizes to 1.
    // A naive raw·weight impl would pick freq (50·0.22 = 11 ≫ 0.9·0.15 = 0.135);
    // the CORRECT normalized·weight impl picks ownership. This test fails on raw.
    const results = [
      makeResult('x.ts', { freq: 50, ownership: 0.9 }),
      makeResult('y.ts', { freq: 1000, ownership: 0.1 }),
    ];
    const exp = explainScore(results).get('x.ts')!;
    expect(exp.dominant).toBe('ownership');
    expect(exp.shares.ownership).toBeCloseTo(1, 9);
    expect(exp.shares.freq).toBe(0);
  });

  it('breaks an exact contribution tie deterministically by canonical signal order', () => {
    // ownership & coupling share the default weight (0.15) and identical raw
    // columns ⇒ identical normalized·weighted contributions ⇒ a real tie. The
    // earlier canonical signal (ownership) must win, repeatably.
    const results = [
      makeResult('a.ts', { ownership: 0.5, coupling: 0.5 }),
      makeResult('b.ts', { ownership: 0.1, coupling: 0.1 }),
    ];
    const first = explainScore(results).get('a.ts')!;
    const second = explainScore(results).get('a.ts')!;
    expect(first.dominant).toBe('ownership');
    expect(second.dominant).toBe('ownership');
    expect(first.shares.ownership).toBeCloseTo(first.shares.coupling, 9);
  });

  it('guards coreSum === 0: shares all zero, dominant null, no NaN', () => {
    const results = [
      makeResult('signal.ts', { freq: 100 }),
      makeResult('silent.ts', {}), // every raw signal 0 ⇒ no contribution
    ];
    const exp = explainScore(results).get('silent.ts')!;
    expect(exp.dominant).toBeNull();
    expect(exp.corePct).toBe(0);
    for (const k of CORE_SIGNALS) {
      expect(exp.shares[k]).toBe(0);
      expect(Number.isNaN(exp.shares[k])).toBe(false);
    }
  });

  it('a single file has no discriminating signal (whole-set normalize ⇒ all 0)', () => {
    const exp = explainScore([makeResult('only.ts', { freq: 50, churn: 99 })]).get('only.ts')!;
    expect(exp.dominant).toBeNull();
    expect(sumShares(exp.shares)).toBe(0);
  });

  it('empty results ⇒ empty map', () => {
    expect(explainScore([]).size).toBe(0);
  });
});

describe('effectiveWeights — sanitization', () => {
  it('returns the defaults for missing / non-object input', () => {
    expect(effectiveWeights(undefined)).toEqual(DEFAULT_WEIGHTS);
    expect(effectiveWeights(null)).toEqual(DEFAULT_WEIGHTS);
    expect(effectiveWeights(42)).toEqual(DEFAULT_WEIGHTS);
  });

  it('keeps finite non-negative overrides and drops invalid / unknown keys', () => {
    const w = effectiveWeights({ freq: 0.5, churn: -1, recency: 'x', bogus: 9, coupling: 0 });
    expect(w.freq).toBe(0.5); // valid override
    expect(w.churn).toBe(DEFAULT_WEIGHTS.churn); // negative rejected
    expect(w.recency).toBe(DEFAULT_WEIGHTS.recency); // non-number rejected
    expect(w.coupling).toBe(0); // 0 is a valid weight
    expect('bogus' in w).toBe(false); // unknown key not carried over
  });
});

describe('explainSentence + breakdownLine', () => {
  const results = [
    makeResult('a.ts', { freq: 100, recency: 50 }),
    makeResult('b.ts', { freq: 2, recency: 1 }),
  ];

  it('names the top drivers with % and always appends the relative-ranking caveat', () => {
    const exp = explainScore(results).get('a.ts')!;
    const sentence = explainSentence(exp);
    expect(sentence).toMatch(/^Mostly because it /);
    expect(sentence).toMatch(/\(\d+%\)/);
    expect(sentence).toContain(RELATIVE_CAVEAT);
  });

  it('falls back to a neutral message when there is no dominant signal', () => {
    const exp = explainScore([makeResult('solo.ts', { freq: 1 })]).get('solo.ts')!;
    const sentence = explainSentence(exp);
    expect(sentence).toMatch(/Not enough history/);
    expect(sentence).toContain(RELATIVE_CAVEAT);
  });

  it('names the coupling partner when coupling is a top driver', () => {
    const coupled = [
      makeResult('x.ts', { coupling: 0.9 }),
      makeResult('y.ts', { coupling: 0.1 }),
    ];
    const exp = explainScore(coupled).get('x.ts')!;
    expect(exp.dominant).toBe('coupling');
    const sentence = explainSentence(exp, { couplingPartner: 'src/partner.ts' });
    expect(sentence).toContain('coupled to src/partner.ts');
  });

  it('breakdownLine lists signals in descending share order', () => {
    const exp = explainScore(results).get('a.ts')!;
    const line = breakdownLine(exp);
    const ranked = rankedShares(exp);
    expect(line.startsWith(`${ranked[0].signal} `)).toBe(true);
    expect(line).toMatch(/%/);
  });
});

describe('buildExplanations — view assembly', () => {
  it('attaches line + sentence and resolves the coupling partner only when relevant', () => {
    const results = [
      makeResult('x.ts', { coupling: 0.9 }),
      makeResult('y.ts', { freq: 100 }),
    ];
    const calls: string[] = [];
    const map = buildExplanations(results, undefined, (p) => {
      calls.push(p);
      return p === 'x.ts' ? 'src/partner.ts' : undefined;
    });
    expect(map.get('x.ts')!.sentence).toContain('coupled to src/partner.ts');
    expect(map.get('x.ts')!.line).toMatch(/coupling/);
    // y.ts has zero coupling ⇒ the partner resolver is never consulted for it.
    expect(calls).toContain('x.ts');
    expect(calls).not.toContain('y.ts');
  });
});
