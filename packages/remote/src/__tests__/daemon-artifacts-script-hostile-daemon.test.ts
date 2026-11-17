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
 * The entries the client's own script route creates: its record-directory chain and the hashed record files
 * inside it. A record name is a digest of the client's own publication identity, so it is bounded; a stray
 * entry the response named in that directory does not match this and is reported.
 */
function clientStateEntries(name: string, kind: string): boolean {
  const recordDir = 'state/remote-connections/session-scripts';
  if (name === 'state' || name === `${recordDir}` || name === 'state/remote-connections') {
    return kind === 'dir';
  }
  if (!name.startsWith(`${recordDir}/`) || kind !== 'file') return false;
  // A record name is a digest of the client's OWN publication identity, so one file with this shape is
  // accounted for; a name a response put there does not match and is reported.
  return /^[0-9a-f]{64}\.json$/.test(name.slice(recordDir.length + 1));
}

function world() {
  const root = fs.realpathSync(mkdtempForTestSync('script-hostile-'));
  return {
    root,
    stateDir: path.join(root, 'state'),
    destination: path.join(root, 'caller', 'journey.ad'),
  };
}

/** Every name under `root`, recursively, each with the kind of entry it is. */
function snapshotTree(root: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!fs.existsSync(root)) return found;
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      found.set(
        name,
        entry.isDirectory()
          ? 'dir'
          : entry.isSymbolicLink()
            ? 'link'
            : entry.isFile()
              ? 'file'
              : 'other',
      );
      if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
    }
  };
  walk(root, '');
  return found;
}

/**
 * Names that appeared under `root` since `before`, EVERY subtree included: the `state` and `caller` trees
 * belong to the client, so a steered write can add an entry there and excluding either whole would hide
 * exactly what these cases look for. `allowed` is the caller's own account of what the interaction legitimately
 * produced; anything else is reported with its kind.
 */
function namesThatAppeared(
  root: string,
  before: Map<string, string>,
  allowed: (name: string, kind: string) => boolean = () => false,
): string[] {
  return [...snapshotTree(root)]
    .filter(([name, kind]) => before.get(name) !== kind && !allowed(name, kind))
    .map(([name, kind]) => `${name} (${kind})`);
}

/** Allows the client's record files and one destination, with the directories that carry it. */
function clientsOwn(root: string, destination: string) {
  const ground = clientsOwnGround(root, destination);
  const file = path.relative(root, destination).split(path.sep).join('/');
  return (name: string, kind: string) => ground(name, kind) || name === file;
}

/** Allows the client's record files and the DIRECTORIES that carry its destination, not the file itself. */
function clientsOwnGround(root: string, destination: string) {
  const parts = path.relative(root, destination).split(path.sep).join('/').split('/');
  const chain = new Set(parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')));
  return (name: string, kind: string) =>
    clientStateEntries(name, kind) || (kind === 'dir' && chain.has(name));
}

/**
 * The paths a hostile name would resolve to OUTSIDE the scratch root, which the tree snapshot cannot see.
 * A name resolving to an ANCESTOR of the root (`..`, `../..`) is left out: that directory stood here before
 * the daemon was ever asked, so its existence proves nothing about this interaction.
 */
function escapeTargets(root: string, names: readonly string[]): string[] {
  return names
    .map((name) => path.resolve(root, name))
    .filter((target) => {
      if (target === root || target.startsWith(root + path.sep)) return false;
      return !root.startsWith(target + path.sep);
    });
}

function nothingEscaped(root: string, names: readonly string[]): boolean {
  return escapeTargets(root, names).every((target) => !fs.existsSync(target));
}

/** The destination each of the client's own records names, which a response must never be able to change. */
function recordedDestinations(stateDir: string): string[] {
  return records(stateDir).map((name) => {
    const record = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'remote-connections', 'session-scripts', name), 'utf8'),
    ) as { destination?: unknown };
    if (typeof record.destination !== 'string') throw new Error('a record names no destination');
    return record.destination;
  });
}

