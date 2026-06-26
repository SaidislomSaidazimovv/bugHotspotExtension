// Unit tests for the pure git churn reader. The parser is driven by the
// committed fixture via an injected runner; a separate suite exercises the REAL
// `git` spawn path so an argv-level regression (e.g. a NUL byte in --format)
// can't pass review again.
//
// Runner: Vitest (the project's `unit` script: `vitest run src/test/core`).
//   npm run unit
//   npx vitest run src/test/core/gitReader.test.ts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseGitLog,
  parseGitLogWithCoupling,
  readChurn,
  readChurnWithCoupling,
  buildGitLogArgs,
  resolveRenamePath,
  type GitLogRunner,
} from '../../core/gitReader';
import { coChangeKey } from '../../core/types';
import type { ChurnMap } from '../../core/types';

// Resolved from the package root, where Vitest sets cwd. Read as latin1 so the
// NUL header separators in the fixture survive intact as U+0000 characters.
const FIXTURE = readFileSync(
  resolve('src/test/fixtures/git-log-sample.txt'),
  'latin1',
);

const NUL = '\u0000'; // git's header-field separator; used to craft test input below

/** A GitLogRunner that replays fixture text in fixed-size chunks, deliberately
 *  slicing across line and field boundaries to exercise stream buffering. */
function chunkedRunner(text: string, size: number): GitLogRunner {
  return async function* () {
    for (let i = 0; i < text.length; i += size) {
      yield text.slice(i, i + size);
    }
  };
}

function expectChurn(map: ChurnMap, path: string) {
  const churn = map.get(path);
  expect(churn, `expected churn entry for ${path}`).toBeDefined();
  return churn!;
}

