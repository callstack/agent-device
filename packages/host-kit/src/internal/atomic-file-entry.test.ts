// The final name a script destination is created under: host-kit validates it before any filesystem work and
// answers the complete entry, so no publisher spells a name the walk did not authorize (ADR 0016).
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestryRoot as root,
  directoryWith,
  expectUntrusted,
  publish,
} from './atomic-file-host.fixtures.ts';
import { prepareScriptDestination } from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every entry under `directory`, so a refusal can show it created nothing anywhere below it. */
function tree(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true }).map(String).sort();
}

skipOnWindows.each([
  { name: 'a `.` final segment', suffix: '/.' },
  { name: 'a `..` final segment', suffix: '/..' },
  { name: 'a `.` below a missing directory', suffix: '/sub/.' },
  { name: 'a `..` below a missing directory', suffix: '/sub/..' },
  { name: 'a NUL in the final name', suffix: '/journey\0.ad' },
  { name: 'a NUL in a missing directory', suffix: '/sub\0/journey.ad' },
])('refuses $name before anything is created', ({ suffix }) => {
  const directory = root();
  const dir = directoryWith(path.join(directory, 'dir'), 0o700);
  const destination = `${dir}${suffix}`;

  expectUntrusted(() => publish(destination), 'unnamed_entry', path.dirname(destination));
  expectUntrusted(
    () => prepareScriptDestination(destination),
    'unnamed_entry',
    path.dirname(destination),
  );
  expect(tree(directory)).toEqual(['dir']);
});

test('refuses the root itself, whose final name is empty', () => {
  expectUntrusted(() => prepareScriptDestination('/'), 'unnamed_entry', '/');
});

skipOnWindows(
  'never writes a temporary file outside the judged directory for a `..` final segment',
  () => {
    // `<dir>/inner/..` spells `inner` as the parent. An entry joined from that parent and `..` is `<dir>`
    // itself, and its temporary sibling would land one level further up, in ground nobody judged as the place
    // the entry is created.
    const directory = root();
    const dir = directoryWith(path.join(directory, 'dir'), 0o700);
    const inner = directoryWith(path.join(dir, 'inner'), 0o700);
    const written: string[] = [];
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
      written.push(String(target));
      return write(target, ...rest);
    });

    expect(() => publish(`${inner}/..`)).toThrow();

    expect(written.filter((target) => path.dirname(target) !== inner)).toEqual([]);
    expectUntrusted(() => publish(`${inner}/..`), 'unnamed_entry', inner);
    expect(tree(directory)).toEqual(['dir', path.join('dir', 'inner')]);
  },
);

skipOnWindows('a trailing separator names the same entry it always has', () => {
  const directory = root();
  const dir = directoryWith(path.join(directory, 'dir'), 0o700);

  publish(`${dir}/journey.ad/`);

  expect(fs.readFileSync(path.join(dir, 'journey.ad'), 'utf8')).toBe('context\n');
  expect(tree(dir)).toEqual(['journey.ad']);
  expect(prepareScriptDestination(`${dir}/journey.ad/`).entry).toBe(path.join(dir, 'journey.ad'));
});
