import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { artifactServer, open } from './support/script-publication-fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// host-kit's destination rule owns the path-shape matrix (ADR 0016). These cases pin what this route
// does around it: pass the spelling untouched, judge before any download or `mkdir`, stage and commit in
// the judged directory, and confirm it after the download.

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

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
  result: Awaited<ReturnType<typeof open>>,
  cause: string,
): readonly unknown[] {
  const { response, id } = result;
  expect(response.ok).toBe(true);
  const data = response.ok ? response.data : undefined;
  expect(readScriptDeliveryFailure(data)).toMatchObject({ cause, publicationId: id });
  return (data?.warnings as unknown[] | undefined) ?? [];
}

skipOnWindows(
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

skipOnWindows(
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

skipOnWindows('a remote recording refuses the directory a .. steps back into', async () => {
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
});

skipOnWindows('a remote recording refuses a private link standing on shared ground', async () => {
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
});

skipOnWindows(
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

skipOnWindows(
  'a remote recording stages and creates the entry in the directory the walk judged',
  async () => {
    // `home/work/../y` is the private `priv/y`; folded as text it is the open `home/y`. Before the entry
    // is created, `work` is swapped so the spelling resolves to `home/elsewhere/y`.
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
    const realLinkSync = fs.linkSync;
    let swapped = false;
    vi.spyOn(fs, 'linkSync').mockImplementation(((existing: unknown, newPath: unknown) => {
      if (!swapped && String(newPath).endsWith('journey.ad')) {
        swapped = true;
        fs.rmSync(link, { force: true });
        fs.symlinkSync(path.join(elsewhere, 'stash'), link);
      }
      return (realLinkSync as (...args: unknown[]) => unknown)(existing, newPath);
    }) as typeof fs.linkSync);
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, path.join(root, 'state'), destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.not.objectContaining({ scriptDeliveryFailure: expect.anything() }),
      }),
    );
    expect(swapped).toBe(true);
    expect(staged).toEqual([privY]);
    expect(fs.readdirSync(privY)).toEqual(['journey.ad']);
    expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toBe('open Demo\n');
    expect(fs.readdirSync(foldedY)).toEqual([]);
    expect(fs.readdirSync(elsewhereY)).toEqual([]);
  },
);

skipOnWindows(
  'a remote recording refuses a destination whose directory was swapped while the version downloaded',
  async () => {
    // `alias -> judged`, both private. Once the staged file is open, `alias` is retargeted to `other`, a
    // private directory too, so only the parent's identity can tell. The staging directory inside
    // `judged` stays intact, so a route that skips the confirmation would publish into `judged`.
    const root = scratchRoot('script-ancestry-');
    const judged = directoryWith(path.join(root, 'judged'), 0o700);
    const other = directoryWith(path.join(root, 'other'), 0o700);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(judged, alias);
    const destination = path.join(alias, 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
    const realOpen = fs.promises.open.bind(fs.promises);
    let retargeted = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      const handle = await realOpen(file as never, ...(rest as unknown as never[]));
      if (!retargeted) {
        retargeted = true;
        fs.rmSync(alias);
        fs.symlinkSync(other, alias);
      }
      return handle;
    });

    const result = await open(baseUrl, path.join(root, 'state'), destination);

    expect(retargeted).toBe(true);
    expectDeliveryRefused(result, 'script_ancestry_replaced');
    expect(fs.readdirSync(judged)).toEqual([]);
    expect(fs.readdirSync(other)).toEqual([]);
  },
);
