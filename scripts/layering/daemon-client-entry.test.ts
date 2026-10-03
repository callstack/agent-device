import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonClientEntry,
  DAEMON_CLIENT_ENTRY_EDGES,
  DAEMON_CLIENT_ENTRY_RULE,
} from './daemon-client-entry.ts';
import { targetDagZone, type ResolvedImportEdge } from './model.ts';

function clientEdge(
  file: string,
  target: string,
  kind: 'type' | 'value' | 'dynamic' = 'type',
): ResolvedImportEdge {
  return {
    file,
    target,
    spec: target,
    line: 1,
    dynamic: kind === 'dynamic',
    typeOnly: kind === 'type',
    symbols: [],
    bindingResidue: false,
    fromZone: targetDagZone(file),
    toZone: targetDagZone(target),
  };
}

function recordedWireEdges(): ResolvedImportEdge[] {
  return DAEMON_CLIENT_ENTRY_EDGES.map((edge) => clientEdge(edge.file, edge.target, 'type'));
}

test('the recorded wire-only edges are the accepted residue', () => {
  assert.deepEqual(checkDaemonClientEntry(recordedWireEdges()), []);
});

test('a client import of a non-daemon module is not daemon-client entry surface', () => {
  const edges = [
    ...recordedWireEdges(),
    clientEdge('src/daemon-client/daemon-client-metadata.ts', 'src/daemon-process.ts', 'value'),
    clientEdge('src/daemon-client/daemon-client-lifecycle.ts', 'src/config.ts', 'value'),
  ];
  assert.deepEqual(checkDaemonClientEntry(edges), []);
});

test('a planted runtime import of daemon internals by the client is red', () => {
  const violations = checkDaemonClientEntry([
    ...recordedWireEdges(),
    clientEdge('src/daemon-client/daemon-client-metadata.ts', 'src/daemon/config.ts', 'value'),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, DAEMON_CLIENT_ENTRY_RULE);
  assert.match(violations[0]!.message, /value-imports daemon internals/);
  assert.match(violations[0]!.message, /daemon-client-metadata\.ts -> src\/daemon\/config\.ts/);
});

test('a planted dynamic import of daemon internals by the client is red', () => {
  const violations = checkDaemonClientEntry([
    ...recordedWireEdges(),
    clientEdge('src/daemon-client/daemon-client-progress.ts', 'src/daemon/config.ts', 'dynamic'),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /dynamic-imports daemon internals/);
});

test('a runtime import is red even when the same pair is a recorded type edge', () => {
  const violations = checkDaemonClientEntry([
    ...recordedWireEdges(),
    clientEdge('src/daemon-client/daemon-client-rpc.ts', 'src/daemon/daemon-request.ts', 'value'),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /value-imports daemon internals/);
});

test('an unrecorded type import of daemon internals is red', () => {
  const violations = checkDaemonClientEntry([
    ...recordedWireEdges(),
    clientEdge('src/daemon-client/daemon-launch-spec.ts', 'src/daemon/daemon-request.ts'),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /unclassified daemon-client import of daemon internals/);
  assert.match(violations[0]!.message, /daemon-launch-spec\.ts -> src\/daemon\/daemon-request\.ts/);
});

test('a type import of a daemon module other than the recorded type is red', () => {
  const recorded = DAEMON_CLIENT_ENTRY_EDGES.map((edge) =>
    edge.file === 'src/daemon-client/daemon-client.ts'
      ? clientEdge(edge.file, 'src/daemon/session-state.ts', 'type')
      : clientEdge(edge.file, edge.target, 'type'),
  );
  const violations = checkDaemonClientEntry(recorded);
  // The moved edge is undeclared (unclassified) and its recorded edge is now gone (stale).
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => /unclassified daemon-client import/.test(v.message)));
  assert.ok(violations.some((v) => /stale declared edge/.test(v.message)));
});

test('a recorded edge the tree no longer imports is stale', () => {
  const dropped = recordedWireEdges().slice(1);
  const violations = checkDaemonClientEntry(dropped);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /stale declared edge/);
  assert.match(violations[0]!.message, new RegExp(DAEMON_CLIENT_ENTRY_EDGES[0]!.file));
});
