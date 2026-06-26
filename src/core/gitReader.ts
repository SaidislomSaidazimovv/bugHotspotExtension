// Git churn reader — PURE core (no 'vscode' import).
//
// Spawns a single streamed `git log --numstat` pass and aggregates it into a
// ChurnMap. The spawn is isolated behind an injectable GitLogRunner so the
// parser can be unit-tested against a fixture without a real repository.

import { spawn } from 'node:child_process';
import { isBugfixCommit } from './bugfix';
import { coChangeKey } from './types';
import type { ChurnMap, CoChangeCount, FileChurn, GitReaderOptions } from './types';

/**
 * Default mega-commit cap for change-coupling pairing (RESEARCH §3.6): commits
 * touching more files than this are skipped when accumulating pairwise co-change
 * counts. Bulk reformats / vendoring / generated drops are noise and, at
 * O(files²) pairs, a single 2,000-file commit would emit ~2M pairs. Churn
 * (commits/lines) still counts these commits — only the pairing is skipped.
 */
export const MAX_FILES_PER_COMMIT = 50;

/**
 * Produces the raw `git log` stdout as a sequence of UTF-8 chunks. Chunk
 * boundaries are arbitrary (they may split a line), which is exactly what the
 * line buffering in {@link readChurn} is built to tolerate. Tests inject a
 * fake runner that yields fixture text instead of spawning git.
 */
export type GitLogRunner = (
  args: string[],
  opts: GitReaderOptions,
) => AsyncIterable<string>;

// The U+0000 byte git emits between header fields, used ONLY to PARSE output.
// It must never appear in argv: Node's spawn rejects any argument containing a
// NUL (ERR_INVALID_ARG_VALUE). The format request therefore uses git's literal
// `%x00` token (see GIT_LOG_FORMAT), which git expands to this byte in OUTPUT.
const NUL = '\u0000';

// `%H` full SHA · `%an` author name · `%aI` strict-ISO author date · `%s`
// commit subject (for bug-fix classification, RESEARCH §3.6/§4). `%x00` is the
// literal four-char token passed to git; git substitutes a real NUL between the
// fields in its output, so names/paths/subjects with any other char (spaces,
// `=>`, unicode) can't corrupt header parsing. `%s` is last so a subject
// containing a stray NUL-like sequence still can't shift earlier fields.
const GIT_LOG_FORMAT = '--format=%H%x00%an%x00%aI%x00%s';

/** Build the `git log` argument vector for the given options. */
export function buildGitLogArgs(opts: GitReaderOptions): string[] {
  const args = [
    // `-c` config overrides must precede the `log` subcommand.
    '-c',
    'core.quotepath=false', // emit unicode/CJK paths literally, not octal-escaped+quoted
    'log',
    '--no-merges',
    '-M', // pin rename detection so output is deterministic regardless of the
    //      user's global diff.renames config. Phase 4 refinement: `--follow`
    //      / `-C` for cross-file copy + full rename history.
    '--numstat',
    GIT_LOG_FORMAT,
  ];
  if (opts.since) {
    args.push(`--since=${opts.since}`);
  }
  if (opts.maxCommits !== undefined) {
    args.push(`--max-count=${opts.maxCommits}`);
  }
  return args;
}

