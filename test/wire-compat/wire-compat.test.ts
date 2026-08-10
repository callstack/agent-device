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
import { isExternalWireSpecifier, WIRE_CLOSURE_WAIVERS } from './closure-policy.ts';
import { findClosureGaps } from './closure.ts';
import { digestDeclaration } from './declaration-digest.ts';
import { digestWireSurface, readWireLedger, WIRE_LEDGER_PATH } from './ledger.ts';
import { WIRE_DECLARATIONS, WIRE_SURFACE, wireDeclarationKey } from './surface.ts';

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

// Without this, adding `foo?: NewShape` to a wire type would move only that
// type's digest and leave `NewShape` — the declaration that actually decides
// what the peer parses — outside the gate. The manifest's closure is therefore
// derived from the AST rather than trusted: "something enumerates N" (#1412).
//
// It FAILS CLOSED (review P1). The first version scanned only the manifest's
// own files and skipped any name it could not place, so an imported payload
// shape escaped entirely. Now every referenced name must land somewhere
// someone wrote down: a listed declaration, a closure-policy waiver, a
// declared external module, or the TypeScript global set.
test('the manifest is closed over the wire types it references', () => {
  const { omitted, unresolved } = findClosureGaps({
    repoRoot,
    readSource,
    declarations: WIRE_DECLARATIONS,
    claimed: new Set(WIRE_DECLARATIONS.map(wireDeclarationKey)),
    waivers: WIRE_CLOSURE_WAIVERS,
    isExternalSpecifier: isExternalWireSpecifier,
  });

  assert.deepEqual(
    omitted,
    [],
    `These declarations are referenced by the daemon RPC wire surface but are neither listed in ` +
      `test/wire-compat/surface.ts nor waived in closure-policy.ts, so their shape is ungated. ` +
      `List the ones that carry payload; waive the ones that cannot, with the reason.`,
  );
  assert.deepEqual(
    unresolved,
    [],
    `The closure could not place these type names, and it fails closed rather than skipping them ` +
      `— an unplaceable name is exactly how an imported payload shape escaped before. Either the ` +
      `import is a module that belongs in WIRE_EXTERNAL_MODULES, or the resolver needs to learn ` +
      `the specifier form (test/wire-compat/module-resolution.ts).`,
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
