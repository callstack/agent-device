import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

// host-kit's destination rule owns the path-shape matrix (ADR 0016). These cases pin what the writer can
// break: pass the caller's spelling untouched, create nothing before the rule answers, return its refusal.

const hostCwd = createLiveTestHostEnvironment().cwd;

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingTo(destination: string, force = false) {
  return makeAuthoringSession('journey', {
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: destination, force },
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

test.skipIf(process.platform === 'win32')(
  'a recording saves a private script under a chain only this user can write',
  () => {
    const directory = root();
    const destination = path.join(directory, 'workflows', 'journey.ad');

    const result = writerFor(directory).write(recordingTo(destination));

    expect(result.written).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toContain('open');
    expect(fs.lstatSync(destination).mode & 0o777).toBe(0o600);
  },
);

test.skipIf(process.platform === 'win32').each([
  { mode: 0o777, exposure: 'world_writable', hint: (_dir: string) => 'only you can write' },
  { mode: 0o775, exposure: 'shared_group_writable', hint: (dir: string) => `chmod g-w ${dir}` },
])(
  'a refused destination with a missing parent leaves no directories behind ($exposure)',
  ({ mode, exposure, hint }) => {
    // `close --save-script <shared>/recordings/journey.ad` where `recordings` is absent. A `mkdir -p` that
    // runs before the rule answers leaves `recordings` behind after the refusal. A group-writable
    // directory is the one refusal the hint tells the caller how to fix in place.
    const directory = root();
    const shared = directoryWith(path.join(directory, 'shared'), mode);
    const destination = path.join(shared, 'recordings', 'journey.ad');

    const result = writerFor(directory).write(recordingTo(destination));

    expect(result.written).toBe(false);
    const details = result.written ? undefined : result.error?.details;
    expect(details).toMatchObject({
      reason: 'script_ancestor_untrusted',
      exposure,
      ancestor: shared,
    });
    expect(String(details?.hint)).toContain(hint(shared));
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each([false, true])(
  'a recording refuses a private link standing on shared ground (force: %s)',
  (force) => {
    // The real path is private, but the walk crosses the 0777 `shared`. Canonicalizing first hides it.
    const directory = root();
    const shared = directoryWith(path.join(directory, 'shared'), 0o777);
    const mine = directoryWith(path.join(shared, 'mine'), 0o700);
    const privateWork = directoryWith(path.join(directory, 'private'), 0o700);
    fs.symlinkSync(privateWork, path.join(mine, 'rec'));

    const destination = path.join(mine, 'rec', 'journey.ad');
    const result = writerFor(directory).write(recordingTo(destination, force), { force });

    expect(result.written ? undefined : result.error?.details).toMatchObject({
      reason: 'script_ancestor_untrusted',
      exposure: 'world_writable',
      ancestor: shared,
    });
    expect(fs.readdirSync(privateWork)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a recording that steps back out of a missing directory leaves no directories behind',
  () => {
    // A `mkdir -p` resolves the two steps up as text and builds `<root>/shared/recordings`; the kernel
    // cannot apply them until `missing` exists.
    const directory = root();
    const privateDir = directoryWith(path.join(directory, 'private'), 0o700);
    const shared = directoryWith(path.join(directory, 'shared'), 0o777);
    const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;

    const result = writerFor(directory).write(recordingTo(destination));

    expect(result.written ? undefined : result.error?.details).toMatchObject({
      reason: 'script_ancestor_untrusted',
      exposure: 'unresolvable_parent',
      ancestor: privateDir,
    });
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a recording refuses the directory a .. steps back into',
  () => {
    // `home/work -> priv/x`, `priv/y` at 0777 while `home/y` is private. Folded as text the spelling
    // names `home/y`; the kernel lands in `priv/y`, where any local user can take the recording.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    directoryWith(path.join(home, 'y'), 0o700);
    const privX = path.join(directory, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = directoryWith(path.join(directory, 'priv', 'y'), 0o777);
    fs.symlinkSync(privX, path.join(home, 'work'));

    const result = writerFor(directory).write(recordingTo(`${home}/work/../y/journey.ad`));

    expect(result.written ? undefined : result.error?.details).toMatchObject({
      reason: 'script_ancestor_untrusted',
      exposure: 'world_writable',
      ancestor: privY,
    });
    expect(fs.readdirSync(privY)).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'y'))).toEqual([]);
    expect(fs.readdirSync(privX)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each([false, true])(
  'a recording through a link and .. lands in the directory the kernel reaches (force: %s)',
  (force) => {
    // `home/work/../y` is the private `priv/y`; folded as text it is `home/y`, which does not exist and
    // must not be staged in or created.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const privX = path.join(directory, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = directoryWith(path.join(directory, 'priv', 'y'), 0o700);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const staged: string[] = [];
    // The sibling is OPENED in the staging directory and written through that descriptor, so the open is
    // where the assertion reads the directory from.
    const realOpenSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.endsWith('.tmp')) staged.push(path.dirname(file));
      return (realOpenSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.openSync);

    const destination = `${home}/work/../y/journey.ad`;
    const result = writerFor(directory).write(recordingTo(destination, force), { force });

    expect(staged).toEqual([privY]);
    expect(result.written).toBe(true);
    const landed = path.join(privY, 'journey.ad');
    expect(fs.readFileSync(landed, 'utf8')).toContain('Demo');
    expect(fs.lstatSync(landed).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual(['work']);
  },
);