/** Default runner: streams stdout from a real `git` child process. */
export const spawnGitRunner: GitLogRunner = async function* (args, opts) {
  const child = spawn('git', args, { cwd: opts.repoRoot });
  child.stdout.setEncoding('utf8');

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  // Surface spawn/exit failures as a rejected iteration.
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`git log exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });

  for await (const chunk of child.stdout) {
    yield chunk as string;
  }
  await done;
};

/**
 * Resolve git's inline rename notation in a numstat path to the *new* path:
 *   - braced:   `src/{old => new}/util.ts`  → `src/new/util.ts`
 *   - braced add/remove: `src/{ => sub}/a.ts` / `src/{old => }/a.ts`
 *   - full:     `lib/a.ts => lib/b.ts`       → `lib/b.ts`
 * Non-rename paths pass through unchanged. The split is gated on the spaced
 * ` => ` git always emits, so a bare `=>` inside a real filename is preserved.
 */
export function resolveRenamePath(raw: string): string {
  let path = raw;
  if (path.includes('{') && path.includes(' => ')) {
    // Replace each `{old => new}` brace segment with just `new`.
    path = path.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1');
    // An emptied side (`{old => }`) leaves a doubled slash; collapse it.
    path = path.replace(/\/{2,}/g, '/');
  } else if (path.includes(' => ')) {
    path = path.slice(path.lastIndexOf(' => ') + ' => '.length);
  }
  return path.trim();
}

// Internal accumulator. Tracks per-author commit COUNTS in a Map (name → count)
// so finalize can emit both the distinct-name list and the ownership-fragmentation
// input (authorCommits); compares dates by epoch ms (offsets vary), materializing
// the public FileChurn shape on finalize. Date bounds start at ±Infinity so
// commits with an unparseable %aI (dateMs = NaN) are simply skipped for
// first/last-seen instead of poisoning the bounds.
interface ChurnAcc {
  path: string;
  commits: number;
  bugfixCommits: number;
  linesAdded: number;
  linesDeleted: number;
  authorCommits: Map<string, number>;
  firstSeenMs: number;
  firstSeen: string;
  lastSeenMs: number;
  lastSeen: string;
}

interface CommitCtx {
  author: string;
  date: string;
  dateMs: number;
  /** Whether this commit's subject (`%s`) classifies as a bug fix. */
  isBugfix: boolean;
}

/** A stateful, streaming line consumer that aggregates into a ChurnMap. */
class ChurnAggregator {
  private readonly accs = new Map<string, ChurnAcc>();
  private current: CommitCtx | null = null;

  // Change-coupling state (only populated when `trackCoChange`): the distinct
  // paths touched by the commit currently being parsed, flushed into pairwise
  // co-change counts at each commit boundary (RESEARCH §3.6).
  private readonly trackCoChange: boolean;
  private readonly maxFilesPerCommit: number;
  private readonly coChange: CoChangeCount = new Map();
  private currentFiles: Set<string> | null = null;

  constructor(opts: { trackCoChange?: boolean; maxFilesPerCommit?: number } = {}) {
    this.trackCoChange = opts.trackCoChange ?? false;
    this.maxFilesPerCommit = opts.maxFilesPerCommit ?? MAX_FILES_PER_COMMIT;
  }

  /** Feed one complete line (no trailing newline). Order-independent. */
  pushLine(line: string): void {
    if (line === '') {
      return;
    }
    if (line.includes(NUL)) {
      // New commit header → close out the previous commit's co-change pairs.
      this.flushCoChange();
      const [, author = '', date = '', subject = ''] = line.split(NUL);
      this.current = {
        author,
        date,
        dateMs: Date.parse(date),
        isBugfix: isBugfixCommit(subject),
      };
      if (this.trackCoChange) {
        this.currentFiles = new Set();
      }
      return;
    }
    // numstat row: added<TAB>deleted<TAB>path. `-` marks a binary edit.
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0 || !this.current) {
      return; // not a row we recognize (e.g. stray header text)
    }
    const addedRaw = line.slice(0, tab1);
    const deletedRaw = line.slice(tab1 + 1, tab2);
    const path = resolveRenamePath(line.slice(tab2 + 1));
    if (!path) {
      return;
    }
    // `-` is binary; any non-numeric is coerced to 0 rather than poisoning sums.
    const added = addedRaw === '-' ? 0 : Number(addedRaw) || 0;
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw) || 0;
    this.record(path, added, deleted, this.current);
  }

  private record(path: string, added: number, deleted: number, ctx: CommitCtx): void {
    // Track this path as part of the current commit's file set (for co-change).
    this.currentFiles?.add(path);

    let acc = this.accs.get(path);
    if (!acc) {
      acc = {
        path,
        commits: 0,
        bugfixCommits: 0,
        linesAdded: 0,
        linesDeleted: 0,
        authorCommits: new Map<string, number>(),
        firstSeenMs: Infinity,
        firstSeen: '',
        lastSeenMs: -Infinity,
        lastSeen: '',
      };
      this.accs.set(path, acc);
    }
    acc.commits += 1;
    if (ctx.isBugfix) {
      acc.bugfixCommits += 1;
    }
    acc.linesAdded += added;
    acc.linesDeleted += deleted;
    if (ctx.author) {
      // One numstat row = this commit touching this path once, attributed to
      // its single author → increment that author's count for the file.
      acc.authorCommits.set(ctx.author, (acc.authorCommits.get(ctx.author) ?? 0) + 1);
    }
    // Skip unparseable dates so one bad %aI can't freeze the bounds.
    if (Number.isFinite(ctx.dateMs)) {
      if (ctx.dateMs < acc.firstSeenMs) {
        acc.firstSeenMs = ctx.dateMs;
        acc.firstSeen = ctx.date;
      }
      if (ctx.dateMs > acc.lastSeenMs) {
        acc.lastSeenMs = ctx.dateMs;
        acc.lastSeen = ctx.date;
      }
    }
  }

  /**
   * Emit pairwise co-change counts for the just-finished commit. Skips commits
   * with < 2 touched files (no pair) and mega-commits over the cap (noise +
   * O(files²) blowup — see {@link MAX_FILES_PER_COMMIT}). Each unordered pair
   * gets +1 via the canonical {@link coChangeKey}.
   */
  private flushCoChange(): void {
    const files = this.currentFiles;
    this.currentFiles = null;
    if (!this.trackCoChange || !files) {
      return;
    }
    const paths = [...files];
    if (paths.length < 2 || paths.length > this.maxFilesPerCommit) {
      return;
    }
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = coChangeKey(paths[i], paths[j]);
        this.coChange.set(key, (this.coChange.get(key) ?? 0) + 1);
      }
    }
  }

  /** Co-change counts accumulated so far. Call after {@link finalize}. */
  getCoChange(): CoChangeCount {
    return this.coChange;
  }

  finalize(): ChurnMap {
    // Flush the final commit's pairs (no trailing header triggers it otherwise).
    this.flushCoChange();
    const map: ChurnMap = new Map();
    for (const [path, acc] of this.accs) {
      const churn: FileChurn = {
        path: acc.path,
        commits: acc.commits,
        bugfixCommits: acc.bugfixCommits,
        linesAdded: acc.linesAdded,
        linesDeleted: acc.linesDeleted,
        authors: [...acc.authorCommits.keys()],
        authorCommits: [...acc.authorCommits].map(([name, commits]) => ({ name, commits })),
        firstSeen: acc.firstSeen,
        lastSeen: acc.lastSeen,
      };
      map.set(path, churn);
    }
    return map;
  }
}

/**
 * Parse a complete `git log --numstat` text blob into a ChurnMap. Exposed for
 * direct, fixture-driven unit testing; {@link readChurn} streams into the same
 * aggregator instead of buffering the whole output.
 */
export function parseGitLog(text: string): ChurnMap {
  const agg = new ChurnAggregator();
  for (const line of text.split('\n')) {
    agg.pushLine(line);
  }
  return agg.finalize();
}

/**
 * Like {@link parseGitLog} but also accumulates change-coupling co-change counts
 * (RESEARCH §3.6). Exposed for fixture-driven unit testing of the pairing +
 * mega-commit cap; {@link readChurnWithCoupling} streams into the same path.
 */
export function parseGitLogWithCoupling(
  text: string,
  opts: { maxFilesPerCommit?: number } = {},
): { churn: ChurnMap; coChange: CoChangeCount } {
  const agg = new ChurnAggregator({
    trackCoChange: true,
    maxFilesPerCommit: opts.maxFilesPerCommit,
  });
  for (const line of text.split('\n')) {
    agg.pushLine(line);
  }
  const churn = agg.finalize();
  return { churn, coChange: agg.getCoChange() };
}

/** Stream a runner's chunked output into an aggregator, buffering by line. */
async function streamInto(
  agg: ChurnAggregator,
  opts: GitReaderOptions,
  runner: GitLogRunner,
): Promise<void> {
  let buffer = '';
  for await (const chunk of runner(buildGitLogArgs(opts), opts)) {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      agg.pushLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    agg.pushLine(buffer); // trailing line with no final newline
  }
}

/**
 * Read git history and aggregate it into a {@link ChurnMap}.
 *
 * @param opts    repo root and optional `since` / `maxCommits` filters.
 * @param runner  source of raw `git log` output; defaults to spawning git.
 *                Inject a fake runner in tests to parse a fixture.
 */
export async function readChurn(
  opts: GitReaderOptions,
  runner: GitLogRunner = spawnGitRunner,
): Promise<ChurnMap> {
  const agg = new ChurnAggregator();
  await streamInto(agg, opts, runner);
  return agg.finalize();
}

/**
 * Read git history in ONE pass, returning both the {@link ChurnMap} and the
 * pairwise {@link CoChangeCount} for the change-coupling signal (RESEARCH §3.6).
 * The returned `churn` is identical to {@link readChurn}'s — co-change pairing
 * is purely additive and the mega-commit cap affects only the pairing, never the
 * churn aggregation — so callers can swap this in without changing churn output.
 *
 * @param opts    as {@link readChurn}, plus optional `maxFilesPerCommit`.
 * @param runner  source of raw `git log` output; defaults to spawning git.
 */
export async function readChurnWithCoupling(
  opts: GitReaderOptions,
  runner: GitLogRunner = spawnGitRunner,
): Promise<{ churn: ChurnMap; coChange: CoChangeCount }> {
  const agg = new ChurnAggregator({
    trackCoChange: true,
    maxFilesPerCommit: opts.maxFilesPerCommit,
  });
  await streamInto(agg, opts, runner);
  const churn = agg.finalize();
  return { churn, coChange: agg.getCoChange() };
}
