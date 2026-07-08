import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertRunnerSourceIncludes, PROJECT_ROOT } from './runner-source-assertions.ts';
import {
  INTERACTION_DISPATCH_PATHS,
  INTERACTION_GUARANTEES,
  INTERACTION_PATH_IDS,
} from '../interaction-guarantees.ts';

// ADR 0011 Layer-1 gate: the matrix must stay complete (typed) AND honest
// (referenced implementations exist, waivers carry reasons). A cell that
// points at a deleted symbol or an empty excuse fails here, not on-device.

test('every dispatch path classifies every guarantee', () => {
  for (const pathId of INTERACTION_PATH_IDS) {
    const contract = INTERACTION_DISPATCH_PATHS[pathId];
    assert.ok(contract, `missing contract for path ${pathId}`);
    for (const guarantee of INTERACTION_GUARANTEES) {
      assert.ok(
        contract.guarantees[guarantee],
        `path ${pathId} does not classify guarantee ${guarantee}`,
      );
    }
  }
});

test('runtime enforcement entries reference real exported symbols', async () => {
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const [guarantee, enforcement] of Object.entries(contract.guarantees)) {
      if (enforcement.kind !== 'runtime') continue;
      const [modulePath, symbol] = enforcement.via.split('#');
      assert.ok(
        modulePath && symbol,
        `${pathId}/${guarantee}: runtime via must be "<module>#<symbol>", got "${enforcement.via}"`,
      );
      const absolute = path.join(PROJECT_ROOT, modulePath);
      assert.ok(fs.existsSync(absolute), `${pathId}/${guarantee}: module not found: ${modulePath}`);
      const mod = (await import(absolute)) as Record<string, unknown>;
      assert.ok(
        symbol in mod,
        `${pathId}/${guarantee}: "${symbol}" is not exported from ${modulePath}`,
      );
    }
  }
});

test('runner enforcement entries reference symbols present in runner sources', () => {
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const [guarantee, enforcement] of Object.entries(contract.guarantees)) {
      if (enforcement.kind !== 'runner') continue;
      assertRunnerSourceIncludes(enforcement.via, `${pathId}/${guarantee}`);
      if (enforcement.parityTable !== undefined) {
        assert.ok(
          fs.existsSync(path.join(PROJECT_ROOT, enforcement.parityTable)),
          `${pathId}/${guarantee}: parity table not found: ${enforcement.parityTable}`,
        );
      }
    }
  }
});

function eachEnforcement(
  visit: (
    pathId: string,
    guarantee: (typeof INTERACTION_GUARANTEES)[number],
    enforcement: (typeof INTERACTION_DISPATCH_PATHS)[keyof typeof INTERACTION_DISPATCH_PATHS]['guarantees'][(typeof INTERACTION_GUARANTEES)[number]],
  ) => void,
): void {
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const guarantee of INTERACTION_GUARANTEES) {
      visit(pathId, guarantee, contract.guarantees[guarantee]);
    }
  }
}

test('delegations point at real paths that enforce the guarantee', () => {
  eachEnforcement((pathId, guarantee, enforcement) => {
    if (enforcement.kind !== 'delegated') return;
    assert.ok(
      (INTERACTION_PATH_IDS as readonly string[]).includes(enforcement.to),
      `${pathId}/${guarantee}: delegated to unknown path ${enforcement.to}`,
    );
    assert.notEqual(
      enforcement.to,
      pathId,
      `${pathId}/${guarantee}: a path cannot delegate to itself`,
    );
    assert.ok(
      enforcement.via.trim().length > 0,
      `${pathId}/${guarantee}: delegation must say how it triggers`,
    );
    const target = INTERACTION_DISPATCH_PATHS[enforcement.to].guarantees[guarantee];
    assert.ok(
      target.kind === 'runtime' || target.kind === 'runner',
      `${pathId}/${guarantee}: delegates to ${enforcement.to}, which does not enforce it (${target.kind})`,
    );
  });
});

test('waivers and inapplicable entries carry substantive reasons', () => {
  eachEnforcement((pathId, guarantee, enforcement) => {
    if (enforcement.kind !== 'waived' && enforcement.kind !== 'inapplicable') return;
    assert.ok(
      enforcement.reason.trim().length > 10,
      `${pathId}/${guarantee}: ${enforcement.kind} requires a substantive reason`,
    );
  });
});

test('command-scoped guarantees only name commands the path actually dispatches', () => {
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const guarantee of INTERACTION_GUARANTEES) {
      const enforcement = contract.guarantees[guarantee];
      if (enforcement.appliesTo === undefined) continue;
      assert.ok(
        enforcement.appliesTo.length > 0,
        `${pathId}/${guarantee}: appliesTo must be non-empty when present`,
      );
      for (const command of enforcement.appliesTo) {
        assert.ok(
          contract.commands.includes(command),
          `${pathId}/${guarantee}: appliesTo names "${command}", which the path does not dispatch`,
        );
      }
      assert.ok(
        enforcement.appliesTo.length < contract.commands.length,
        `${pathId}/${guarantee}: appliesTo covers every path command — drop it, omission means all`,
      );
    }
  }
});

test('gap waivers are owned by tracking issues', () => {
  eachEnforcement((pathId, guarantee, enforcement) => {
    if (enforcement.kind !== 'waived' || !enforcement.reason.startsWith('gap:')) return;
    // Waivers must be owned, not just visible: every acknowledged gap links
    // the umbrella tracking issue or a sub-issue split from it.
    assert.match(
      enforcement.trackingIssue ?? '',
      /^https:\/\/github\.com\/callstack\/agent-device\/issues\/\d+$/,
      `${pathId}/${guarantee}: gap waiver requires a trackingIssue URL`,
    );
  });
});

test('acknowledged gaps are visible and bounded', () => {
  const gaps: string[] = [];
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const [guarantee, enforcement] of Object.entries(contract.guarantees)) {
      if (enforcement.kind === 'waived' && enforcement.reason.startsWith('gap:')) {
        gaps.push(`${pathId}/${guarantee}`);
      }
    }
  }
  // CONSERVATIVE: this list may only shrink, or grow in the same PR that
  // updates it here with a linked issue. It is the diffable debt list
  // (umbrella: https://github.com/callstack/agent-device/issues/1081).
  assert.deepEqual(gaps.sort(), [
    'direct-ios-selector/disambiguation',
    'direct-ios-selector/responseIdentity',
    'maestro-non-hittable-fallback/errorTaxonomy',
  ]);
});
