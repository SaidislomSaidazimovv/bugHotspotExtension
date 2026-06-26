/**
 * Bug-fix commit classifier (RESEARCH.md §4).
 *
 * A pure, keyword + issue-reference heuristic that decides whether a commit
 * *subject* describes a bug fix. RESEARCH §4 reports this style of classifier
 * reaches ~90%+ agreement with manual labelling, which is enough to drive the
 * `bugfix_density` signal feeding the risk score (ADR-2).
 *
 * Standalone for now: a later integration task wires it into the git reader
 * (capturing `%s`) and the scorer's `bugfixDensity` hook. Pure module — NO
 * `vscode` import (ADR-1).
 */

/**
 * Fix / bug keyword match (RESEARCH §4).
 *
 * NOTE (deviation from the brief's literal regex, flagged for review): the
 * brief's keyword pattern `\b(fix(e[sd])?|bug|…)\b` cannot match the single
 * token `bugfix` — there is no word boundary between `bug` and `fix`, so
 * neither the `bug` nor the `fix` alternative matches. The acceptance criteria
 * require `bugfix` → true while `bugbear`/`prefix`/`suffix` → false, so an
 * explicit `bugfix(e[sd])?` alternative is added. Word boundaries still exclude
 * the false-positive tokens (`\bbug\b` rejects `bugbear`, `\bfix\b` rejects
 * `prefix`/`suffix`).
 */
const BUGFIX_KEYWORD =
  /\b(bugfix(e[sd])?|fix(e[sd])?|bug|defect|fault|crash|hotfix|patch|regression|broke(n)?)\b/i;

/** Issue-closing reference, e.g. "closes #12", "fixes #3", "resolved #99" (RESEARCH §4). */
const ISSUE_CLOSE = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i;

/**
 * Exclusions: merge / cherry-pick / revert commits are not themselves bug
 * fixes even when their subject quotes a fix (e.g. `Revert "fix crash"`).
 * (RESEARCH §4 — avoid double-counting / inverted signals.)
 */
const EXCLUDE = /\b(merge|cherry[- ]pick|revert)\b/i;

/**
 * True when `subject` looks like a bug-fix commit: it matches a fix/bug keyword
 * OR an issue-closing reference, AND is not a merge/cherry-pick/revert.
 */
export function isBugfixCommit(subject: string): boolean {
  if (EXCLUDE.test(subject)) {
    return false;
  }
  return BUGFIX_KEYWORD.test(subject) || ISSUE_CLOSE.test(subject);
}

/**
 * Fraction of a file's commits that were bug fixes. Pure helper the future
 * gitReader/scorer integration uses per file; guards division by zero.
 */
export function computeBugfixDensity(bugfixCount: number, totalCount: number): number {
  return totalCount > 0 ? bugfixCount / totalCount : 0;
}
