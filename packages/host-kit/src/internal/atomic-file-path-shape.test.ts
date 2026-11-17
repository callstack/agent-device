import { expect, test } from 'vitest';
import {
  childPath,
  parentDirectoryPath,
  verifiedDirectoryPath,
  withoutTrailingSeparators,
} from './atomic-file.ts';

// Windows and POSIX do not agree on what a separator is, so these tests name the platform they ask about
// rather than the one they run on: `windows` selects `path.win32` or `path.posix` semantics, so a Windows
// shape is checked on a macOS or Linux host. No filesystem is involved in the separator rules.

const STATE = String.raw`C:\Users\me\.agent-device`;

test('Windows cuts both separators and keeps the root each name stands on', () => {
  expect(parentDirectoryPath(`${STATE}\\sessions`, true)).toBe(STATE);
  // A mixed spelling is legal on Windows: `/` and `\` are the same separator there.
  expect(parentDirectoryPath(`${STATE}/sessions`, true)).toBe(STATE);
  expect(parentDirectoryPath(String.raw`C:\state`, true)).toBe('C:\\');
  // A drive root and a share root are their own parent, so nothing above them is a base to build under.
  expect(parentDirectoryPath('C:\\', true)).toBeUndefined();
  expect(parentDirectoryPath('C:', true)).toBeUndefined();
  expect(parentDirectoryPath(String.raw`\\srv\share`, true)).toBeUndefined();
  expect(parentDirectoryPath(String.raw`\\srv\share\sessions`, true)).toBe(String.raw`\\srv\share`);
  expect(parentDirectoryPath('sessions', true)).toBeUndefined();
});

test('Windows cuts a trailing separator of either spelling and keeps the drive root', () => {
  expect(withoutTrailingSeparators(`${STATE}\\`, true)).toBe(STATE);
  expect(withoutTrailingSeparators(`${STATE}/`, true)).toBe(STATE);
  expect(withoutTrailingSeparators(`${STATE}\\\\`, true)).toBe(STATE);
  expect(withoutTrailingSeparators('C:\\', true)).toBe('C:\\');
  // `C:` is drive-RELATIVE: it names a path under the CURRENT directory of C, so it is not `C:\`.
  expect(withoutTrailingSeparators(String.raw`C:\\`, true)).toBe('C:\\');
  expect(withoutTrailingSeparators(String.raw`\\`, true)).toBe('/');
});

test('Windows appends with its own separator without folding the name away', () => {
  expect(childPath(STATE, 'sessions', true)).toBe(`${STATE}\\sessions`);
  expect(childPath(`${STATE}\\`, 'sessions', true)).toBe(`${STATE}\\sessions`);
  expect(childPath(`${STATE}/`, 'sessions', true)).toBe(`${STATE}\\sessions`);
  expect(childPath('C:\\', 'sessions', true)).toBe(String.raw`C:\sessions`);
  // Appending is what keeps the step: `path.join` of this very name answers the folded spelling below.
  const aliased = `${STATE}\\alias/../state`;
  expect(childPath(aliased, 'sessions', true)).not.toBe(
    String.raw`C:\Users\me\.agent-device\state\sessions`,
  );
});

test('POSIX reads a backslash as a character of the name and never cuts it', () => {
  // A `\` is legal in a POSIX directory name, so cutting on one would cut INTO a name.
  expect(
    parentDirectoryPath(String.raw`C:\Users\me\.agent-device\sessions`, false),
  ).toBeUndefined();
  expect(parentDirectoryPath(String.raw`a\b`, false)).toBeUndefined();
  // A literal ending in a backslash stays escaped: `String.raw` cannot end a template with one.
  expect(withoutTrailingSeparators('state\\', false)).toBe('state\\');
  expect(withoutTrailingSeparators('C:\\', false)).toBe('C:\\');
  expect(childPath('/r/state', 'sessions', false)).toBe('/r/state/sessions');
  expect(childPath('/r/state//', 'sessions', false)).toBe('/r/state/sessions');
});

test('POSIX cuts the parent without folding a step the kernel still has to take', () => {
  expect(parentDirectoryPath('/r/state/sessions', false)).toBe('/r/state');
  expect(parentDirectoryPath('/r/state/sessions/', false)).toBe('/r/state');
  expect(parentDirectoryPath('/r/state//sessions', false)).toBe('/r/state');
  // The `..` survives: it is a step resolution takes against the directory physically stood in, and folding
  // it here would hand a caller a directory other than the one the walk arrives at.
  expect(parentDirectoryPath('/r/alias/../state', false)).toBe('/r/alias/..');
  expect(parentDirectoryPath('/state', false)).toBe('/');
  expect(parentDirectoryPath('/', false)).toBeUndefined();
  expect(parentDirectoryPath('state', false)).toBeUndefined();
});

test.skipIf(process.platform === 'win32')(
  'a name whose parent is the root keeps its own name',
  () => {
    // The name used to be sliced off at the parent's length, which spends the name's first character when the
    // parent is a root: `/statexyz` was answered as `//tatexyz`. The root then refused every real child of `/`
    // as `relative_destination`, so a state dir named directly under `/` never had its chain judged at all.
    expect(verifiedDirectoryPath('/agent-device-state-child-of-root', false)).toEqual({
      physical: '/agent-device-state-child-of-root',
    });
    expect(verifiedDirectoryPath('/usr', false)).toEqual({ physical: '/usr' });
    expect(verifiedDirectoryPath('state', false)).toEqual({
      ancestor: 'state',
      exposure: 'relative_destination',
    });
  },
);
