import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const { readlinkMock, runCmdMock } = vi.hoisted(() => ({
  readlinkMock: vi.fn(),
  runCmdMock: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readlink: readlinkMock,
}));
vi.mock('./exec.ts', async (original) => ({
  ...(await original<typeof import('./exec.ts')>()),
  runCmd: runCmdMock,
  withoutCommandExecutorOverride: async (fn: () => Promise<unknown>) => await fn(),
}));
import { readProcessExecutablePaths } from '../process.ts';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const host = { env: process.env, cwd: process.cwd() };
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value });
  if (value === 'win32') {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === 'SYSTEMROOT') vi.stubEnv(key, undefined);
    }
    vi.stubEnv('SystemRoot', String.raw`D:\WinNT`);
  }
}

test('Linux reads requested executable links and refuses missing, deleted and invalid paths', async () => {
  platform('linux');
  readlinkMock.mockImplementation(async (name: string) => {
    const entries: Record<string, Buffer> = {
      '/proc/1/exe': Buffer.from('/opt/应用/my binary'),
      '/proc/2/exe': Buffer.from('/opt/gone (deleted)'),
      '/proc/3/exe': Buffer.from([0x2f, 0xff]),
      '/proc/4/exe': Buffer.from('relative'),
      '/proc/5/exe': Buffer.from('/' + 'x'.repeat(4095)),
    };
    if (!(name in entries)) throw new Error('unavailable');
    return entries[name];
  });
  const paths = await readProcessExecutablePaths(
    [1, 2, 3, 4, 5, 6, 1, 0, -1, 1.5, 2147483648],
    host,
  );
  assert.deepEqual([...paths], [[1, '/opt/应用/my binary']]);
  assert.equal(readlinkMock.mock.calls.length, 6);
  assert.equal(runCmdMock.mock.calls.length, 0);
});

test('Linux deadline returns unknown when a read does not settle', async () => {
  platform('linux');
  readlinkMock.mockImplementation(() => new Promise(() => {}));
  assert.deepEqual([...(await readProcessExecutablePaths([1], host, 1))], []);
});

test.each(['darwin', 'win32'] as const)(
  '%s batches only requested executable paths and filters invalid rows',
  async (os) => {
    platform(os);
    const valid =
      os === 'darwin' ? '/Applications/应用 App/bin' : String.raw`C:\Program Files\应用\bin.exe`;
    runCmdMock.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { pid: 1, path: valid },
        { pid: 2, path: null },
        { pid: 3, path: 'relative' },
        { pid: 4, path: valid + '\u0000' },
        { pid: 99, path: valid },
        { pid: 5, path: valid },
        { pid: 5, path: valid },
      ]),
    });
    const paths = await readProcessExecutablePaths(
      [1, 2, 3, 4, 5, 0, 1, -1, 1.5, 2147483648],
      host,
      20,
    );
    assert.deepEqual([...paths], [[1, valid]]);
    assert.equal(runCmdMock.mock.calls.length, 1);
    const [cmd, args, options] = runCmdMock.mock.calls[0]!;
    if (os === 'darwin') {
      assert.equal(cmd, '/usr/bin/osascript');
      assert.match(args[3], /proc_pidpath/);
      const selected = /JSON\.stringify\((\[[^\]]*\])\.map/.exec(args[3]);
      assert.ok(selected);
      assert.deepEqual(JSON.parse(selected[1]!), [1, 2, 3, 4, 5]);
      assert.match(args[3], /n<=0 \|\| n>=4096/);
      assert.equal(options.timeoutMs, 20);
    } else {
      assert.equal(cmd, String.raw`D:\WinNT\System32\WindowsPowerShell\v1.0\powershell.exe`);
      assert.match(args[3], /ExecutablePath/);
      const filter = /-Filter '([^']*)'/.exec(args[3]);
      assert.equal(
        filter?.[1],
        'ProcessId=1 OR ProcessId=2 OR ProcessId=3 OR ProcessId=4 OR ProcessId=5',
      );
      assert.doesNotMatch(args[3], /CommandLine/);
      assert.equal(options.timeoutMs, 2000);
    }
  },
);

test.each(['darwin', 'win32'] as const)(
  '%s returns unknown for failed or partial output',
  async (os) => {
    platform(os);
    runCmdMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '[{"pid":1,"path":"/ok"}]',
      stderr: '',
    });
    runCmdMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '[{"pid":1,"path":"/ok"}',
      stderr: '',
    });
    runCmdMock.mockRejectedValueOnce(new Error('timeout'));
    for (let i = 0; i < 3; i++) assert.equal((await readProcessExecutablePaths([1], host)).size, 0);
    assert.equal((await readProcessExecutablePaths([0, -1], host)).size, 0);
    assert.equal(runCmdMock.mock.calls.length, 3);
  },
);

test.each([undefined, '', 'Windows', String.raw`C:Windows`, String.raw`\Windows`])(
  'Windows refuses missing or nonabsolute SystemRoot %s without a PATH lookup',
  async (root) => {
    platform('win32');
    vi.stubEnv('SystemRoot', root);
    assert.equal((await readProcessExecutablePaths([1], host)).size, 0);
    assert.equal(runCmdMock.mock.calls.length, 0);
  },
);

test('Windows uses only its supplied host SystemRoot with case-insensitive names', async () => {
  platform('win32');
  runCmdMock.mockResolvedValue({ stdout: '[]', stderr: '', exitCode: 0 });
  await readProcessExecutablePaths([1], {
    env: { sYsTeMrOoT: String.raw`E:\Windows` },
    cwd: process.cwd(),
  });
  assert.equal(
    runCmdMock.mock.calls[0]?.[0],
    String.raw`E:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  );
});
