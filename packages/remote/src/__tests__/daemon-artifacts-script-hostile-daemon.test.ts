// What a CLIENT writes when the daemon on the other end of the wire is hostile (#4565). Every field of a
// response is attacker-chosen text there, and three of them name something: `publicationId` says which
// publication a version belongs to, `artifactId` says which bytes to download, and `fileName` says what a
// downloaded artifact is called. None of the three may become a directory this client writes into: the script
// destination is the one the client recorded for itself BEFORE it sent the request, and a daemon that could
// steer a write with a response string would not need the destination rule at all. Each case answers a
// request the way a hostile daemon would and asserts where the client's files ended up.
//
// The script route reaches the filesystem in two places only. A version is matched to a record by a HASH of
// the publication identity, and its bytes are staged in a directory the client makes with `mkdtempSync` and
// names `script.ad` itself. That is what this file pins: a response string that would resolve outside those
// two places has to be refused, and it has to be refused without creating anything the daemon named.
//
// Receipt cases send a real `batch`, because the client reads `scriptDeliveryReceipt` only on that command:
// a receipt on any other command is never parsed, and the case would pass without reaching the validator.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  answer,
  artifactServer,
  batch,
  open,
  records,
  request,
  script,
} from './support/script-publication-fixtures.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/**
 * Field values a hostile daemon answers where a client might build a path. Each is text the wire carries
 * legally, and each is a shape that resolves somewhere other than where it was written: `../` walks out of a
 * directory, a leading separator replaces the whole path, a separator inside a name changes which directory
 * is named, and a long name runs past a filesystem's own limit.
 */
const HOSTILE_NAMES = [
  '../../../../tmp/agent-device-evil',
  '/absolute/agent-device-evil',
  '..',
  '../..',
  'a/b/c',
  'evil\0.ad',
  `${'x'.repeat(4095)}.ad`,
] as const;

/**
 * The hostile names a daemon can still SERVE bytes for. `..` is left out: its download URL collapses to the
 * server's root and nothing answers there, which is its own case below.
 */
const SERVED_HOSTILE_NAMES = HOSTILE_NAMES.filter((name) => name !== '..');

/** The plan steps a receipt answers on, spelled the way a submitted batch plan spells them. */
const PLAN = [{ command: 'wait', input: {} }];

/**
 * One world. The client works in `root`, which is planted DEEP inside the watched tree `outer`, and the depth
 * is the point: a short climb such as `../../x` from `root` lands INSIDE `outer`, where the snapshot sees it.
 * A longer climb such as `../../../../tmp/evil` resolves outside `outer`, so {@link escapeTargets} checks those
 * names at their resolved locations, from `root` and from the working directory.
 */
function scratchWorld() {
  const outer = fs.realpathSync(mkdtempForTestSync('script-hostile-'));
  const root = path.join(outer, 'one', 'two', 'scratch');
  fs.mkdirSync(root, { recursive: true });
  const stateDir = path.join(root, 'state');
  const destination = path.join(root, 'caller', 'journey.ad');
  // Names are spelled from the WATCHED root, because that is what the snapshots are keyed by.
  const rel = (absolute: string) => path.relative(outer, absolute).split(path.sep).join('/');
  return {
    outer,
    root,
    stateDir,
    destination,
    rel,
    /** The record directory, spelled from the watched root. */
    recordDir: rel(path.join(stateDir, 'remote-connections', 'session-scripts')),
  };
}

type World = ReturnType<typeof scratchWorld>;

/** Every entry under `root`, each described by what it IS: a directory, a link with its raw target, or bytes. */
function snapshotTree(root: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!fs.existsSync(root)) return found;
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      found.set(name, describeEntry(path.join(directory, entry.name), entry));
      if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
    }
  };
  walk(root, '');
  return found;
}

function describeEntry(pathname: string, entry: fs.Dirent): string {
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) return `link:${fs.readlinkSync(pathname)}`;
  if (!entry.isFile()) return 'other';
  return bytesOf(fs.readFileSync(pathname));
}

/** The state a file with these contents is reported with, so a case can NAME the bytes it expects. */
function bytesOf(contents: string | Uint8Array): string {
  return `bytes:${crypto.createHash('sha256').update(contents).digest('hex')}`;
}

/**
 * Entries of the watched tree whose state differs between `before` and now, in EITHER direction: a name that
 * appeared, one that vanished, and one whose bytes, kind or link target CHANGED. `allowed` names what the
 * interaction is entitled to produce — `name=state` for an entry that must carry exactly those bytes, or a bare
 * `name` for one whose contents another assertion pins. Anything else is reported with both states. The watch
 * covers `state` and `caller` like every other subtree, because the client owns them and that is where a
 * steered write lands.
 */
