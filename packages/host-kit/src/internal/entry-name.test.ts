// The one entry name a script destination's spelling names, under POSIX and Windows rules, and the expansion
// that refuses a spelling whose last segment names none before it normalizes it away (ADR 0016).
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveScriptDestination, scriptEntryName, unnamedEntryFailure } from './entry-name.ts';
import { ancestryRoot as root, expectUntrusted } from './script-destination-host.fixtures.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/** Every entry under `directory`, so a refusal can show it created nothing anywhere below it. */
function tree(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true }).map(String).sort();
}

test.each([
  { spelled: '\\\\server\\share\\', name: undefined },
  { spelled: '\\\\server\\share', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\share\\', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\share', name: undefined },
  { spelled: '\\\\.\\UNC\\server\\share', name: undefined },
  { spelled: '\\\\?\\UNC\\server', name: undefined },
  { spelled: '\\\\?\\C:\\', name: undefined },
  { spelled: 'C:\\', name: undefined },
  { spelled: 'C:', name: undefined },
  { spelled: 'C:\\dir\\..', name: undefined },
  { spelled: '\\\\server\\share\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\?\\UNC\\server\\share\\journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\dir\\journey.ad\\', name: 'journey.ad' },
  { spelled: '//?//UNC/server/share', name: undefined },
  { spelled: '\\\\?\\\\UNC\\server\\share', name: undefined },
  { spelled: '//?/UNC//server//share/', name: undefined },
  { spelled: '\\\\.\\pipe\\recorder', name: undefined },
  { spelled: '//./pipe/recorder', name: undefined },
  { spelled: '\\\\?\\GLOBALROOT\\Device\\journey.ad', name: undefined },
  { spelled: 'CON', name: undefined },
  { spelled: 'C:\\dir\\con.txt', name: undefined },
  { spelled: 'C:\\dir\\Lpt9.ad', name: undefined },
  { spelled: 'C:\\dir\\nul .ad', name: undefined },
  { spelled: 'C:\\dir\\COM1', name: undefined },
  { spelled: 'C:\\missing\\log.ad:private', name: undefined },
  { spelled: 'C:\\dir:x\\journey.ad', name: undefined },
  { spelled: '\\\\server\\share\\a:b', name: undefined },
  { spelled: 'C:\\dir\\console.ad', name: 'console.ad' },
  { spelled: 'C:\\dir\\COM10.ad', name: 'COM10.ad' },
  { spelled: 'C:journey.ad', name: 'journey.ad' },
  { spelled: '//server//share//journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\new\\bad?.ad', name: undefined },
  { spelled: 'C:\\new\\a<b.ad', name: undefined },
  { spelled: 'C:\\new\\a>b.ad', name: undefined },
  { spelled: 'C:\\new\\a"b.ad', name: undefined },
  { spelled: 'C:\\new\\a|b.ad', name: undefined },
  { spelled: 'C:\\new\\a*b.ad', name: undefined },
  { spelled: 'C:\\new\\a\u0001b.ad', name: undefined },
  { spelled: 'C:\\new\\a\u001fb.ad', name: undefined },
  { spelled: 'C:\\new\\trailing.', name: undefined },
  { spelled: 'C:\\new\\trailing ', name: undefined },
  { spelled: 'C:\\new\\COM¹.ad', name: undefined },
  { spelled: 'C:\\new\\com²', name: undefined },
  { spelled: 'C:\\new\\LPT³.log', name: undefined },
  { spelled: '\\\\?\\PIPE\\recorder', name: undefined },
  { spelled: '\\\\?\\Volume{0}\\journey.ad', name: undefined },
  { spelled: '\\\\?\\C:\\dir\\journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\new\\COM⁴.ad', name: 'COM⁴.ad' },
  { spelled: '\\\\localhost\\pipe\\recorder', name: undefined },
  { spelled: '\\\\server\\PIPE\\recorder.ad', name: undefined },
  { spelled: '//server/pipe/recorder', name: undefined },
  { spelled: '\\\\?\\UNC\\localhost\\pipe\\recorder', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\Pipe\\recorder.ad', name: undefined },
  { spelled: '\\\\server\\pipes\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\server\\share\\pipe\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\server\\IPC$\\recorder', name: undefined },
  { spelled: '\\\\server\\ipc$\\recorder.ad', name: undefined },
  { spelled: '\\\\server\\mailslot\\recorder', name: undefined },
  { spelled: '\\\\server\\MailSlot\\recorder.ad', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\IPC$\\recorder', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\mailslot\\recorder', name: undefined },
  { spelled: '\\\\server\\share\\IPC$\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\server\\share\\mailslot\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\server\\IPCs\\journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\new\\COM0.ad', name: undefined },
  { spelled: 'C:\\new\\lpt0', name: undefined },
  { spelled: 'C:\\new\\CONIN$', name: undefined },
  { spelled: 'C:\\new\\conout$.txt', name: undefined },
  { spelled: 'C:\\new\\CONIN$x.ad', name: 'CONIN$x.ad' },
  { spelled: 'C:\\dir\\COM¹\u00A0.ad', name: 'COM¹\u00A0.ad' },
  { spelled: 'C:\\dir\\COM¹ .ad', name: undefined },
  { spelled: 'C:\\new\\a b.c.ad', name: 'a b.c.ad' },
  { spelled: `C:\\dir\\${'a'.repeat(256)}`, name: undefined },
  { spelled: `C:\\dir\\${'é'.repeat(255)}`, name: 'é'.repeat(255) },
  { spelled: '~\\', name: undefined },
  { spelled: String.raw`~/\/`, name: undefined },
  { spelled: 'dir\\~', name: '~' },
])('Windows rules name $name for $spelled', ({ spelled, name }) => {
  expect(scriptEntryName(spelled, path.win32)).toBe(name);
});

test.each([
  { spelled: '/', name: undefined },
  { spelled: '~', name: undefined },
  { spelled: '~/', name: undefined },
  { spelled: '~/.', name: undefined },
  { spelled: './missing/.', name: undefined },
  { spelled: 'dir/~', name: '~' },
  { spelled: '~\\', name: '~\\' },
  { spelled: '~/journey.ad', name: 'journey.ad' },
  { spelled: 'journey.ad/', name: 'journey.ad' },
  { spelled: 'script\uD800.ad', name: undefined },
  { spelled: 'dir\uDC00/journey.ad', name: undefined },
  { spelled: 'script😀.ad', name: 'script😀.ad' },
])('POSIX rules name $name for $spelled', ({ spelled, name }) => {
  expect(scriptEntryName(spelled, path.posix)).toBe(name);
});

skipOnWindows.each(['./missing/.', 'missing/..', '~/', '~'])(
  'expanding %s refuses it before the expansion folds its last segment away',
  (spelled) => {
    const directory = root();

    expectUntrusted(
      () => resolveScriptDestination(spelled, { cwd: directory, env: { HOME: directory } }),
      'unnamed_entry',
      path.dirname(spelled),
    );
    expect(tree(directory)).toEqual([]);
  },
);

test.each([
  { spelled: 'C:\\di:r\\journey.ad', blames: 'path' },
  { spelled: 'C:\\dir\\a:b.ad', blames: 'name' },
])(
  'a Windows colon in the $blames is refused with a hint about the $blames',
  ({ spelled, blames }) => {
    const failure = unnamedEntryFailure(spelled, path.win32);

    expect(failure.code).toBe('INVALID_ARGS');
    expect(failure.details).toMatchObject({
      exposure: 'unnamed_entry',
      ancestor: path.win32.dirname(spelled),
    });
    if (blames === 'path') expect(failure.details?.hint).toMatch(/directory names/);
    else expect(failure.details?.hint).toMatch(/valid file name/);
  },
);
