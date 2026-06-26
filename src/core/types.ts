// Analysis-core DTOs. This module is part of the PURE core layer:
// it MUST NOT import 'vscode' (or any host-only API). Keep it serializable.

/**
 * Aggregated change history for a single file path, derived from `git log`.
 * Dates are strict ISO-8601 strings (git `%aI`) and may carry differing
 * timezone offsets, so compare them by parsed timestamp, not lexically.
 */
export interface FileChurn {
  /** Repo-relative path (post-rename — see {@link readChurn}). */
  path: string;
  /** Number of non-merge commits that touched this path. */
  commits: number;
  /**
   * How many of those commits were bug fixes (git `%s` classified by
   * {@link isBugfixCommit}). `bugfixCommits / commits` is the bug-fix density
   * feeding the risk score (RESEARCH §3.6).
   */
  bugfixCommits: number;
  /** Sum of added lines across those commits (binary edits count as 0). */
  linesAdded: number;
  /** Sum of deleted lines across those commits (binary edits count as 0). */
  linesDeleted: number;
  /** Distinct author names (git `%an`) that touched this path. */
  authors: string[];
  /**
   * Per-author commit counts touching this path (git `%an` → count). Each
   * non-merge commit touching the file is attributed to exactly one author, so
   * `sum(authorCommits[].commits) === commits`. Powers the ownership-fragmentation
   * signal (RESEARCH §1 "Ownership concentration"; Bird et al. 2011, "Don't
   * Touch My Code") — see {@link ownershipStats}. Additive over the `authors`
   * name list, which is retained for back-compat.
   */
  authorCommits: Array<{ name: string; commits: number }>;
  /** ISO-8601 date of the earliest commit touching this path. */
  firstSeen: string;
  /** ISO-8601 date of the most recent commit touching this path. */
  lastSeen: string;
}

/**
 * The churn signal for a whole repository, keyed by repo-relative path.
 * A Map keeps aggregation O(1) per row and lookups ergonomic for the host
 * layer; callers that need a plain object can `Object.fromEntries(map)`.
 */
export type ChurnMap = Map<string, FileChurn>;

/** Inputs to {@link readChurn}. */
export interface GitReaderOptions {
  /** Absolute path to the repository root (used as the git `cwd`). */
  repoRoot: string;
  /**
   * Lower bound on commit date, passed straight to `git log --since`.
   * Accepts any git-approxidate value (e.g. `"3 months ago"`, an ISO date).
   */
  since?: string;
  /** Cap the number of commits walked, via `git log --max-count`. */
  maxCommits?: number;
}
