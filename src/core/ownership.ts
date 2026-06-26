/**
 * Code-ownership signal (RESEARCH §1 "Ownership concentration (low = risk)";
 * RESEARCH §3 normalization formula's `(1 − ownership)` term; Bird et al. 2011,
 * "Don't Touch My Code! Examining the Effects of Ownership on Software Quality").
 *
 * Bird et al. show that *fragmented* ownership — many low-share "minor"
 * contributors and a weak top owner — correlates strongly with post-release
 * defects. We turn the per-author commit counts captured by the git reader into
 * a fragmentation metric and feed it to the scorer's author weight slot,
 * replacing the cruder distinct-author *count* it used before.
 *
 * Pure module — NO `vscode` import (ADR-1). Mirrors the `buildBugfixDensity`
 * shape so the host wires it the same way:
 *   computeRisk(churn, complexity, { ownership: buildOwnership(churn) })
 */

import type { ChurnMap, FileChurn } from './types';

/** Default minor-contributor cutoff: an author whose share of a file's commits is below this is "minor" (RESEARCH §1 / Bird et al.). */
export const DEFAULT_MINOR_THRESHOLD = 0.05;

export interface OwnershipStats {
  /** Largest single author's share of the file's commits, in [0, 1]. 0 when there is no author data. */
  topShare: number;
  /** Ownership fragmentation `1 − topShare`, in [0, 1). Higher ⇒ more fragmented ⇒ riskier. */
  fragmentation: number;
  /** Count of authors whose individual share is below `minorThreshold`. */
  minorContributors: number;
}

/**
 * Per-file ownership statistics from its {@link FileChurn.authorCommits}.
 *
 * `topShare = maxAuthorCommits / commits`; `fragmentation = 1 − topShare`;
 * `minorContributors` = authors with share < `minorThreshold` (default 5%).
 * Guards the no-data case (no `authorCommits`, or `commits === 0`): returns
 * `topShare = 0`, `fragmentation = 0`, `minorContributors = 0` so a file with
 * unknown ownership contributes no fragmentation signal rather than a spurious
 * "maximally fragmented" one.
 */
export function ownershipStats(
  fc: FileChurn,
  minorThreshold: number = DEFAULT_MINOR_THRESHOLD,
): OwnershipStats {
  const perAuthor = fc.authorCommits ?? [];
  // Denominator: the file's own commit total. Each commit is attributed to one
  // author, so this equals sum(perAuthor.commits); using `commits` keeps us
  // robust even if a degraded cache left the two slightly out of sync.
  const total = fc.commits > 0 ? fc.commits : perAuthor.reduce((s, a) => s + a.commits, 0);
  if (total <= 0 || perAuthor.length === 0) {
    return { topShare: 0, fragmentation: 0, minorContributors: 0 };
  }

  let maxCommits = 0;
  let minorContributors = 0;
  for (const { commits } of perAuthor) {
    if (commits > maxCommits) {
      maxCommits = commits;
    }
    if (commits / total < minorThreshold) {
      minorContributors += 1;
    }
  }

  const topShare = maxCommits / total;
  return { topShare, fragmentation: 1 - topShare, minorContributors };
}

/**
 * Per-path ownership fragmentation for a whole repo, ready to pass straight to
 * the scorer as `computeRisk(churn, complexity, { ownership: buildOwnership(churn) })`.
 * Each value is `1 − topAuthorShare` for that file (0 when ownership is unknown).
 */
export function buildOwnership(
  churn: ChurnMap,
  minorThreshold: number = DEFAULT_MINOR_THRESHOLD,
): Map<string, number> {
  const ownership = new Map<string, number>();
  for (const [path, fc] of churn) {
    ownership.set(path, ownershipStats(fc, minorThreshold).fragmentation);
  }
  return ownership;
}
