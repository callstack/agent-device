import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readScriptDeliveryFailure, type DaemonResponse } from '@agent-device/kernel/contracts';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import {
  answer,
  artifactServer,
  open,
  request,
  script,
} from './support/script-publication-fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// host-kit's destination rule owns the path-shape matrix (ADR 0016). These cases pin what this route
// does around it: pass the spelling untouched, judge before any download or `mkdir`, stage and commit in
// the judged directory, and confirm it after the download.

function directoryWith(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chmodSync(directory, mode);
  return directory;
}

function scratchRoot(prefix: string): string {
  return fs.realpathSync(mkdtempForTestSync(prefix));
}

/**
 * Asserts the action succeeded and its script version was refused, read the way a client reads it, and
 * returns the disclosed warnings.
 */
function expectDeliveryRefused(
  result: Readonly<{ response: DaemonResponse; id: string }>,
  cause: string,
): readonly unknown[] {
  const { response, id } = result;
  expect(response.ok).toBe(true);
  const data = response.ok ? response.data : undefined;
  expect(readScriptDeliveryFailure(data)).toMatchObject({ cause, publicationId: id });
  return (data?.warnings as unknown[] | undefined) ?? [];
}

test.skipIf(process.platform === 'win32')(
  'a refused destination with a missing parent downloads nothing and creates no directories',
  async () => {
    // `open --save-script <shared>/recordings/journey.ad` with `recordings` absent. A `mkdir` or a download
    // that runs ahead of the rule leaves `recordings` or a fetched version behind after the refusal.
    const root = scratchRoot('script-ancestry-stray-');
    const shared = directoryWith(path.join(root, 'shared'), 0o777);
    const destination = path.join(shared, 'recordings', 'journey.ad');
    let fetches = 0;
    const baseUrl = await artifactServer({
      get v1() {
        fetches += 1;
        return { body: 'open Demo\n' };
      },
    });

    const result = await open(baseUrl, path.join(root, 'state'), destination);

    const warnings = expectDeliveryRefused(result, 'script_ancestor_untrusted');
    expect(warnings).toEqual([expect.stringContaining(`under ${shared}:`)]);
    expect(fetches).toBe(0);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording that steps back out of a missing directory creates no directories',
  async () => {
    // A `mkdir -p` resolves the two steps up as text and builds `<root>/shared/recordings`; the kernel
    // cannot apply them until `missing` exists. The refusal names `private`, where the walk stopped.
    const root = scratchRoot('script-ancestry-upward-');
    const privateDir = directoryWith(path.join(root, 'private'), 0o700);
    const shared = directoryWith(path.join(root, 'shared'), 0o777);
    const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const result = await open(baseUrl, path.join(root, 'state'), destination);

    const warnings = expectDeliveryRefused(result, 'script_ancestor_untrusted');
    expect(warnings).toEqual([expect.stringContaining(`under ${privateDir}:`)]);
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses the directory a .. steps back into',
  async () => {
    // `home/work -> priv/x`, `priv/y` at 0777 while `home/y` is private. Folded as text the spelling names
    // `home/y`; the kernel lands in `priv/y`, where any local user can take the recording.
    const root = scratchRoot('script-ancestry-dotdot-');
    const home = directoryWith(path.join(root, 'home'), 0o700);
    const homeY = directoryWith(path.join(home, 'y'), 0o700);
    const privX = path.join(root, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = directoryWith(path.join(root, 'priv', 'y'), 0o777);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const result = await open(baseUrl, path.join(root, 'state'), `${home}/work/../y/journey.ad`);

    const warnings = expectDeliveryRefused(result, 'script_ancestor_untrusted');
    expect(warnings).toEqual([expect.stringContaining(`under ${privY}:`)]);
    expect(fs.readdirSync(privY)).toEqual([]);
    expect(fs.readdirSync(homeY)).toEqual([]);
    expect(fs.readdirSync(privX)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a private link standing on shared ground',
  async () => {
    // The real path is private, but the walk crosses the 0777 `shared`. Canonicalizing first hides it.
    const root = scratchRoot('script-ancestry-traverse-');
    const shared = directoryWith(path.join(root, 'shared'), 0o777);
    const mine = directoryWith(path.join(shared, 'mine'), 0o700);
    const privateWork = directoryWith(path.join(root, 'private'), 0o700);
    fs.symlinkSync(privateWork, path.join(mine, 'rec'));
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const result = await open(
      baseUrl,
      path.join(root, 'state'),
      path.join(mine, 'rec', 'journey.ad'),
    );

    const warnings = expectDeliveryRefused(result, 'script_ancestor_untrusted');
    expect(warnings).toEqual([expect.stringContaining(`under ${shared}:`)]);
    expect(fs.readdirSync(privateWork)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a link another local user owns on the way in',
  async () => {
    // `home/rec -> tmp/relay -> chosen`, with `relay` another user's link in a sticky directory: they
    // can replace it, so the second hop is theirs to choose, though `chosen` itself is private.
    const root = scratchRoot('script-ancestry-hopowner-');
    const home = directoryWith(path.join(root, 'home'), 0o700);
    const chosen = directoryWith(path.join(root, 'chosen'), 0o700);
    const tmp = directoryWith(path.join(root, 'tmp'), 0o1777);
    const relay = path.join(tmp, 'relay');
    fs.symlinkSync(chosen, relay);
    fs.symlinkSync(relay, path.join(home, 'rec'));
    serveHostOwnership({ [relay]: FOREIGN_UID });
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const result = await open(
      baseUrl,
      path.join(root, 'state'),
      path.join(home, 'rec', 'journey.ad'),
    );

    const warnings = expectDeliveryRefused(result, 'script_ancestor_untrusted');
    expect(warnings).toEqual([expect.stringContaining(`under ${relay}:`)]);
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording creates a missing level under a sticky directory, only where the kernel lands',
  async () => {
    // `home/work/../shared/recordings` is `priv/shared/recordings`, with `priv/shared` sticky and this
    // user's, the `/tmp/recordings` shape. Folded as text it is `home/shared/recordings`, which does not
    // exist and must not be created.
    const root = scratchRoot('script-ancestry-folded-mkdir-');
    const home = directoryWith(path.join(root, 'home'), 0o700);
    const privX = path.join(root, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privShared = directoryWith(path.join(root, 'priv', 'shared'), 0o1777);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../shared/recordings/journey.ad`;
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, path.join(root, 'state'), destination);

    expect(response.ok).toBe(true);
    expect(readScriptDeliveryFailure(response.ok ? response.data : undefined)).toBeUndefined();
    const landed = path.join(privShared, 'recordings', 'journey.ad');
    expect(fs.readFileSync(landed, 'utf8')).toBe('open Demo\n');
    expect(fs.readdirSync(home)).toEqual(['work']);
  },
);

test.skipIf(process.platform === 'win32').each([
  { force: false, publishes: ['linkSync', 'renameSync'] },
  { force: true, publishes: ['renameSync', 'renameSync'] },
])(
  'a remote recording stages and commits every version in the directory the walk judged (force: $force)',
  async ({ force, publishes }) => {
    // `home/work/../y` is the private `priv/y`; folded as text it is the open `home/y`. Right before each
    // version's entry is created, `work` is swapped so the spelling resolves to `home/elsewhere/y`.
    const root = scratchRoot('script-ancestry-entry-');
    const home = directoryWith(path.join(root, 'home'), 0o700);
    const foldedY = directoryWith(path.join(home, 'y'), 0o777);
    const privX = path.join(root, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = directoryWith(path.join(root, 'priv', 'y'), 0o700);
    // `elsewhere/stash` lets the swapped link send `home/work/../y` to `elsewhere/y`.
    const elsewhere = directoryWith(path.join(home, 'elsewhere'), 0o700);
    fs.mkdirSync(path.join(elsewhere, 'stash'));
    const elsewhereY = directoryWith(path.join(elsewhere, 'y'), 0o700);
    const link = path.join(home, 'work');
    fs.symlinkSync(privX, link);
    const destination = `${home}/work/../y/journey.ad`;
    const staged: string[] = [];
    const realMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((template: string, ...rest: unknown[]) => {
      staged.push(path.dirname(template));
      return (realMkdtempSync as (...args: unknown[]) => unknown)(template, ...rest);
    }) as typeof fs.mkdtempSync);
    const swaps: string[] = [];
    for (const name of ['linkSync', 'renameSync'] as const) {
      const real = fs[name] as (...args: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((existing: unknown, newPath: unknown) => {
        if (String(newPath).endsWith('journey.ad')) {
          swaps.push(name);
          fs.rmSync(link, { force: true });
          fs.symlinkSync(path.join(elsewhere, 'stash'), link);
        }
        return real(existing, newPath);
      }) as never);
    }
    const stateDir = path.join(root, 'state');
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'open Demo\nclick Next\n' },
    });

    const { id, response } = await open(baseUrl, stateDir, destination, { force });
    expect(readScriptDeliveryFailure(response.ok ? response.data : undefined)).toBeUndefined();
    fs.rmSync(link);
    fs.symlinkSync(privX, link);
    const replaced = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v2', 2, id)],
    });

    expect(replaced.ok).toBe(true);
    expect(readScriptDeliveryFailure(replaced.ok ? replaced.data : undefined)).toBeUndefined();
    expect(swaps).toEqual(publishes);
    expect(staged).toEqual([privY, privY]);
    expect(fs.readdirSync(privY)).toEqual(['journey.ad']);
    expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toBe('open Demo\nclick Next\n');
    expect(fs.readdirSync(foldedY)).toEqual([]);
    expect(fs.readdirSync(elsewhereY)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each([
  { version: 'first', force: false, change: 'retarget' },
  { version: 'first', force: true, change: 'retarget' },
  { version: 'replacement', force: false, change: 'retarget' },
  { version: 'first', force: false, change: 'replace' },
  { version: 'first', force: false, change: 'world-writable' },
] as const)(
  'a remote recording refuses a $version version (force: $force) whose directory changed by $change while it downloaded',
  async ({ version, force, change }) => {
    // Once the staged file is open, the destination's directory changes: `retarget` points `alias` from
    // `judged` to `other` (both private, so only identity tells), `replace` removes `judged` and makes a
    // new private one at the same path, and `world-writable` opens `judged` to every user. Only the
    // confirmation after the download catches each one.
    const root = scratchRoot('script-ancestry-');
    const judged = directoryWith(path.join(root, 'judged'), 0o700);
    const other = directoryWith(path.join(root, 'other'), 0o700);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(judged, alias);
    const destination = path.join(change === 'retarget' ? alias : judged, 'journey.ad');
    const changeDirectory = {
      retarget: () => {
        fs.rmSync(alias);
        fs.symlinkSync(other, alias);
      },
      replace: () => {
        fs.rmSync(judged, { recursive: true, force: true });
        directoryWith(judged, 0o700);
      },
      'world-writable': () => fs.chmodSync(judged, 0o777),
    }[change];
    const stateDir = path.join(root, 'state');
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'open Demo\nclick Next\n' },
    });
    let retargeted = false;
    const changeOnDownload = () => {
      const realOpen = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
        const handle = await realOpen(file as never, ...(rest as unknown as never[]));
        if (!retargeted) {
          retargeted = true;
          changeDirectory();
        }
        return handle;
      });
    };

    let refused: { response: DaemonResponse; id: string };
    if (version === 'first') {
      changeOnDownload();
      refused = await open(baseUrl, stateDir, destination, { force });
    } else {
      const { id } = await open(baseUrl, stateDir, destination, { force });
      changeOnDownload();
      const response = await answer(baseUrl, stateDir, request('click'), {
        artifacts: [script('v2', 2, id)],
      });
      refused = { response, id };
    }

    expect(retargeted).toBe(true);
    const cause =
      change === 'world-writable' ? 'script_ancestor_untrusted' : 'script_ancestry_replaced';
    const warnings = expectDeliveryRefused(refused, cause);
    const ancestor = change === 'retarget' ? other : judged;
    expect(warnings).toEqual([expect.stringContaining(`under ${ancestor}:`)]);
    const failure = readScriptDeliveryFailure(
      refused.response.ok ? refused.response.data : undefined,
    );
    expect(failure?.hint).toMatch(/\S/);
    expect(fs.readdirSync(other)).toEqual([]);
    if (version === 'first') {
      expect(fs.readdirSync(judged)).toEqual([]);
    } else {
      expect(fs.readdirSync(judged)).toEqual(['journey.ad']);
      expect(fs.readFileSync(path.join(judged, 'journey.ad'), 'utf8')).toBe('open Demo\n');
    }
  },
);