describe('parseGitLog (fixture aggregation)', () => {
  const map = parseGitLog(FIXTURE);

  it('aggregates commits, line sums and authors across commits', () => {
    const reader = expectChurn(map, 'src/core/gitReader.ts');
    expect(reader.commits).toBe(2);
    expect(reader.linesAdded).toBe(13); // 10 + 3
    expect(reader.linesDeleted).toBe(3); // 2 + 1
    expect([...reader.authors].sort()).toEqual(['Alice Smith', 'Bob Jones']);
  });

  it('captures per-author commit counts (ownership signal input)', () => {
    // gitReader.ts: Alice (commit1) + Bob (commit2) → one each.
    const reader = expectChurn(map, 'src/core/gitReader.ts');
    const byName = new Map(reader.authorCommits.map((a) => [a.name, a.commits]));
    expect(byName.get('Alice Smith')).toBe(1);
    expect(byName.get('Bob Jones')).toBe(1);
    // sum(authorCommits) === commits, and names mirror `authors`.
    expect(reader.authorCommits.reduce((s, a) => s + a.commits, 0)).toBe(reader.commits);
    expect(reader.authorCommits.map((a) => a.name).sort()).toEqual([...reader.authors].sort());

    // Single-author single-commit file → exactly one entry of 1.
    expect(expectChurn(map, 'src/core/types.ts').authorCommits).toEqual([
      { name: 'Alice Smith', commits: 1 },
    ]);
    // Binary-only touch still attributes the commit to its author.
    expect(expectChurn(map, 'assets/logo.png').authorCommits).toEqual([
      { name: 'Bob Jones', commits: 1 },
    ]);
  });

  it('counts bug-fix commits per file from the subject (%s)', () => {
    // commit1 "fix null deref in parser" = bugfix; commit2 "add logo asset" = not.
    // gitReader.ts touched by both → 1/2; types.ts only by commit1 → 1/1.
    expect(expectChurn(map, 'src/core/gitReader.ts').bugfixCommits).toBe(1);
    expect(expectChurn(map, 'src/core/types.ts').bugfixCommits).toBe(1);
    // commit4 "fixes #42 broken link" = bugfix → README.md + lib/b.ts.
    expect(expectChurn(map, 'README.md').bugfixCommits).toBe(1);
    expect(expectChurn(map, 'lib/b.ts').bugfixCommits).toBe(1);
    // commit2 "add logo asset" and commit3 "refactor util helpers" = not bugfixes.
    expect(expectChurn(map, 'assets/logo.png').bugfixCommits).toBe(0);
    expect(expectChurn(map, 'src/core/new/util.ts').bugfixCommits).toBe(0);
  });

  it('tracks first/last seen by parsed timestamp, not lexically (mixed offsets)', () => {
    // commit2 (14:00+09:00 = 05:00 UTC) is chronologically EARLIER than commit1
    // (10:00 UTC) but its ISO string sorts LATER. A lexical min/max would flip
    // these; the timestamp comparison must not.
    const reader = expectChurn(map, 'src/core/gitReader.ts');
    expect(reader.firstSeen).toBe('2026-06-20T14:00:00+09:00');
    expect(reader.lastSeen).toBe('2026-06-20T10:00:00+00:00');
  });

  it('records a single-commit file with one author', () => {
    const types = expectChurn(map, 'src/core/types.ts');
    expect(types.commits).toBe(1);
    expect(types.linesAdded).toBe(5);
    expect(types.linesDeleted).toBe(0);
    expect(types.authors).toEqual(['Alice Smith']);
    expect(types.firstSeen).toBe(types.lastSeen);
  });

  it('treats binary edits (-\\t-) as 0 lines but still a commit touch', () => {
    const logo = expectChurn(map, 'assets/logo.png');
    expect(logo.commits).toBe(1);
    expect(logo.linesAdded).toBe(0);
    expect(logo.linesDeleted).toBe(0);
    expect(logo.authors).toEqual(['Bob Jones']);
  });

  it('attributes a braced rename to the new path', () => {
    expect(map.has('src/core/{old => new}/util.ts')).toBe(false);
    expect(map.has('src/core/old/util.ts')).toBe(false);
    const util = expectChurn(map, 'src/core/new/util.ts');
    expect(util.commits).toBe(1);
    expect(util.linesAdded).toBe(2);
    expect(util.linesDeleted).toBe(1);
  });

  it('attributes a full-path rename to the new path', () => {
    expect(map.has('lib/a.ts')).toBe(false);
    const renamed = expectChurn(map, 'lib/b.ts');
    expect(renamed.commits).toBe(1);
    expect(renamed.linesAdded).toBe(4);
    expect(renamed.linesDeleted).toBe(4);
    expect(renamed.authors).toEqual(['Carol Lee']);
  });

  it('covers exactly the distinct post-rename paths in the fixture', () => {
    expect([...map.keys()].sort()).toEqual([
      'README.md',
      'assets/logo.png',
      'lib/b.ts',
      'src/core/gitReader.ts',
      'src/core/new/util.ts',
      'src/core/types.ts',
    ]);
  });
});

describe('parseGitLog (unparseable %aI guard)', () => {
  it('keeps the valid date when one of a file’s commits has a bad date', () => {
    const log =
      `aaa${NUL}Dana${NUL}not-a-date\n\n1\t1\tfoo.ts\n\n` +
      `bbb${NUL}Eve${NUL}2026-01-02T03:04:05+00:00\n\n2\t0\tfoo.ts\n`;
    const foo = expectChurn(parseGitLog(log), 'foo.ts');
    expect(foo.commits).toBe(2);
    expect(foo.linesAdded).toBe(3);
    expect(foo.firstSeen).toBe('2026-01-02T03:04:05+00:00');
    expect(foo.lastSeen).toBe('2026-01-02T03:04:05+00:00');
  });

  it('does not throw or freeze bounds when every date is unparseable', () => {
    const log = `ccc${NUL}Frank${NUL}garbage\n\n5\t5\tbar.ts\n`;
    const bar = expectChurn(parseGitLog(log), 'bar.ts');
    expect(bar.commits).toBe(1);
    expect(bar.linesAdded).toBe(5);
    expect(bar.firstSeen).toBe('');
    expect(bar.lastSeen).toBe('');
  });
});

