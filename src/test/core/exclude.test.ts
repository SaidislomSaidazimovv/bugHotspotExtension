// Unit tests for the pure glob-exclusion core (S7-A1). No git, no vscode.
// Runner: Vitest (`npm run unit`).

import { describe, it, expect } from 'vitest';

import { isExcluded, globToRegExp } from '../../core/exclude';

// The default `hotspot.exclude` list shipped in package.json — kept in sync here
// so the tests assert the real generated/vendored/lockfile coverage.
const DEFAULTS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
  '**/vendor/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

describe('isExcluded — defaults', () => {
  it('excludes node_modules at the root and nested', () => {
    expect(isExcluded('node_modules/lodash/index.js', DEFAULTS)).toBe(true);
    expect(isExcluded('packages/app/node_modules/x/y.js', DEFAULTS)).toBe(true);
  });

  it('excludes dist / build / out trees', () => {
    expect(isExcluded('dist/extension.js', DEFAULTS)).toBe(true);
    expect(isExcluded('src/build/thing.js', DEFAULTS)).toBe(true);
    expect(isExcluded('out/test/host/scan.test.js', DEFAULTS)).toBe(true);
  });

  it('excludes minified / bundled / sourcemap / vendor / lockfiles', () => {
    expect(isExcluded('public/app.min.js', DEFAULTS)).toBe(true);
    expect(isExcluded('public/app.bundle.js', DEFAULTS)).toBe(true);
    expect(isExcluded('dist/extension.js.map', DEFAULTS)).toBe(true);
    expect(isExcluded('third_party/vendor/jquery.js', DEFAULTS)).toBe(true);
    expect(isExcluded('Cargo.lock', DEFAULTS)).toBe(true);
    expect(isExcluded('package-lock.json', DEFAULTS)).toBe(true);
    expect(isExcluded('yarn.lock', DEFAULTS)).toBe(true);
    expect(isExcluded('pnpm-lock.yaml', DEFAULTS)).toBe(true);
  });

  it('does NOT exclude ordinary source files', () => {
    expect(isExcluded('src/core/scorer.ts', DEFAULTS)).toBe(false);
    expect(isExcluded('src/host/extension.ts', DEFAULTS)).toBe(false);
    expect(isExcluded('README.md', DEFAULTS)).toBe(false);
    // A file that merely *mentions* a token but isn't in that dir stays in.
    expect(isExcluded('src/distance.ts', DEFAULTS)).toBe(false);
    expect(isExcluded('src/outline.ts', DEFAULTS)).toBe(false);
  });
});

describe('isExcluded — semantics', () => {
  it('an empty / missing pattern list excludes nothing (disable state)', () => {
    expect(isExcluded('node_modules/x.js', [])).toBe(false);
    expect(isExcluded('dist/a.js', undefined as unknown as string[])).toBe(false);
  });

  it('normalizes OS separators and a leading ./', () => {
    expect(isExcluded('dist\\extension.js', DEFAULTS)).toBe(true);
    expect(isExcluded('./dist/extension.js', DEFAULTS)).toBe(true);
  });

  it('skips empty pattern entries defensively', () => {
    expect(isExcluded('src/a.ts', ['', 'src/a.ts'])).toBe(true);
    expect(isExcluded('src/b.ts', [''])).toBe(false);
  });

  it('matches any one of several patterns', () => {
    expect(isExcluded('dist/a.js', ['**/node_modules/**', '**/dist/**'])).toBe(true);
  });
});

describe('globToRegExp — operators', () => {
  it('* matches within a segment but not across /', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/sub/a.ts')).toBe(false);
  });

  it('** matches across path segments, including zero', () => {
    const re = globToRegExp('**/x.ts');
    expect(re.test('x.ts')).toBe(true);
    expect(re.test('a/b/x.ts')).toBe(true);
  });

  it('? matches exactly one non-slash char', () => {
    const re = globToRegExp('a?.ts');
    expect(re.test('ab.ts')).toBe(true);
    expect(re.test('a.ts')).toBe(false);
    expect(re.test('a/.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegExp('a.b+c.txt');
    expect(re.test('a.b+c.txt')).toBe(true);
    expect(re.test('aXbYc.txt')).toBe(false);
  });
});