function entriesThatMoved(
  world: World,
  before: Map<string, string>,
  allowed: ReadonlySet<string> = new Set(),
): string[] {
  const after = snapshotTree(world.outer);
  const moved: string[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name);
    const now = after.get(name);
    if (was === now) continue;
    if (now !== undefined && (allowed.has(name) || allowed.has(`${name}=${now}`))) continue;
    moved.push(`${name}: was ${was ?? 'absent'}, now ${now ?? 'absent'}`);
  }
  return moved;
}

/** The directories that carry `name`, each as `name=dir`, spelled from the watched root. */
function chainOf(name: string): string[] {
  const parts = name.split('/');
  return parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join('/')}=dir`);
}

/**
 * The ground one publication may prepare: the record directory and the chain that carries it, plus the chain
 * that carries the destination it chose for itself. No FILE, at any name, is on this list, and neither is the
 * destination's own name as a directory.
 */
function preparedGround(world: World): Set<string> {
  return new Set([
    ...chainOf(world.recordDir),
    `${world.recordDir}=dir`,
    ...chainOf(world.rel(world.destination)),
  ]);
}

/**
 * The record names this client owns, captured NOW, sorted. A caller about to let a daemon answer has to KEEP
 * the result: read again AFTER the answer, the directory is the very thing under test, and a client that moved
 * its own record to another hash-shaped name would then be handed that name as its own expected value.
 */
function recordNames(world: World): string[] {
  return records(world.stateDir).sort();
}

/**
 * The record files the client owns, spelled from names pinned BEFORE the answer arrived. Because the pin, not a
 * fresh listing, is what builds the allowed list, a record that is ADDED or RENAMED after it is reported by
 * `entriesThatMoved` instead of accepted as one of the client's own.
 */
function ownRecordFiles(world: World, pinnedNames: readonly string[]): string[] {
  return pinnedNames.map((name) => `${world.recordDir}/${name}`);
}

/**
 * What the records named `pinnedNames` SAY, in full: each exact name and every field of the record. Nothing is
 * discovered by listing the directory, so a renamed record, a destination moved, a revision that did not move,
 * or a staging directory left listed all fail the caller's `toEqual`. The listing is compared against the PIN
 * first, so a record that was added, or moved to another hash-shaped name, fails as the name it moved to.
 */
function recordsAsWritten(
  world: World,
  pinnedNames: readonly string[],
): Array<Record<string, unknown>> {
  expect(recordNames(world)).toEqual([...pinnedNames].sort());
  return pinnedNames.map((name) => ({ name, ...readRecord(world, name) }));
}

function readRecord(world: World, name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(recordFile(world, name), 'utf8')) as Record<string, unknown>;
}

function recordFile(world: World, name: string): string {
  return path.join(world.stateDir, 'remote-connections', 'session-scripts', name);
}

/**
 * The paths a hostile name would resolve to OUTSIDE the watched tree, which no snapshot can see: the absolute
 * name, and the ones that climb above it. A name resolving to an ANCESTOR is left out — that directory stood
 * here before the daemon was ever asked, so its existence proves nothing, and nothing new may appear inside it
 * anyway, which the snapshot of the watched tree does cover.
 */
function escapeTargets(world: World, names: readonly string[]): string[] {
  return names
    .flatMap((name) => [path.resolve(world.root, name), path.resolve(process.cwd(), name)])
    .filter((target) => {
      if (target === world.root || target.startsWith(world.root + path.sep)) return false;
      // A climb that ends on a directory above either base already existed before the test.
      const cwd = process.cwd();
      return (
        !world.root.startsWith(target + path.sep) &&
        target !== cwd &&
        !cwd.startsWith(target + path.sep)
      );
    });
}

function nothingEscaped(world: World, names: readonly string[]): string[] {
  return escapeTargets(world, names).filter((target) => fs.existsSync(target));
}

skipOnWindows(
  'a batch version belonging to another publication is dropped before its fields reach a path',
  async () => {
    // The contract refuses a version whose `scriptPublicationId` differs from the receipt's. The pair is
    // hostile here in the way that matters: the second id is ANOTHER publication this same client owns, so a
    // client that skipped the match would take this batch answer's bytes and write them into that other
    // recording's destination — one caller's response steering a write into a different publication's file.
    const world = scratchWorld();
    const other = path.join(world.root, 'caller', 'other.ad');
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v9: { body: 'type Demo evil\n' },
    });
    const first = await open(baseUrl, world.stateDir, world.destination);
    const second = await open(baseUrl, world.stateDir, other);
    expect(first.response.ok && second.response.ok).toBe(true);
    // Pinned BEFORE the answer arrives: these two names, and no others, are this client's own records.
    const namesAtSend = recordNames(world);
    expect(namesAtSend).toHaveLength(2);
    const recordsAtSend = recordsAsWritten(world, namesAtSend);
    expect(fs.readFileSync(other, 'utf8')).toBe('open Demo\n');

    // ONE send: nothing about the answer depends on a hostile string. It names two publication ids this
    // client owns and the contract compares THOSE, so asking the same question seven times would add nothing
    // the first send cannot already fail on.
    const before = snapshotTree(world.outer);
    const response = await answer(baseUrl, world.stateDir, batch(PLAN), {
      scriptDeliveryReceipt: {
        publicationId: first.id,
        version: { ...script('v9', 2, second.id), artifactId: 'v9' },
      },
    });

    expect(response.ok).toBe(true);
    // Neither recording moved, and the whole watched tree is byte-for-byte what it was: no new record, no
    // record rewritten, no staging directory, nothing anywhere the receipt could have named.
    expect(fs.readFileSync(world.destination, 'utf8')).toBe('open Demo\n');
    expect(fs.readFileSync(other, 'utf8')).toBe('open Demo\n');
    const data = response.ok ? (response.data as Record<string, unknown>) : {};
    expect(data.savedScript).toBeUndefined();
    expect(entriesThatMoved(world, before)).toEqual([]);
    expect(recordsAsWritten(world, namesAtSend)).toEqual(recordsAtSend);
    expect(nothingEscaped(world, HOSTILE_NAMES)).toEqual([]);
  },
);

skipOnWindows(
  'a receipt naming a publication this client never opened is dropped and writes nothing',
  async () => {
    // The receipt's own `publicationId` is the daemon's claim about which recording it is delivering. When no
    // record of this client matches it, nothing is honored: the version is DROPPED, and the dropped id does not
    // become a record, a published file, or a failure this client takes for its own. HOSTILE_NAMES covers the
    // shapes that would otherwise become a path.
    const world = scratchWorld();
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'click Demo\n' },
    });
    const opened = await open(baseUrl, world.stateDir, world.destination);
    expect(opened.response.ok).toBe(true);
    const namesAtSend = recordNames(world);
    const recordsAtSend = recordsAsWritten(world, namesAtSend);
    expect(fs.readFileSync(world.destination, 'utf8')).toBe('open Demo\n');

    for (const hostile of HOSTILE_NAMES) {
      const before = snapshotTree(world.outer);
      const response = await answer(baseUrl, world.stateDir, batch(PLAN), {
        scriptDeliveryReceipt: { publicationId: hostile, version: script('v2', 2, hostile) },
      });

      expect(response.ok, hostile).toBe(true);
      const data = response.ok ? (response.data as Record<string, unknown>) : {};
      expect(data.savedScript, hostile).toBeUndefined();
      // Nothing the client opened is claimed by an id it never opened. A hostile name past the receipt's own
      // string budget makes the WHOLE receipt unreadable, and that is disclosed — as the receipt's own shape
      // problem, naming no publication. What must never appear is a failure carrying THIS hostile id, because
      // that would send the caller to fix a recording it does not own.
      const failure = data.scriptDeliveryFailure as { publicationId?: unknown } | undefined;
      expect(failure?.publicationId ?? '', hostile).toBe('');
      expect(fs.readFileSync(world.destination, 'utf8'), hostile).toBe('open Demo\n');
      expect(entriesThatMoved(world, before), hostile).toEqual([]);
      expect(recordsAsWritten(world, namesAtSend), hostile).toEqual(recordsAtSend);
      expect(nothingEscaped(world, [hostile]), hostile).toEqual([]);
    }
  },
);

skipOnWindows(
  'a valid matching batch receipt publishes the recorded destination through the same seam',
  async () => {
    // The counterpart the hostile receipt cases need to mean anything: a receipt that DOES match this client's
    // own publication publishes through the very code path they exercise. Without it, their "nothing moved"
    // result could come from the receipt never being honored rather than from the fields being refused.
    const world = scratchWorld();
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'click Demo\n' },
    });
    const opened = await open(baseUrl, world.stateDir, world.destination);
    const publicationId = opened.id;
    // The one name this client owns, as of BEFORE this answer arrives.
    const namesAtSend = recordNames(world);

    const before = snapshotTree(world.outer);
    const response = await answer(baseUrl, world.stateDir, batch(PLAN), {
      scriptDeliveryReceipt: { publicationId, version: script('v2', 2, publicationId) },
    });

    expect(response.ok).toBe(true);
    // The bytes arrived, at the destination THIS client recorded, and they are exactly the version's bytes. The
    // record file is the only other entry allowed to move, and only to the fields pinned below: so no staging
    // directory, no second record, and no entry anywhere the receipt could have named.
    expect(fs.readFileSync(world.destination, 'utf8')).toBe('click Demo\n');
    expect(
      entriesThatMoved(
        world,
        before,
        new Set([
          ...ownRecordFiles(world, namesAtSend),
          `${world.rel(world.destination)}=${bytesOf('click Demo\n')}`,
        ]),
      ),
    ).toEqual([]);
    // Revision 2, and the staging list EMPTY: the publication released the directory it staged in, and this
    // assertion is what proves no staging directory is still named there.
    expect(recordsAsWritten(world, namesAtSend)).toEqual([
      {
        name: namesAtSend[0],
        destination: world.destination,
        force: false,
        revision: 2,
        entry: { revision: 2, path: world.destination },
        staging: [],
      },
    ]);
    expect(nothingEscaped(world, HOSTILE_NAMES)).toEqual([]);
  },
);

skipOnWindows(
  'a hostile artifactId names no path: a version lands at the destination the client recorded',
  async () => {
    // An artifact id names BYTES. It goes into the download URL and never into a path, so a daemon that
    // answers one shaped like a path still gets its bytes written to the destination this client recorded,
    // and no file appears anywhere near the name the daemon supplied.
    //
    // Each name gets its OWN world: one publication, its own destination, its own watched tree. A shared
    // destination would let a later iteration fail with `script_target_exists` on a file an earlier one
    // legitimately wrote, and a dropped delivery would hide among those expected failures. Here every name
    // must produce this exact tree, name the path, carry the bytes, and carry no failure, or it fails.
    for (const hostile of SERVED_HOSTILE_NAMES) {
      const world = scratchWorld();
      const baseUrl = await artifactServer({ [hostile]: { body: 'open Demo\n' } });

      const { response, recordsAtSend } = await open(baseUrl, world.stateDir, world.destination, {
        respond: (id) =>
          answer(baseUrl, world.stateDir, request('open'), {
            scriptPublicationId: id,
            artifacts: [{ ...script(hostile, 1, id) }],
          }),
      });
      // The fixture lists the record directory at SEND, so this name is independent of the answer's effect.
      expect(recordsAtSend, hostile).toHaveLength(1);

      expect(response.ok, hostile).toBe(true);
      // `savedScript` is the published path, as a string, and the answer names exactly the recorded
      // destination. A client that wrote somewhere the response steered it to fails here, and so does one
      // that dropped the delivery: no path, and a failure it had no reason to report.
      const data = response.ok ? (response.data as Record<string, unknown>) : {};
      expect(data.savedScript, hostile).toBe(world.destination);
      expect(data.scriptDeliveryFailure, hostile).toBeUndefined();
      // The whole tree, from an empty one: the record chain, the destination's ground, the destination at the
      // version's bytes, and the one record file this publication owns. `recordsAsWritten` below proves that
      // file is ONE record and what it says, so its name is exact even though its contents are allowed here.
      expect(
        entriesThatMoved(
          world,
          new Map(),
          new Set([
            ...preparedGround(world),
            ...ownRecordFiles(world, recordsAtSend),
            `${world.rel(world.destination)}=${bytesOf('open Demo\n')}`,
          ]),
        ),
        hostile,
      ).toEqual([]);
      // One record, its exact name, the destination the CLIENT recorded, revision 1, and nothing staged.
      expect(recordsAsWritten(world, recordsAtSend), hostile).toEqual([
        {
          name: recordsAtSend[0],
          destination: world.destination,
          force: false,
          revision: 1,
          entry: { revision: 1, path: world.destination },
          staging: [],
        },
      ]);
      expect(nothingEscaped(world, [hostile]), hostile).toEqual([]);
    }
  },
);

skipOnWindows(
  'an artifactId that names no servable bytes is disclosed as a failure and writes nothing',
  async () => {
    // `..` is the id whose download URL collapses to the server's root, so the daemon's own answer carries no
    // bytes. The client keeps the command successful and DISCLOSES the failure: what it must not do is report
    // success with a path, or publish anything outside the record chain it owns.
    const world = scratchWorld();
    const baseUrl = await artifactServer({ '..': { body: 'open Demo\n' } });

    const { response, recordsAtSend } = await open(baseUrl, world.stateDir, world.destination, {
      respond: (id) =>
        answer(baseUrl, world.stateDir, request('open'), {
          scriptPublicationId: id,
          artifacts: [{ ...script('..', 1, id) }],
        }),
    });
    expect(recordsAtSend).toHaveLength(1);

    expect(response.ok).toBe(true);
    const data = response.ok ? (response.data as Record<string, unknown>) : {};
    expect(data.savedScript).toBeUndefined();
    expect(data.scriptDeliveryFailure).toBeDefined();
    // The client may prepare the ground for the destination it chose for itself, and it did, but no script
    // entry was created there and nothing else appeared anywhere in the watched tree.
    expect(fs.existsSync(world.destination)).toBe(false);
    expect(
      entriesThatMoved(
        world,
        new Map(),
        new Set([...preparedGround(world), ...ownRecordFiles(world, recordsAtSend)]),
      ),
    ).toEqual([]);
    expect(nothingEscaped(world, ['..'])).toEqual([]);
  },
);

skipOnWindows(
  'a script artifact carrying a hostile file name is still written to the recorded destination',
  async () => {
    // `fileName` is the one artifact field a response uses to NAME a file, and the script route never reads
    // it: a `session-script` artifact is delivered to the destination this client recorded for itself, so a
    // daemon that answers a name instead of a path gets its bytes written in the client's own words.
    const world = scratchWorld();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const opened = await open(baseUrl, world.stateDir, world.destination, {
      respond: (id) =>
        answer(baseUrl, world.stateDir, request('open'), {
          scriptPublicationId: id,
          artifacts: [{ ...script('v1', 1, id), fileName: '../../../../tmp/evil.ad' }],
        }),
    });
    expect(opened.recordsAtSend).toHaveLength(1);

    expect(opened.response.ok).toBe(true);
    expect(fs.readFileSync(world.destination, 'utf8')).toBe('open Demo\n');
    expect(
      entriesThatMoved(
        world,
        new Map(),
        new Set([
          ...preparedGround(world),
          ...ownRecordFiles(world, opened.recordsAtSend),
          `${world.rel(world.destination)}=${bytesOf('open Demo\n')}`,
        ]),
      ),
    ).toEqual([]);
    expect(nothingEscaped(world, ['../../../../tmp/evil.ad'])).toEqual([]);
  },
);

skipOnWindows(
  'a hostile failure text on a batch receipt is disclosed as prose and never opened or created',
  async () => {
    // A delivery failure carries a `message` and a `hint` the daemon writes, and the client shows them. They
    // have to stay strings: a path-shaped one is not a place the client is allowed to act on. Both are spelled
    // so that acting on either would land INSIDE the watched tree and be reported, or above it and be caught by
    // the escape check. This runs on a batch, the only command whose receipt is read.
    const world = scratchWorld();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
    const publicationId = (await open(baseUrl, world.stateDir, world.destination)).id;
    const namesAtSend = recordNames(world);
    const recordsAtSend = recordsAsWritten(world, namesAtSend);

    const before = snapshotTree(world.outer);
    const response = await answer(baseUrl, world.stateDir, batch(PLAN), {
      scriptDeliveryReceipt: {
        publicationId,
        failures: [
          {
            publicationId,
            reason: 'script_delivery_failed',
            message: '../../../../tmp/etc/passwd',
            hint: '../two/scratch/pwned.ad',
          },
        ],
      },
    });

    expect(response.ok).toBe(true);
    // The prose reached the caller, and the text named no path it was allowed to touch.
    const data = response.ok ? (response.data as Record<string, unknown>) : {};
    expect(JSON.stringify(data.scriptDeliveryFailure)).toContain('../../../../tmp/etc/passwd');
    expect(entriesThatMoved(world, before)).toEqual([]);
    expect(fs.readFileSync(world.destination, 'utf8')).toBe('open Demo\n');
    expect(recordsAsWritten(world, namesAtSend)).toEqual(recordsAtSend);
    expect(nothingEscaped(world, ['../../../../tmp/etc/passwd'])).toEqual([]);
  },
);