describe('readChurn (streamed via injected runner)', () => {
  it('produces the same ChurnMap as parseGitLog over arbitrary chunk sizes', async () => {
    const expected = parseGitLog(FIXTURE);
    for (const size of [1, 7, 64, 10_000]) {
      const got = await readChurn({ repoRoot: '/unused' }, chunkedRunner(FIXTURE, size));
      expect(got, `chunk size ${size} should not change parsing`).toEqual(expected);
    }
  });

  it('handles output with no trailing newline', async () => {
    const trimmed = FIXTURE.replace(/\n+$/, '');
    const got = await readChurn({ repoRoot: '/unused' }, chunkedRunner(trimmed, 13));
    expect(expectChurn(got, 'README.md').linesAdded).toBe(7);
  });

  it('propagates runner errors', async () => {
    const boom: GitLogRunner = async function* () {
      throw new Error('git missing');
      yield '';
    };
    await expect(readChurn({ repoRoot: '/unused' }, boom)).rejects.toThrow('git missing');
  });
});

describe('readChurn (real git spawn — exercises the default runner end-to-end)', () => {
  it('spawns git against this repo and returns a non-empty, well-formed ChurnMap', async () => {
    // Regression guard: a NUL byte in the --format argv would make spawn throw
    // ERR_INVALID_ARG_VALUE here. Uses the real spawnGitRunner (no injection).
    const map = await readChurn({ repoRoot: process.cwd() });
    expect(map.size).toBeGreaterThan(0);
    for (const churn of map.values()) {
      expect(typeof churn.path).toBe('string');
      expect(churn.path.length).toBeGreaterThan(0);
      expect(churn.commits).toBeGreaterThan(0);
      expect(Array.isArray(churn.authors)).toBe(true);
      expect(churn.authors.length).toBeGreaterThan(0);
      // per-author counts are well-formed and sum to the commit total
      expect(Array.isArray(churn.authorCommits)).toBe(true);
      expect(churn.authorCommits.length).toBe(churn.authors.length);
      expect(churn.authorCommits.every((a) => typeof a.name === 'string' && a.commits > 0)).toBe(true);
      expect(churn.authorCommits.reduce((s, a) => s + a.commits, 0)).toBe(churn.commits);
      // subject (%s) is now captured → bugfixCommits is a real count, 0..commits.
      expect(typeof churn.bugfixCommits).toBe('number');
      expect(churn.bugfixCommits).toBeGreaterThanOrEqual(0);
      expect(churn.bugfixCommits).toBeLessThanOrEqual(churn.commits);
      // real commits have parseable dates
      expect(Number.isNaN(Date.parse(churn.lastSeen))).toBe(false);
    }
  });
});

describe('parseGitLogWithCoupling (change-coupling pairing)', () => {
  const { coChange } = parseGitLogWithCoupling(FIXTURE);

  it('counts each unordered co-change pair once per shared commit', () => {
    // commit1 touched gitReader.ts + types.ts together.
    expect(coChange.get(coChangeKey('src/core/gitReader.ts', 'src/core/types.ts'))).toBe(1);
    // commit2 touched gitReader.ts + logo.png together.
    expect(coChange.get(coChangeKey('assets/logo.png', 'src/core/gitReader.ts'))).toBe(1);
    // commit4 touched README.md + the renamed lib/b.ts together.
    expect(coChange.get(coChangeKey('README.md', 'lib/b.ts'))).toBe(1);
  });

  it('emits no pair for a single-file commit (commit3 = util.ts only)', () => {
    expect([...coChange.keys()].some((k) => k.includes('util.ts'))).toBe(false);
  });

  it('keeps churn identical to parseGitLog (pairing is purely additive)', () => {
    expect(parseGitLogWithCoupling(FIXTURE).churn).toEqual(parseGitLog(FIXTURE));
  });
});

