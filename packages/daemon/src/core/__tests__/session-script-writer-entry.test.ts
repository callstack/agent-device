// What a local recording does at the final entry the destination rule authorizes: a name too long to hold, a
// directory or a hard link already standing there, under each overwrite mode (ADR 0016). The overlong name is
// what this rule refuses; the directory and hard-link rows are behavior pins that held before it and must keep
// holding through the single owner.
import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

function recordingTo(destination: string, force: boolean) {
  return makeAuthoringSession('journey', {
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: destination, force },
    },
    actions: [{ ts: Date.now(), command: 'open', positionals: ['Demo'], flags: {} }],
  });
}

/** A private scratch root, so only the entry under test can refuse the write. */
function root(): string {
  const directory = fs.realpathSync(mkdtempForTestSync('agent-device-script-entry-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

skipOnWindows('a local write reports the committed entry through a POSIX parent alias', () => {
  const directory = root();
  const parent = path.join(directory, 'recordings');
  const alias = path.join(directory, 'alias');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.symlinkSync(parent, alias);
  const writer = new SessionScriptWriter(path.join(directory, 'sessions'), directory);
  const entry = path.join(parent, 'journey.ad');

  const result = writer.write(recordingTo(`${alias}/journey.ad/`, false));

  expect(result).toMatchObject({ written: true, path: entry });
  expect(fs.readFileSync(entry, 'utf8')).toContain('open');
});

test('a local write reports the normalized Windows entry it commits', () => {
  const directory = root();
  const volume = fs.statSync(directory);
  const writer = new SessionScriptWriter(path.join(directory, 'sessions'), directory);
  const rename = vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
  const mocks = [
    rename,
    vi.spyOn(fs, 'statSync').mockReturnValue(volume),
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined),
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined),
    vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined),
  ];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spelling = 'C:/recordings/./journey.ad/';
    const entry = String.raw`C:\recordings\journey.ad`;
    const result = writer.write(recordingTo(spelling, true), { force: true });

    expect(result).toMatchObject({ written: true, path: entry });
    expect(rename).toHaveBeenCalledExactlyOnceWith(expect.any(String), entry);
    expect(fs.existsSync(rename.mock.calls[0]![0])).toBe(false);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const mock of mocks) mock.mockRestore();
  }
});

type Outcome = Readonly<
  { written: true } | { written: false; reason?: string; exposure?: string; notReason?: string }
>;

const CASES: ReadonlyArray<{
  name: string;
  force: boolean;
  outcome: Outcome;
  /** Builds what stands at the entry and answers the destination. */
  arrange: (directory: string) => string;
  /** What must hold afterwards, beyond the outcome. */
  verify: (directory: string, destination: string) => void;
}> = [false, true].flatMap((force) => [
  {
    name: 'an overlong name',
    force,
    outcome: { written: false, reason: 'script_ancestor_untrusted', exposure: 'unnamed_entry' },
    arrange: (directory: string) => path.join(directory, 'new', 'a'.repeat(256)),
    verify: (directory: string) => expect(fs.readdirSync(directory)).toEqual([]),
  },
  {
    name: 'a directory at the entry',
    force,
    // A forced save renames over the entry, which a directory refuses; only an exclusive link answers that a
    // file already exists there.
    outcome: force
      ? { written: false, notReason: 'script_target_exists' }
      : { written: false, reason: 'script_target_exists' },
    arrange: (directory: string) => {
      const destination = path.join(directory, 'journey.ad');
      fs.mkdirSync(destination);
      return destination;
    },
    verify: (_directory: string, destination: string) => {
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
      expect(fs.readdirSync(destination)).toEqual([]);
    },
  },
  {
    name: 'a hard link at the entry',
    force,
    outcome: force ? { written: true } : { written: false, reason: 'script_target_exists' },
    arrange: (directory: string) => {
      const destination = path.join(directory, 'journey.ad');
      fs.writeFileSync(path.join(directory, 'theirs.ad'), 'theirs\n');
      fs.linkSync(path.join(directory, 'theirs.ad'), destination);
      return destination;
    },
    verify: (directory: string, destination: string) => {
      // Replaced as a directory entry, never written through to the file it shared.
      expect(fs.readFileSync(path.join(directory, 'theirs.ad'), 'utf8')).toBe('theirs\n');
      if (force) expect(fs.readFileSync(destination, 'utf8')).toContain('open');
      else expect(fs.readFileSync(destination, 'utf8')).toBe('theirs\n');
    },
  },
]);

skipOnWindows.each(CASES)(
  'a local recording to $name with force=$force',
  ({ force, outcome, arrange, verify }) => {
    const directory = root();
    const destination = arrange(directory);
    const writer = new SessionScriptWriter(
      path.join(mkdtempForTestSync('agent-device-script-sessions-'), 'sessions'),
      createLiveTestHostEnvironment().cwd,
    );

    const result = writer.write(recordingTo(destination, force), { force });

    expect(result.written).toBe(outcome.written);
    if (!result.written && !outcome.written && outcome.notReason) {
      expect(result.error).toBeDefined();
      expect(result.error?.details?.reason).not.toBe(outcome.notReason);
    }
    if (!result.written && !outcome.written && outcome.reason) {
      expect(result.error?.details).toMatchObject({
        reason: outcome.reason,
        ...(outcome.exposure ? { exposure: outcome.exposure } : {}),
      });
    }
    verify(directory, destination);
  },
);
