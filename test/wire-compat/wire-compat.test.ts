/**
 * Daemon RPC wire-surface gate, offline half (#1432).
 *
 * ADR 0006 fixes when `DAEMON_RPC_PROTOCOL_VERSION` must be bumped and until
 * now nothing checked it. This lane is the tripwire: it fails the moment a
 * declaration the manifest calls wire surface changes shape, naming the symbol
 * and printing the digest to paste. It needs no history and no network, so it
 * runs in `unit-core` on every PR.
 *
 * It deliberately cannot tell a bump from an ack — both look like an edited
 * ledger from a single commit. `pnpm check:daemon-wire-compat` answers that
 * half against the last RELEASED tag, which is the only baseline ADR 0006 and
 * #1432 accept.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../../src/daemon/http-health.ts';
import {
  digestDeclaration,
  readTopLevelDeclarationNames,
  readTypeReferences,
} from './declaration-digest.ts';
import { digestWireSurface, readWireLedger, WIRE_LEDGER_PATH } from './ledger.ts';
import {
  WIRE_DECLARATIONS,
  WIRE_SURFACE,
  WIRE_SURFACE_FILES,
  wireDeclarationKey,
} from './surface.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const ledger = readWireLedger(repoRoot);
const digests = digestWireSurface(repoRoot, WIRE_DECLARATIONS, digestDeclaration);

function readSource(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

test('the ledger records the protocol version the daemon advertises', () => {
  assert.equal(
    ledger.protocolVersion,
    DAEMON_RPC_PROTOCOL_VERSION,
    `${WIRE_LEDGER_PATH} says protocol ${ledger.protocolVersion} but DAEMON_RPC_PROTOCOL_VERSION is ` +
      `${DAEMON_RPC_PROTOCOL_VERSION}. Bumping the constant means updating the ledger in the same ` +
      `commit — see test/wire-compat/README.md.`,
  );
});

test('the ledger covers exactly the declarations the manifest claims', () => {
  const claimed = [...new Set(WIRE_DECLARATIONS.map(wireDeclarationKey))].sort();
  const recorded = Object.keys(ledger.declarations).sort();
  assert.deepEqual(
    recorded,
    claimed,
    `${WIRE_LEDGER_PATH} and test/wire-compat/surface.ts disagree about which declarations are wire ` +
      `surface. Add or drop the ledger entry in the same commit as the manifest change.`,
  );
});

test('every wire declaration still hashes to its ledger digest', () => {
  const drifted = [...digests].filter(([key, digest]) => ledger.declarations[key] !== digest);
  assert.deepEqual(
    drifted.map(([key]) => key),
    [],
    `Daemon RPC wire surface changed (ADR 0006). Each line below is a declaration whose shape ` +
      `moved:\n${drifted
        .map(
          ([key, digest]) =>
            `  ${key}\n    now: ${digest}\n    ledger: ${ledger.declarations[key]}`,
        )
        .join('\n')}\n` +
      `Decide which ADR 0006 case this is, then follow test/wire-compat/README.md: a breaking ` +
      `change bumps DAEMON_RPC_PROTOCOL_VERSION, an additive one adds a compatibleChanges entry. ` +
      `Either way paste the "now" digest into ${WIRE_LEDGER_PATH}.`,
  );
});

test('every compatible-change ack names a declaration at its current digest', () => {
  const stale = ledger.compatibleChanges.filter(
    (ack) => digests.get(ack.declaration) !== ack.digest,
  );
  assert.deepEqual(
    stale.map((ack) => ack.declaration),
    [],
    `${WIRE_LEDGER_PATH} carries compatibleChanges entries whose digest is no longer current. An ` +
      `ack covers one specific post-change shape so it cannot be recycled for the next change; ` +
      `drop the stale entry — git history is the audit trail, the ledger is the gate.`,
  );
  for (const ack of ledger.compatibleChanges) {
    assert.ok(
      ack.rationale.trim().length > 0,
      `The compatibleChanges entry for ${ack.declaration} needs a rationale saying why a peer on ` +
        `the previous protocol version still parses this payload (ADR 0006, "additive changes").`,
    );
  }
});

/** Every top-level name a manifest file declares, mapped to that file. */
function declarationHomes(): Map<string, string> {
  const homes = new Map<string, string>();
  for (const file of WIRE_SURFACE_FILES) {
    for (const name of readTopLevelDeclarationNames(file, readSource(file))) {
      homes.set(name, file);
    }
  }
  return homes;
}

// Without this, adding `foo?: NewShape` to a wire type would move only that
// type's digest and leave `NewShape` — the declaration that actually decides
// what the peer parses — outside the gate. The manifest's closure is therefore
// derived from the AST rather than trusted: "something enumerates N" (#1412).
test('the manifest is closed over the wire types it references', () => {
  const homes = declarationHomes();
  const claimed = new Set(WIRE_DECLARATIONS.map(wireDeclarationKey));
  const omitted = new Set<string>();
  for (const ref of WIRE_DECLARATIONS) {
    for (const name of readTypeReferences(ref.file, readSource(ref.file), ref.name)) {
      const home = homes.get(name);
      if (!home) continue;
      const key = `${home}#${name}`;
      if (!claimed.has(key)) omitted.add(`${key} (reached from ${ref.name})`);
    }
  }
  assert.deepEqual(
    [...omitted].sort(),
    [],
    `These declarations are referenced by the daemon RPC wire surface but are not listed in ` +
      `test/wire-compat/surface.ts, so their shape is ungated. Add them to the group whose ADR 0006 ` +
      `bullet they serve.`,
  );
});

test('every manifest group cites the ADR 0006 bullet it covers', () => {
  for (const group of WIRE_SURFACE) {
    assert.ok(
      group.adrBullet.trim().length > 0 && group.declarations.length > 0,
      `Each wire-surface group quotes one ADR 0006 bullet and lists at least one declaration; a ` +
        `bullet with nothing to digest belongs in "uncovered" with its reason instead.`,
    );
  }
});