skipOnWindows(
  'a batch version belonging to another publication is dropped before its fields reach a path',
  async () => {
    // The contract refuses a version whose `scriptPublicationId` differs from the receipt's. The pair is
    // hostile here in the way that matters: the second id is ANOTHER publication this same client owns, so a
    // client that skipped the match would take this batch answer's bytes and write them into that other
    // recording's destination — one caller's response steering a write into a different publication's file.
    const { root, stateDir, destination } = world();
    const other = path.join(root, 'caller', 'other.ad');
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'click Demo\n' },
      v9: { body: 'type Demo evil\n' },
    });
    const first = await open(baseUrl, stateDir, destination);
    const second = await open(baseUrl, stateDir, other, {
      respond: (id) =>
        answer(baseUrl, stateDir, request('open'), {
          scriptPublicationId: id,
          artifacts: [{ ...script('v1', 1, id), artifactId: 'v1' }],
        }),
    });
    expect(first.response.ok && second.response.ok).toBe(true);
    expect(fs.readFileSync(other, 'utf8')).toBe('open Demo\n');
    const recordNamesAtStart = records(stateDir);

    for (const hostile of HOSTILE_NAMES) {
      const before = snapshotTree(root);
      const response = await answer(baseUrl, stateDir, batch(PLAN), {
        scriptDeliveryReceipt: {
          publicationId: first.id,
          version: { ...script('v9', 2, second.id), artifactId: 'v9' },
        },
      });

      expect(response.ok, hostile).toBe(true);
      // Neither recording moved: the batch's own destination keeps its bytes, and the version carrying the
      // OTHER publication's id is refused rather than published into it.
      expect(fs.readFileSync(destination, 'utf8'), hostile).toBe('open Demo\n');
      expect(fs.readFileSync(other, 'utf8'), hostile).toBe('open Demo\n');
      const data = response.ok ? (response.data as Record<string, unknown>) : {};
      expect(data.savedScript, hostile).toBeUndefined();
      expect(namesThatAppeared(root, before), hostile).toEqual([]);
      expect(records(stateDir), hostile).toEqual(recordNamesAtStart);
      expect(nothingEscaped(root, [hostile]), hostile).toBe(true);
    }
  },
);

skipOnWindows(
  'a receipt naming a publication this client never opened is dropped and disclosed',
  async () => {
    // The receipt's own `publicationId` is the daemon's claim about which recording it is delivering. When no
    // record of this client matches it, nothing is honored: the answer is disclosed as an unreadable receipt,
    // and no destination is touched. HOSTILE_NAMES covers the shapes that would otherwise become a path, and
    // the whole tree is asked, `state` included, because that is where a trusted id would be written.
    const { root, stateDir, destination } = world();
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'click Demo\n' },
    });
    const opened = await open(baseUrl, stateDir, destination);
    expect(opened.response.ok).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
    const recordNamesAtStart = records(stateDir);

    for (const hostile of HOSTILE_NAMES) {
      const before = snapshotTree(root);
      const response = await answer(baseUrl, stateDir, batch(PLAN), {
        scriptDeliveryReceipt: { publicationId: hostile, version: script('v2', 2, hostile) },
      });

      expect(response.ok, hostile).toBe(true);
      expect(fs.readFileSync(destination, 'utf8'), hostile).toBe('open Demo\n');
      // Nothing the hostile id named came into being, and the client's own record is untouched.
      expect(namesThatAppeared(root, before, clientsOwn(root, destination)), hostile).toEqual([]);
      expect(records(stateDir), hostile).toEqual(recordNamesAtStart);
      expect(nothingEscaped(root, [hostile]), hostile).toBe(true);
    }

    expect(records(stateDir)).toHaveLength(1);
    expect(records(stateDir)[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  },
);

skipOnWindows(
  'a valid matching batch receipt publishes the recorded destination through the same seam',
  async () => {
    // The counterpart the hostile receipt cases need to mean anything: a receipt that DOES match this client's
    // own publication publishes through the very code path they exercise. Without it, their "nothing was
    // written" result could come from the receipt never being honored rather than from the fields being refused.
    const { root, stateDir, destination } = world();
    const baseUrl = await artifactServer({
      v1: { body: 'open Demo\n' },
      v2: { body: 'click Demo\n' },
    });
    const opened = await open(baseUrl, stateDir, destination);
    const publicationId = opened.id;

    const before = snapshotTree(root);
    const response = await answer(baseUrl, stateDir, batch(PLAN), {
      scriptDeliveryReceipt: {
        publicationId,
        version: script('v2', 2, publicationId),
      },
    });

    expect(response.ok).toBe(true);
    // The bytes arrived, at the destination THIS client recorded, and the tree gained no entry at all: the
    // destination already stood there, and no staging directory or extra record was left behind.
    expect(fs.readFileSync(destination, 'utf8')).toBe('click Demo\n');
    expect(namesThatAppeared(root, before)).toEqual([]);
    expect(recordedDestinations(stateDir)).toEqual([destination]);
  },
);

