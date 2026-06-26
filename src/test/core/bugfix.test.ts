import { describe, it, expect } from 'vitest';
import { isBugfixCommit, computeBugfixDensity } from '../../core/bugfix';

describe('isBugfixCommit', () => {
  it('matches plain fix words (fix / fixes / fixed / bugfix)', () => {
    expect(isBugfixCommit('fix null pointer in parser')).toBe(true);
    expect(isBugfixCommit('Fixes off-by-one in loop')).toBe(true);
    expect(isBugfixCommit('fixed broken layout')).toBe(true);
    expect(isBugfixCommit('bugfix: handle empty input')).toBe(true);
    expect(isBugfixCommit('bugfixes for the importer')).toBe(true);
  });

  it('matches bug / defect / fault / crash / hotfix / patch / regression / broken', () => {
    expect(isBugfixCommit('bug in date handling')).toBe(true);
    expect(isBugfixCommit('defect in retry logic')).toBe(true);
    expect(isBugfixCommit('fault tolerance for nulls')).toBe(true);
    expect(isBugfixCommit('crash on startup')).toBe(true);
    expect(isBugfixCommit('hotfix for prod outage')).toBe(true);
    expect(isBugfixCommit('patch the leak')).toBe(true);
    expect(isBugfixCommit('regression after refactor')).toBe(true);
    expect(isBugfixCommit('broken pipe handling')).toBe(true);
    expect(isBugfixCommit('broke the date parser')).toBe(true);
  });

  it('matches issue-closing references', () => {
    expect(isBugfixCommit('closes #12')).toBe(true);
    expect(isBugfixCommit('Closed #7 finally')).toBe(true);
    expect(isBugfixCommit('fixes #3')).toBe(true);
    expect(isBugfixCommit('resolve #99 in the API')).toBe(true);
    expect(isBugfixCommit('resolved #1')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBugfixCommit('FIX crash')).toBe(true);
    expect(isBugfixCommit('BugFix the thing')).toBe(true);
    expect(isBugfixCommit('CLOSES #42')).toBe(true);
  });

  it('respects word boundaries (no false positives on substrings)', () => {
    expect(isBugfixCommit('prefix the config keys')).toBe(false);
    expect(isBugfixCommit('add suffix to filenames')).toBe(false);
    expect(isBugfixCommit('the bugbear of legacy code')).toBe(false);
    expect(isBugfixCommit('refactor the debugger output')).toBe(false);
  });

  it('excludes merge / cherry-pick / revert even when they quote a fix', () => {
    expect(isBugfixCommit('Merge branch "fix/crash" into dev')).toBe(false);
    expect(isBugfixCommit('Revert "fix the parser bug"')).toBe(false);
    expect(isBugfixCommit('cherry-pick fix for #5')).toBe(false);
    expect(isBugfixCommit('cherry pick the hotfix')).toBe(false);
  });

  it('returns false for empty / whitespace-only / non-fix subjects', () => {
    expect(isBugfixCommit('')).toBe(false);
    expect(isBugfixCommit('   \t  ')).toBe(false);
    expect(isBugfixCommit('add dark mode toggle')).toBe(false);
    expect(isBugfixCommit('update README')).toBe(false);
  });
});

describe('computeBugfixDensity', () => {
  it('returns the fraction of bug-fix commits', () => {
    expect(computeBugfixDensity(3, 10)).toBe(0.3);
    expect(computeBugfixDensity(1, 4)).toBe(0.25);
    expect(computeBugfixDensity(5, 5)).toBe(1);
    expect(computeBugfixDensity(0, 8)).toBe(0);
  });

  it('returns 0 when totalCount is 0 (no division by zero)', () => {
    expect(computeBugfixDensity(0, 0)).toBe(0);
    expect(computeBugfixDensity(3, 0)).toBe(0);
  });
});
