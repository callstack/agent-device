import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  INTERACTION_DISPATCH_PATHS,
  INTERACTION_GUARANTEES,
  INTERACTION_PATH_IDS,
} from '../interaction-guarantees.ts';

// ADR 0011 Layer-1 gate: the matrix must stay complete (typed) AND honest
// (referenced implementations exist, waivers carry reasons). A cell that
// points at a deleted symbol or an empty excuse fails here, not on-device.

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RUNNER_SOURCES_DIR = path.join(
  PROJECT_ROOT,
  'apple-runner',
  'AgentDeviceRunner',
  'AgentDeviceRunnerUITests',
);

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
      const [fileName, symbol] = enforcement.via.split('#');
      assert.ok(
        fileName && symbol,
        `${pathId}/${guarantee}: runner via must be "<file>#<symbol>", got "${enforcement.via}"`,
      );
      const absolute = path.join(RUNNER_SOURCES_DIR, fileName);
      assert.ok(
        fs.existsSync(absolute),
        `${pathId}/${guarantee}: runner source not found: ${fileName}`,
      );
      const source = fs.readFileSync(absolute, 'utf8');
      assert.ok(
        source.includes(symbol),
        `${pathId}/${guarantee}: "${symbol}" not found in ${fileName}`,
      );
      if (enforcement.parityTable !== undefined) {
        assert.ok(
          fs.existsSync(path.join(PROJECT_ROOT, enforcement.parityTable)),
          `${pathId}/${guarantee}: parity table not found: ${enforcement.parityTable}`,
        );
      }
    }
  }
});

test('delegations point at real paths and waivers carry reasons', () => {
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS)) {
    for (const [guarantee, enforcement] of Object.entries(contract.guarantees)) {
      if (enforcement.kind === 'delegated') {
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
        const target =
          INTERACTION_DISPATCH_PATHS[enforcement.to].guarantees[
            guarantee as (typeof INTERACTION_GUARANTEES)[number]
          ];
        assert.ok(
          target.kind === 'runtime' || target.kind === 'runner',
          `${pathId}/${guarantee}: delegates to ${enforcement.to}, which does not enforce it (${target.kind})`,
        );
      }
      if (enforcement.kind === 'waived' || enforcement.kind === 'inapplicable') {
        assert.ok(
          enforcement.reason.trim().length > 10,
          `${pathId}/${guarantee}: ${enforcement.kind} requires a substantive reason`,
        );
      }
    }
  }
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
  // updates it here with a linked issue. It is the diffable debt list.
  assert.deepEqual(gaps.sort(), [
    'coordinate/offscreen',
    'direct-ios-selector/disambiguation',
    'direct-ios-selector/errorTaxonomy',
    'direct-ios-selector/nonHittable',
    'direct-ios-selector/occlusion',
    'direct-ios-selector/responseFields',
    'maestro-non-hittable-fallback/errorTaxonomy',
    'native-ref/nonHittable',
    'native-ref/occlusion',
    'native-ref/offscreen',
  ]);
});
