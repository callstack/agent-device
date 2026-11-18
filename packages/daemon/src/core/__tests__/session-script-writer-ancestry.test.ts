import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

// A destination the caller named is judged by host-kit's destination rule, which pins every path shape
// in `atomic-file-ancestry.test.ts` and `atomic-file-parent.test.ts`. These cases pin only what the writer
// itself can break: that it hands the caller's spelling to that rule untouched, creates nothing before
// the rule answers, and returns the rule's typed refusal.

const hostCwd = createLiveTestHostEnvironment().cwd;
const skipOnWindows = process.platform === 'win32' ? test.skip : test;

function recordingTo(destination: string) {
  return makeAuthoringSession('journey', {
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: destination, force: false },
    },
    actions: [{ ts: Date.now(), command: 'open', positionals: ['Demo'], flags: {} }],
  });
}

function root(): string {
  return fs.realpathSync(mkdtempForTestSync('agent-device-script-ancestry-'));
}

function directoryWith(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chmodSync(directory, mode);
  return directory;
}

function writerFor(directory: string): SessionScriptWriter {
  return new SessionScriptWriter(path.join(directory, 'sessions'), hostCwd);
}

skipOnWindows('a recording saves a private script under a chain only this user can write', () => {
  const directory = root();
  const destination = path.join(directory, 'workflows', 'journey.ad');

  const result = writerFor(directory).write(recordingTo(destination));

  expect(result.written).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toContain('open');
  expect(fs.lstatSync(destination).mode & 0o777).toBe(0o600);
});

skipOnWindows('a refused destination with a missing parent leaves no directories behind', () => {
  // `close --save-script /shared/recordings/journey.ad` where `recordings` is absent. A `mkdir -p` that
  // runs before the rule answers leaves `recordings` standing in ground another local user can name
  // things in, after the publish refuses.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const destination = path.join(shared, 'recordings', 'journey.ad');

  const result = writerFor(directory).write(recordingTo(destination));

  expect(result.written).toBe(false);
  expect(result.written ? undefined : result.error?.details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: shared,
  });
  expect(fs.readdirSync(shared)).toEqual([]);
});

skipOnWindows('a recording through a link and .. lands in the directory the kernel reaches', () => {
  // `home/work -> priv/x`, so `home/work/../y` is `priv/y` (private). Folded as text, the same spelling
  // names `home/y`, which any local user can write: a writer that normalizes the caller's path before
  // the rule sees it judges, and writes, a different directory.
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const foldedY = directoryWith(path.join(home, 'y'), 0o777);
  const privX = path.join(directory, 'priv', 'x');
  fs.mkdirSync(privX, { recursive: true });
  const privY = directoryWith(path.join(directory, 'priv', 'y'), 0o700);
  fs.symlinkSync(privX, path.join(home, 'work'));

  const result = writerFor(directory).write(recordingTo(`${home}/work/../y/journey.ad`));

  expect(result.written).toBe(true);
  const landed = path.join(privY, 'journey.ad');
  expect(fs.readFileSync(landed, 'utf8')).toContain('Demo');
  expect(fs.lstatSync(landed).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(foldedY)).toEqual([]);
});