skipOnWindows(
  'a hostile artifactId names no path: a version lands at the destination the client recorded',
  async () => {
    // An artifact id names BYTES. It goes into the download URL and never into a path, so a daemon that
    // answers one shaped like a path still gets its bytes written to the destination this client recorded,
    // and no file appears anywhere near the name the daemon supplied.
    //
    // Each name gets its OWN world: one publication, its own destination, its own scratch root. A shared
    // destination would let a later iteration fail with `script_target_exists` on a file an earlier one
    // legitimately wrote, and a dropped delivery would hide among those expected failures. Here every case
    // must name the path, carry the bytes, and carry no failure, or this case fails.
    for (const hostile of SERVED_HOSTILE_NAMES) {
      const { root, stateDir, destination } = world();
      const baseUrl = await artifactServer({ [hostile]: { body: 'open Demo\n' } });

      const { response } = await open(baseUrl, stateDir, destination, {
        respond: (id) =>
          answer(baseUrl, stateDir, request('open'), {
            scriptPublicationId: id,
            artifacts: [{ ...script(hostile, 1, id) }],
          }),
      });

      expect(response.ok, hostile).toBe(true);
      // `savedScript` is the published path, as a string, and the answer names exactly the recorded
      // destination. A client that wrote somewhere the response steered it to fails here, and so does one
      // that dropped the delivery: no path, and a failure it had no reason to report.
      const data = response.ok ? (response.data as Record<string, unknown>) : {};
      expect(data.savedScript, hostile).toBe(destination);
      expect(data.scriptDeliveryFailure, hostile).toBeUndefined();
      expect(fs.readFileSync(destination, 'utf8'), hostile).toBe('open Demo\n');
      expect(namesThatAppeared(root, new Map(), clientsOwn(root, destination)), hostile).toEqual(
        [],
      );
      expect(recordedDestinations(stateDir), hostile).toEqual([destination]);
      expect(nothingEscaped(root, [hostile]), hostile).toBe(true);
    }
  },
);

skipOnWindows(
  'an artifactId that names no servable bytes is disclosed as a failure and writes nothing',
  async () => {
    // `..` is the id whose download URL collapses to the server's root, so the daemon's own answer carries no
    // bytes. The client keeps the command successful and DISCLOSES the failure: what it must not do is report
    // success with a path, or publish anything outside the record chain it owns.
    const { root, stateDir, destination } = world();
    const baseUrl = await artifactServer({ '..': { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination, {
      respond: (id) =>
        answer(baseUrl, stateDir, request('open'), {
          scriptPublicationId: id,
          artifacts: [{ ...script('..', 1, id) }],
        }),
    });

    expect(response.ok).toBe(true);
    const data = response.ok ? (response.data as Record<string, unknown>) : {};
    expect(data.savedScript).toBeUndefined();
    expect(data.scriptDeliveryFailure).toBeDefined();
    // The client may prepare the ground for the destination it chose for itself, and it did, but no script
    // entry was created there and nothing else appeared anywhere in the tree.
    expect(fs.existsSync(destination)).toBe(false);
    expect(namesThatAppeared(root, new Map(), clientsOwnGround(root, destination))).toEqual([]);
  },
);

skipOnWindows(
  'a script artifact carrying a hostile file name is still written to the recorded destination',
  async () => {
    // `fileName` is the one artifact field a response uses to NAME a file, and the script route never reads
    // it: a `session-script` artifact is delivered to the destination this client recorded for itself, so a
    // daemon that answers a name instead of a path gets its bytes written in the client's own words.
    const { root, stateDir, destination } = world();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const opened = await open(baseUrl, stateDir, destination, {
      respond: (id) =>
        answer(baseUrl, stateDir, request('open'), {
          scriptPublicationId: id,
          artifacts: [{ ...script('v1', 1, id), fileName: '../../../../tmp/evil.ad' }],
        }),
    });

    expect(opened.response.ok).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
    expect(recordedDestinations(stateDir)).toEqual([destination]);
    expect(namesThatAppeared(root, new Map(), clientsOwn(root, destination))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'tmp'))).toBe(false);
  },
);

skipOnWindows(
  'a hostile failure text on a batch receipt is disclosed as prose and never opened or created',
  async () => {
    // A delivery failure carries a `message` and a `hint` the daemon writes, and the client shows them. They
    // have to stay strings: a path-shaped one is not a place the client is allowed to act on. This runs on a
    // batch, the only command whose receipt is read, so the failure really travels the disclosure path.
    const { root, stateDir, destination } = world();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
    const publicationId = (await open(baseUrl, stateDir, destination)).id;

    const before = snapshotTree(root);
    const response = await answer(baseUrl, stateDir, batch(PLAN), {
      scriptDeliveryReceipt: {
        publicationId,
        failures: [
          {
            publicationId,
            reason: 'script_delivery_failed',
            message: '../../../../etc/passwd',
            hint: '/absolute/path/that/does/not/exist',
          },
        ],
      },
    });

    expect(response.ok).toBe(true);
    // The prose reached the caller, and the text named no path it was allowed to touch.
    const data = response.ok ? (response.data as Record<string, unknown>) : {};
    expect(JSON.stringify(data.scriptDeliveryFailure)).toContain('../../../../etc/passwd');
    expect(namesThatAppeared(root, before, clientsOwn(root, destination))).toEqual([]);
    expect(recordedDestinations(stateDir)).toEqual([destination]);
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  },
);
