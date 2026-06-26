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
  /**
   * Time-decayed recency weight (S7-B1, RESEARCH §1 "code age / recency"):
   * the sum over this file's commits of `0.5 ^ (ageDays / 365)`, where `age` is
   * measured back from the newest commit in the walk (the reference date — see
   * {@link readChurn}). A commit on the reference date contributes 1; one a year
   * older contributes 0.5; etc. Recently-touched files therefore score higher.
   * Commits with an unparseable date contribute 0. Additive + serializable;
   * powers the `recency` term of the risk score.
   */
  recencyWeight: number;
  /**
   * Count of this file's commits within the recency window (90 days back from
   * the reference date — see {@link readChurn}). `recentCommits / commits` is the
   * input to the display-only trend classification (`rising | stable | cooling`,
   * S7-B1); it is NOT a scored signal. Commits with an unparseable date are not
   * counted. Additive + serializable.
   */
  recentCommits: number;
}

/**
 * The churn signal for a whole repository, keyed by repo-relative path.
 * A Map keeps aggregation O(1) per row and lookups ergonomic for the host
 * layer; callers that need a plain object can `Object.fromEntries(map)`.
 */
export type ChurnMap = Map<string, FileChurn>;

/**
 * Temporal co-change counts: how many commits touched a given *unordered pair*
 * of files together (RESEARCH §3.6 change coupling). Keyed by the canonical
 * pair key from {@link coChangeKey} (the two paths joined by a NUL, lexically
 * ordered) and valued by the shared-commit count. NUL is used as the separator
 * — not a space — because repo paths may legitimately contain spaces but never
 * a NUL byte, so the two paths are always recoverable via {@link splitCoChangeKey}.
 * Serializable as `[...map.entries()]`.
 */
export type CoChangeCount = Map<string, number>;

/** NUL separator for {@link CoChangeCount} pair keys (never appears in git paths). */
const CO_CHANGE_SEP = '\u0000';

/**
 * Canonical key for an unordered file pair in a {@link CoChangeCount}: the two
 * paths joined by a NUL, lexically ordered so `(a,b)` and `(b,a)` collide.
 */
export function coChangeKey(a: string, b: string): string {
  return a < b ? `${a}${CO_CHANGE_SEP}${b}` : `${b}${CO_CHANGE_SEP}${a}`;
}

/** Recover the two paths from a {@link coChangeKey}. */
export function splitCoChangeKey(key: string): [string, string] {
  const i = key.indexOf(CO_CHANGE_SEP);
  return [key.slice(0, i), key.slice(i + CO_CHANGE_SEP.length)];
}

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
  /**
   * Mega-commit cap for change-coupling pairing (RESEARCH §3.6): commits that
   * touch more than this many files are skipped when accumulating pairwise
   * co-change counts (bulk reformats / vendoring are noise and would blow up the
   * O(files²) pairing). Churn aggregation is unaffected. Default 50. Only
   * consulted by {@link readChurnWithCoupling}.
   */
  maxFilesPerCommit?: number;
}
