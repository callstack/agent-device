import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyLead, policyViolation, ZONE_POLICIES } from './zone-policy.ts';

// The folder policies originally had no unit test: the only thing exercising them was a clean real
// tree, so a rule that silently stopped matching looked like one being obeyed. These tests keep the
// remaining R2 policy from becoming decoration.

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
      symbols: [],
    },
  };
}

/** Every policy that fires for an edge, by rule id. */
function firing(e: ReturnType<typeof edge>): string[] {
  return ZONE_POLICIES.filter((policy) => policyViolation(policy, e) !== null).map((p) => p.rule);
}

test('R2 commands-floor closes the remaining zones below the command surface, whatever the kind', () => {
  for (const zone of ['core', 'daemon']) {
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

test('the retired R3 platforms seam has no zone-policy declaration', () => {
  assert.equal(
    ZONE_POLICIES.some(({ rule }) => rule === 'R3 platforms-seam'),
    false,
  );
});

test('every policy carries a hint, and the lead names the kind it rejected', () => {
  // ADR 0010: an error that does not say what to do instead is a rule nobody can act on.
  for (const policy of ZONE_POLICIES) {
    assert.ok(policy.hint.length > 20, `${policy.rule} needs an actionable hint`);
  }

  assert.match(policyLead(edge('a', 'core', 'commands')), /core\/ must not import commands\//);
  assert.match(
    policyLead(edge('a', 'core', 'commands', { typeOnly: true })),
    /must not type-only import commands\//,
  );
  assert.match(
    policyLead(edge('a', 'core', 'commands', { dynamic: true })),
    /must not dynamic import commands\//,
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
