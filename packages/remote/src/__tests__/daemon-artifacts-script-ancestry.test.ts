import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { artifactServer, open } from './support/script-publication-fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// Where a remote recording is allowed to CREATE its file. host-kit's destination rule judges the
// destination (ADR 0016, #4565), and pins every path shape in `atomic-file-ancestry.test.ts` and
// `atomic-file-parent.test.ts`. These cases pin only what this route itself does around that rule: ask
// it before any download, stage and commit in the directory it answered, and confirm that directory is
// still the one judged once the download is done.

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

function directoryWith(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chmodSync(directory, mode);
  return directory;
}

skipOnWindows(
  'a refused destination with a missing parent downloads nothing and creates no directories',
  async () => {
    // `open --save-script <shared>/recordings/journey.ad` with `recordings` absent. A `mkdir` or a download
    // that runs ahead of the rule leaves `recordings` or a fetched version behind after the refusal.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-stray-'));
    const shared = directoryWith(path.join(root, 'shared'), 0o777);
    const destination = path.join(shared, 'recordings', 'journey.ad');
    let fetches = 0;
    const baseUrl = await artifactServer({
      get v1() {
        fetches += 1;
        return { body: 'open Demo\n' };
      },
    });

    const { response } = await open(baseUrl, path.join(root, 'state'), destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
          warnings: [expect.stringContaining(shared)],
        }),
      }),
    );
    expect(fetches).toBe(0);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows(
  'a remote recording stages and creates the entry in the directory the walk judged',
  async () => {
    // `home/work -> priv/x`, so `home/work/../y` is the private `priv/y`. Folded as text, the spelling
    // names `home/y`, which any local user can write, so staging beside the spelled parent puts the
    // download where the rule never looked. Between the last judgment and the entry, `work` is swapped
    // so the spelling now resolves to `home/elsewhere/y`: creating the entry through the spelling,
    // rather than in the directory the walk answered, lands it there.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-entry-'));
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
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-'));
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const destination = path.join(work, 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
    const realOpen = fs.promises.open.bind(fs.promises);
    // The replacement is a private directory, so only the parent's identity can catch it. The swap
    // happens once the staged file is open: after the parent's identity was captured.
    const spyOpen = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      const handle = await realOpen(file as never, ...(rest as unknown as never[]));
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work);
      return handle;
    });

    let response: DaemonResponse;
    try {
      response = (await open(baseUrl, path.join(root, 'state'), destination)).response;
    } finally {
      spyOpen.mockRestore();
    }

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestry_replaced' }),
        }),
      }),
    );
    expect(fs.readdirSync(work)).toEqual([]);
  },
);