describe('parseGitLogWithCoupling (mega-commit cap)', () => {
  const NUL = '\u0000';
  // One commit touching three files x/y/z.
  const log =
    `aaa${NUL}Dev${NUL}2026-01-01T00:00:00+00:00${NUL}bulk reformat\n\n` +
    `1\t0\tx.ts\n1\t0\ty.ts\n1\t0\tz.ts\n`;

  it('skips pairing for a commit over the cap but still counts its churn', () => {
    const capped = parseGitLogWithCoupling(log, { maxFilesPerCommit: 2 }); // 3 > 2
    expect(capped.coChange.size).toBe(0);
    expect(capped.churn.size).toBe(3); // churn unaffected by the cap
    expect(capped.churn.get('x.ts')!.commits).toBe(1);
  });

  it('emits all pairs when the commit is within the cap', () => {
    const within = parseGitLogWithCoupling(log, { maxFilesPerCommit: 3 }); // 3 ≤ 3
    expect(within.coChange.size).toBe(3); // xy, xz, yz
    expect(within.coChange.get(coChangeKey('x.ts', 'y.ts'))).toBe(1);
  });
});

describe('readChurnWithCoupling (streamed via injected runner)', () => {
  it('returns the same churn as readChurn plus the co-change counts', async () => {
    const { churn, coChange } = await readChurnWithCoupling(
      { repoRoot: '/unused' },
      chunkedRunner(FIXTURE, 7),
    );
    expect(churn).toEqual(await readChurn({ repoRoot: '/unused' }, chunkedRunner(FIXTURE, 7)));
    expect(coChange.get(coChangeKey('src/core/gitReader.ts', 'src/core/types.ts'))).toBe(1);
  });
});

describe('resolveRenamePath', () => {
  it('passes plain paths through unchanged', () => {
    expect(resolveRenamePath('src/core/types.ts')).toBe('src/core/types.ts');
  });

  it('resolves a braced mid-path rename to the new segment', () => {
    expect(resolveRenamePath('src/core/{old => new}/util.ts')).toBe('src/core/new/util.ts');
  });

  it('resolves a braced add (empty old side)', () => {
    expect(resolveRenamePath('src/{ => sub}/a.ts')).toBe('src/sub/a.ts');
  });

  it('resolves a braced remove (empty new side), collapsing the slash', () => {
    expect(resolveRenamePath('src/{old => }/a.ts')).toBe('src/a.ts');
  });

  it('resolves a full-path rename to the right-hand side', () => {
    expect(resolveRenamePath('lib/a.ts => lib/b.ts')).toBe('lib/b.ts');
  });

  it('preserves a bare "=>" inside a real filename (no spaces → not a rename)', () => {
    expect(resolveRenamePath('src/a=>b.ts')).toBe('src/a=>b.ts');
  });
});

describe('buildGitLogArgs', () => {
  it('requests the %x00 git token and contains NO real NUL byte in any arg', () => {
    const args = buildGitLogArgs({ repoRoot: '/r' });
    expect(args).toContain('--format=%H%x00%an%x00%aI%x00%s');
    // spawn rejects any argv element containing U+0000 — this is the core fix.
    expect(args.every((a) => !a.includes(NUL))).toBe(true);
  });

  it('passes core.quotepath=false via -c before the log subcommand', () => {
    const args = buildGitLogArgs({ repoRoot: '/r' });
    const ci = args.indexOf('-c');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(args[ci + 1]).toBe('core.quotepath=false');
    expect(args.indexOf('log')).toBeGreaterThan(ci);
  });

  it('pins -M (rename detection) and streams numstat', () => {
    const args = buildGitLogArgs({ repoRoot: '/r' });
    expect(args).toContain('-M');
    expect(args).toContain('--no-merges');
    expect(args).toContain('--numstat');
  });

  it('omits --since / --max-count by default and appends them when provided', () => {
    const base = buildGitLogArgs({ repoRoot: '/r' });
    expect(base.some((a) => a.startsWith('--since='))).toBe(false);
    expect(base.some((a) => a.startsWith('--max-count='))).toBe(false);

    const filtered = buildGitLogArgs({
      repoRoot: '/r',
      since: '3 months ago',
      maxCommits: 500,
    });
    expect(filtered).toContain('--since=3 months ago');
    expect(filtered).toContain('--max-count=500');
  });
});
