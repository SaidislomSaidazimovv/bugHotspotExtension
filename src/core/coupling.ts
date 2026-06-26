/**
 * Change-coupling (temporal co-change) signal — PURE core (no 'vscode' import).
 *
 * RESEARCH §3.6 / §2: files that historically change together in the same commit
 * are *hidden-coupled* — editing one while forgetting the other is a classic
 * source of bugs. From the pairwise co-change counts collected in a single git
 * pass ({@link readChurnWithCoupling}) plus each file's revision count, we
 * compute, per ordered direction:
 *
 *   coupling(A, B) = sharedCommits(A, B) / max(revs(A), revs(B))      ∈ [0, 1]
 *
 * Dividing by `max(revs)` (not `min`) keeps a file that merely rides along inside
 * a big, frequently-touched neighbour from showing spuriously high coupling.
 * Pairs below a min-support threshold (default 5 shared commits) are dropped as
 * noise. For each file we surface (a) `signal` = its single strongest coupling
 * (the scalar the scorer consumes) and (b) `partners` = its top-K strongest
 * partners (the actionable "you should also edit X" list for the UI).
 */

import { splitCoChangeKey } from './types';
import type { ChurnMap, CoChangeCount } from './types';

/** A file's co-change partner, for the "Show Coupled Files" UI (S4-B2). */
export interface CoupledFile {
  /** Repo-relative path of the coupled partner. */
  path: string;
  /** Coupling strength `sharedCommits / max(revs)` in [0, 1]. */
  strength: number;
  /** Number of commits that touched both files. */
  sharedCommits: number;
}

export interface CouplingOptions {
  /** Minimum shared commits for a pair to count (RESEARCH §3.6). Default 5. */
  minSupport?: number;
  /** Max partners retained per file. Default 5. */
  topK?: number;
}

export interface CouplingResult {
  /** Per-file ranked partner list (desc by strength), capped at `topK`. */
  partners: Map<string, CoupledFile[]>;
  /** Per-file scalar = its strongest partner's strength (0 when none ≥ support). */
  signal: Map<string, number>;
}

export const DEFAULT_MIN_SUPPORT = 5;
export const DEFAULT_TOP_K = 5;

/**
 * Build the change-coupling partner lists + per-file signal from a churn map and
 * its pairwise co-change counts. Pure function of its inputs; deterministic
 * (partners sorted by strength desc, then sharedCommits desc, then path asc).
 */
export function buildCoupling(
  churn: ChurnMap,
  coChange: CoChangeCount,
  opts: CouplingOptions = {},
): CouplingResult {
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const topK = opts.topK ?? DEFAULT_TOP_K;

  const partners = new Map<string, CoupledFile[]>();
  const add = (from: string, to: string, strength: number, sharedCommits: number) => {
    const list = partners.get(from);
    const entry: CoupledFile = { path: to, strength, sharedCommits };
    if (list) {
      list.push(entry);
    } else {
      partners.set(from, [entry]);
    }
  };

  for (const [key, sharedCommits] of coChange) {
    if (sharedCommits < minSupport) {
      continue;
    }
    const [a, b] = splitCoChangeKey(key);
    const revsA = churn.get(a)?.commits ?? 0;
    const revsB = churn.get(b)?.commits ?? 0;
    const denom = Math.max(revsA, revsB);
    if (denom <= 0) {
      continue; // a pair whose files aren't in the churn map (shouldn't happen)
    }
    const strength = sharedCommits / denom;
    // Symmetric metric → record the partner in both directions.
    add(a, b, strength, sharedCommits);
    add(b, a, strength, sharedCommits);
  }

  const signal = new Map<string, number>();
  for (const [path, list] of partners) {
    list.sort(
      (x, y) =>
        y.strength - x.strength ||
        y.sharedCommits - x.sharedCommits ||
        x.path.localeCompare(y.path),
    );
    // Strongest partner first → that's the per-file coupling signal.
    signal.set(path, list[0].strength);
    if (list.length > topK) {
      list.length = topK; // truncate to top-K in place
    }
  }

  return { partners, signal };
}
