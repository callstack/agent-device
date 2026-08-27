import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyLead, policyViolation, ZONE_POLICIES } from './zone-policy.ts';

// R2-R3 (and the retired R1) were predicate functions with no unit test for eight months: the only thing
// exercising them was the real tree, which is clean, so a rule that had silently stopped matching
// would have looked exactly like a rule that was being obeyed. These tests assert each boundary
// fires AND each documented exemption holds, so the table cannot quietly become decoration.

type Kind = { typeOnly?: boolean; dynamic?: boolean };

function edge(file: string, fromZone: string, toZone: string, kind: Kind = {}) {
  return {
    file,
    fromZone,
    toZone,
    imp: {
      spec: `../${toZone}/thing.ts`,
      line: 1,
      dynamic: kind.dynamic ?? false,
      typeOnly: kind.typeOnly ?? false,
    },
  };
}

/** Every policy that fires for an edge, by rule id. */
function firing(e: ReturnType<typeof edge>): string[] {
  return ZONE_POLICIES.filter((policy) => policyViolation(policy, e) !== null).map((p) => p.rule);
}

test('R2 commands-floor closes the four zones below the command surface, whatever the kind', () => {
  for (const zone of ['platforms', 'core', 'daemon']) {
    for (const kind of [{}, { typeOnly: true }, { dynamic: true }]) {
      assert.ok(
        firing(edge(`src/${zone}/thing.ts`, zone, 'commands', kind)).includes('R2 commands-floor'),
        `${zone} -> commands ${JSON.stringify(kind)} must violate R2`,
      );
    }
  }

  // Zones at or above the command surface are not governed by R2.
  assert.deepEqual(firing(edge('src/cli/run.ts', 'cli', 'commands')), []);
  assert.deepEqual(firing(edge('src/mcp/tools.ts', 'mcp', 'commands')), []);
});

test('R3 platforms-seam closes static value imports and opens the two declared seam owners', () => {
  // Closed from an ordinary zone.
  assert.deepEqual(firing(edge('src/cli/run.ts', 'cli', 'platforms')), ['R3 platforms-seam']);

  // Open to the seam owners.
  for (const file of ['src/core/interactors/android.ts', 'src/sdk/android-adb.ts']) {
    assert.deepEqual(firing(edge(file, 'core', 'platforms')), [], `${file} is a seam owner`);
  }

  // The daemon has completed ADR 0019 and is no longer a platform seam. Neither its server nor
  // its process-boundary client may reach platform code directly.
  assert.deepEqual(firing(edge('src/daemon/handlers/perf.ts', 'daemon', 'platforms')), [
    'R3 platforms-seam',
  ]);
  assert.deepEqual(firing(edge('src/daemon/client/daemon-client.ts', 'daemon', 'platforms')), [
    'R3 platforms-seam',
  ]);

  // Both tolerated kinds are the documented escape hatch that preserves CLI cold-start.
  assert.deepEqual(firing(edge('src/cli/run.ts', 'cli', 'platforms', { dynamic: true })), []);
  assert.deepEqual(firing(edge('src/cli/run.ts', 'cli', 'platforms', { typeOnly: true })), []);
});

test('every policy carries a hint, and the lead names the kind it rejected', () => {
  // ADR 0010: an error that does not say what to do instead is a rule nobody can act on.
  for (const policy of ZONE_POLICIES) {
    assert.ok(policy.hint.length > 20, `${policy.rule} needs an actionable hint`);
  }

  assert.match(
    policyLead(edge('a', 'platforms', 'commands')),
    /platforms\/ must not import commands\//,
  );
  assert.match(
    policyLead(edge('a', 'core', 'commands', { typeOnly: true })),
    /must not type-only import commands\//,
  );
  assert.match(
    policyLead(edge('a', 'cli', 'platforms', { dynamic: true })),
    /must not dynamic import platforms\//,
  );
});

test('a policy states its scope with exactly one of `to` or `exceptTo`', () => {
  // Both would make the target set ambiguous; neither would silently govern every target, which is
  // never what a boundary means.
  for (const policy of ZONE_POLICIES) {
    assert.notEqual(
      Boolean(policy.to) === Boolean(policy.exceptTo),
      true,
      `${policy.rule} must set exactly one of to/exceptTo`,
    );
  }
});
