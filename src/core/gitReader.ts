// Git churn reader — PURE core (no 'vscode' import).
//
// Spawns a single streamed `git log --numstat` pass and aggregates it into a
// ChurnMap. The spawn is isolated behind an injectable GitLogRunner so the
// parser can be unit-tested against a fixture without a real repository.

import { spawn } from 'node:child_process';
import { isBugfixCommit } from './bugfix';
import type { ChurnMap, FileChurn, GitReaderOptions } from './types';

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

// Internal accumulator. Tracks author *names* in a Set and compares dates by
// epoch ms (offsets vary), materializing the public FileChurn shape on finalize.
// Date bounds start at ±Infinity so commits with an unparseable %aI (dateMs =
// NaN) are simply skipped for first/last-seen instead of poisoning the bounds.
interface ChurnAcc {
  path: string;
  commits: number;
  bugfixCommits: number;
  linesAdded: number;
  linesDeleted: number;
  authors: Set<string>;
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

  /** Feed one complete line (no trailing newline). Order-independent. */
  pushLine(line: string): void {
    if (line === '') {
      return;
    }
    if (line.includes(NUL)) {
      const [, author = '', date = '', subject = ''] = line.split(NUL);
      this.current = {
        author,
        date,
        dateMs: Date.parse(date),
        isBugfix: isBugfixCommit(subject),
      };
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
    let acc = this.accs.get(path);
    if (!acc) {
      acc = {
        path,
        commits: 0,
        bugfixCommits: 0,
        linesAdded: 0,
        linesDeleted: 0,
        authors: new Set<string>(),
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
      acc.authors.add(ctx.author);
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

  finalize(): ChurnMap {
    const map: ChurnMap = new Map();
    for (const [path, acc] of this.accs) {
      const churn: FileChurn = {
        path: acc.path,
        commits: acc.commits,
        bugfixCommits: acc.bugfixCommits,
        linesAdded: acc.linesAdded,
        linesDeleted: acc.linesDeleted,
        authors: [...acc.authors],
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
  return agg.finalize();
}
