import { spawn } from 'node:child_process';

// Working-Set Risk Lens git runner (S8-B) — host layer (ADR-1: no analysis here).
//
// This is a SEPARATE, on-demand `git` spawn used only by the diff-time lens; it is
// NEVER folded into the `core/gitReader.ts` single `git log` pass (ADR-4). To keep
// the extension's "100% local & offline" guarantee intact even as this new runner
// is added, the subcommand is LOCKED to a read-only whitelist: any command that
// could touch the network (`fetch` / `pull` / `remote` / `clone` / `push` …) is
// physically unreachable through this module — it throws before spawning.
//
// Every invocation also passes `-c core.quotepath=false` so non-ASCII / spaced
// paths come back verbatim (octal-escaped paths would silently miss the join
// against the scan's ChurnMap keys, especially on the maintainer's Windows box).

/**
 * The ONLY git subcommands this runner may execute — all local, read-only, and
 * sufficient for the working-set diff:
 *   - `diff`       → list changed paths vs HEAD / a merge-base
 *   - `merge-base` → find the branch divergence point (branch-vs-base mode)
 *   - `rev-parse`  → resolve a ref / verify we're inside a work tree
 * Anything else (notably anything that hits a remote) is rejected.
 */
export const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff',
  'merge-base',
  'rev-parse',
]);

/** Result of a locked git invocation. */
export interface GitRunResult {
  /** Process exit code (null if it was killed). */
  code: number | null;
  /** Trimmed stdout (UTF-8). */
  stdout: string;
}

/** Raised when a caller tries to run a subcommand outside the whitelist. */
export class DisallowedGitCommandError extends Error {
  constructor(subcommand: string) {
    super(
      `git '${subcommand}' is not allowed by the working-set runner ` +
        `(only ${[...ALLOWED_GIT_SUBCOMMANDS].join(', ')} are permitted — offline guarantee).`,
    );
    this.name = 'DisallowedGitCommandError';
  }
}

/**
 * Build the full argv for a git invocation. `-c core.quotepath=false` is forced
 * into the first two positions — ahead of the subcommand — so a caller can never
 * override it and non-ASCII/spaced paths come back verbatim. Exported for tests.
 */
export function buildGitArgs(args: readonly string[]): string[] {
  return ['-c', 'core.quotepath=false', ...args];
}

/** Hard ceiling on a single git invocation; a wedged/hung child is killed past this. */
export const GIT_RUN_TIMEOUT_MS = 10_000;

/**
 * Run a whitelisted, read-only `git` subcommand in `repoRoot` and resolve with its
 * exit code + trimmed stdout. Rejects (before any spawn) when `args[0]` is not in
 * {@link ALLOWED_GIT_SUBCOMMANDS}, and on spawn error. `-c core.quotepath=false`
 * is injected ahead of the subcommand so it cannot be overridden by the caller.
 * Hardened: stderr is drained (an unread stderr pipe can fill its OS buffer and
 * deadlock the child) and a {@link GIT_RUN_TIMEOUT_MS} timeout kills a hung git so
 * the promise can never hang forever.
 */
export function runGitReadOnly(repoRoot: string, args: readonly string[]): Promise<GitRunResult> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(new DisallowedGitCommandError(String(subcommand)));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', buildGitArgs(args), { cwd: repoRoot });
    let out = '';
    let settled = false;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    // Kill a hung/wedged git so the promise never hangs forever; resolve with what
    // we have (a null code is treated by callers as "no result" → []).
    const timer = setTimeout(() => {
      child.kill();
      settle(() => resolve({ code: null, stdout: out.trim() }));
    }, GIT_RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    // Drain stderr — a full, unread stderr pipe blocks the child's write and the
    // 'close' event never fires (classic Node pipe deadlock). We don't need it.
    child.stderr.resume();
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', (code) => settle(() => resolve({ code, stdout: out.trim() })));
  });
}

/** Normalize a git-reported path to the forward-slash, repo-relative ChurnMap key form. */
function toRepoKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Split `git … --name-only` stdout into clean, forward-slash repo-relative paths. */
export function parseNameOnly(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(toRepoKey);
}

/** Options for {@link getWorkingSetPaths}. */
export interface WorkingSetQuery {
  /**
   * When set, compare the branch against its merge-base with this ref instead of
   * the default `HEAD` working-tree diff (PR-review mode). Falls back to the
   * working-tree diff if the merge-base cannot be resolved.
   */
  baseRef?: string;
}

/**
 * The current working set as forward-slash, repo-relative paths.
 *
 * Default (no `baseRef`): `git diff HEAD --name-only -M` — the union of staged AND
 * unstaged changes versus HEAD, with rename detection (`-M`). Branch mode
 * (`baseRef` set): diff against `merge-base(HEAD, baseRef)` so a whole feature
 * branch can be reviewed. Returns `[]` (never throws) when git is unavailable, the
 * folder is not a repo, or there are no changes.
 */
export async function getWorkingSetPaths(
  repoRoot: string,
  query: WorkingSetQuery = {},
): Promise<string[]> {
  try {
    let range: string | undefined;
    if (query.baseRef) {
      // `--end-of-options` so a `baseRef` beginning with `-` cannot smuggle a flag
      // into merge-base (defense-in-depth; an old git lacking the token simply
      // errors → code≠0 → we fall back to the HEAD diff below).
      const mb = await runGitReadOnly(repoRoot, [
        'merge-base',
        '--end-of-options',
        'HEAD',
        query.baseRef,
      ]);
      if (mb.code === 0 && mb.stdout.length > 0) {
        range = mb.stdout;
      }
    }
    const diffArgs = range
      ? ['diff', range, '--name-only', '-M']
      : ['diff', 'HEAD', '--name-only', '-M'];
    const res = await runGitReadOnly(repoRoot, diffArgs);
    if (res.code !== 0) {
      return [];
    }
    // De-dup while preserving order (a path can't appear twice from one diff, but
    // be defensive in case staged ∪ unstaged ever surfaces the same path).
    return [...new Set(parseNameOnly(res.stdout))];
  } catch {
    return []; // git missing / not a repo / disallowed (never happens here) → silence
  }
}
