import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { artifactServer, open } from './support/script-publication-fixtures.ts';

// Where a remote recording is allowed to CREATE its file. The daemon answers, the version downloads, and
// the bytes land wherever the destination's own spelling resolves to, so the ground a destination names is
// judged one component at a time the way the kernel walks it (ADR 0016, #4565). A refused destination
// publishes nothing at all: the response is still a success, its script version is not delivered, and no
// file appears in the directory a link led through. What the same rule accepts, and the shape of each
// refusal, is pinned at the walk itself in host-kit's `atomic-file-ancestry.test.ts`; these are the cases
// that only exist once the publication, the download and the record are in the way.

test.skipIf(process.platform === 'win32')(
  'a remote recording creates a missing parent in a sticky directory and publishes there',
  async () => {
    // `open --save-script /tmp/rec/journey.ad` with `rec` absent is the ordinary shape, and `/tmp` is
    // sticky. Judging the chain before the parent exists asks the question about `/tmp` and refuses a
    // recording the local writer accepts, so the parent is created first on both routes (#4565).
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-mkdir-'));
    const stateDir = path.join(root, 'state');
    const sticky = path.join(root, 'tmp');
    fs.mkdirSync(sticky);
    fs.chmodSync(sticky, 0o1777);
    const destination = path.join(sticky, 'recordings', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.not.objectContaining({ scriptDeliveryFailure: expect.anything() }),
      }),
    );
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a destination with a missing parent and creates no directories',
  async () => {
    // The same shape as the case above, with the parent ABSENT: this route creates the missing parent
    // itself, so a `mkdir` that runs ahead of the rule leaves `recordings` standing in the open directory
    // after the publication refuses — a directory this user made in ground another local user can name
    // things in. What exists is asked about before anything is created, so a refused destination publishes
    // nothing at all, directories included.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-stray-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const destination = path.join(shared, 'recordings', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses the ground a link target crosses on the way in',
  async () => {
    // `rec -> <root>/shared/relay/sub`, `shared` at 0777 and not sticky, `shared/relay -> <root>/chosen`.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-target-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(shared, 'relay'));
    const sub = path.join(chosen, 'sub');
    fs.mkdirSync(sub);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.symlinkSync(path.join(shared, 'relay', 'sub'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(sub)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a target spelled relative to the link that holds it',
  async () => {
    // `ln -s ../team/rec rec` is how a link is usually written. The target is resolved from the directory
    // that holds the link, so the walk leaves the home and crosses `shared` at 0777 on the way in.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-relative-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const team = path.join(shared, 'team');
    fs.mkdirSync(team);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(team, 'rec'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.symlinkSync(path.join('..', 'shared', 'team', 'rec'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording stages inside the directory the entry is created in',
  async () => {
    // `home/work -> priv/x`, `priv/y` private, `home/y` at 0777. The entry lands in `priv/y`, but the
    // spelled parent folds to `home`, so staging beside the spelled parent downloads the version into a
    // directory the ancestry walk never judged as the entry's, and moves it in by a rename that is no
    // longer within one directory.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-staging-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o700);
    const sharedY = path.join(home, 'y');
    fs.mkdirSync(sharedY);
    fs.chmodSync(sharedY, 0o777);
    const privX = path.join(root, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = path.join(root, 'priv', 'y');
    fs.mkdirSync(privY);
    fs.chmodSync(privY, 0o700);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../y/journey.ad`;
    const created: string[] = [];
    const realMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((template: string, ...rest: unknown[]) => {
      created.push(path.dirname(template));
      return (realMkdtempSync as (...args: unknown[]) => unknown)(template, ...rest);
    }) as typeof fs.mkdtempSync);
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(expect.objectContaining({ ok: true }));
    expect(created).toEqual([privY]);
    expect(fs.readdirSync(sharedY)).toEqual([]);
    expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toContain('open Demo');
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a link another local user owns on the way in',
  async () => {
    // `~/rec -> <root>/tmp/relay -> ~/chosen`, `relay` another user's file in a sticky shared directory.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-hopowner-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o1777);
    const relay = path.join(tmp, 'relay');
    fs.symlinkSync(chosen, relay);
    fs.symlinkSync(relay, path.join(home, 'rec'));
    serveHostOwnership({ [relay]: FOREIGN_UID });
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses the directory a .. steps back into',
  async () => {
    // `home/work -> priv/x`, `priv/y` at 0777: the write lands in `priv/y`, not in the `home/y` the
    // normalized spelling names.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-dotdot-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const priv = path.join(root, 'priv');
    const privX = path.join(priv, 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = path.join(priv, 'y');
    fs.mkdirSync(privY);
    fs.chmodSync(privY, 0o777);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../y/journey.ad`;
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(privY)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a private link standing on shared ground two levels up',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-traverse-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const mine = path.join(shared, 'mine');
    fs.mkdirSync(mine);
    fs.chmodSync(mine, 0o700);
    const privateWork = path.join(root, 'private');
    fs.mkdirSync(privateWork);
    fs.symlinkSync(privateWork, path.join(mine, 'rec'));
    const destination = path.join(mine, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({
            cause: 'script_ancestor_untrusted',
          }),
        }),
      }),
    );
    expect(fs.readdirSync(privateWork)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a chain that leaves a shared directory through a link',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-relay-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const team = path.join(root, 'srv', 'team');
    fs.mkdirSync(team, { recursive: true });
    fs.chmodSync(team, 0o777);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(team, 'relay'));
    fs.symlinkSync(path.join(team, 'relay'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({
            cause: 'script_ancestor_untrusted',
          }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each([
  {
    name: 'a symbolic link planted where the script should land',
    plant: (root: string) => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      const attacker = path.join(root, 'attacker');
      fs.mkdirSync(attacker);
      fs.symlinkSync(attacker, path.join(shared, 'work'));
      return {
        destination: path.join(shared, 'work', 'journey.ad'),
        untouched: attacker,
      };
    },
  },
  {
    name: 'a world-writable directory',
    plant: (root: string) => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      return { destination: path.join(shared, 'journey.ad'), untouched: shared };
    },
  },
])('a remote recording refuses a destination under $name', async ({ plant }) => {
  const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-'));
  const stateDir = path.join(root, 'state');
  const { destination, untouched } = plant(root);
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  const { response } = await open(baseUrl, stateDir, destination);

  expect(response).toEqual(
    expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        scriptDeliveryFailure: expect.objectContaining({
          cause: 'script_ancestor_untrusted',
        }),
      }),
    }),
  );
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.readdirSync(untouched)).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a destination whose directory was swapped while the version downloaded',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-'));
    const stateDir = path.join(root, 'state');
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
      response = (await open(baseUrl, stateDir, destination)).response;
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
