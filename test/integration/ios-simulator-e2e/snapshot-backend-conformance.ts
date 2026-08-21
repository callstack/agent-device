import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentDeviceDaemonTransport,
  CaptureSnapshotResult,
} from '@agent-device/contracts/client';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  type SnapshotCaptureBackend,
  type SnapshotPreferredBackend,
} from '@agent-device/kernel/snapshot';
import { SNAPSHOT_BACKEND_CAPABILITIES } from '../../../src/snapshot-quality/backend-capabilities.ts';
import { isSemanticTouchTarget } from '../../../src/core/interaction-targeting.ts';

export type SnapshotBackendConformanceFixture = {
  screen: string;
  minimumNodeCount: number;
  requiredControls: readonly SnapshotBackendControl[];
};

type SnapshotBackendControl = {
  identifier: string;
  label: string;
  role: string;
  value?: string;
  interactive: boolean;
};

export const SNAPSHOT_BACKEND_CONFORMANCE_TARGETS = Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
  .filter(([, capability]) => capability.forceable)
  .map(([backend]) => backend as SnapshotPreferredBackend);

/**
 * Test-owned transport seam for the backend conformance probe. The public SDK deliberately has
 * no backend-selection option; this wrapper adds the internal daemon flag after the public client
 * has projected its ordinary snapshot request. Keeping the force field here makes it impossible
 * for a published CaptureSnapshotOptions or generic CommandExecutionOptions value to leak this
 * evidence-only control.
 */
export function createSnapshotBackendConformanceTransport(
  backend: SnapshotPreferredBackend,
  transport: AgentDeviceDaemonTransport,
): AgentDeviceDaemonTransport {
  return async (request, context) =>
    await transport(
      {
        ...request,
        flags: {
          ...(request.flags ?? {}),
          snapshotPreferredBackend: backend,
        },
      },
      context,
    );
}

export function loadSnapshotBackendConformanceFixture(
  fixturePath = path.resolve('contracts/fixtures/ios-snapshot-backend-conformance.json'),
): SnapshotBackendConformanceFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SnapshotBackendConformanceFixture;
}

/**
 * Checks one backend against the fixture contract. It deliberately never accepts a second
 * snapshot as a comparison oracle: a backend passes only by satisfying the seeded controls,
 * semantic identity, interactivity, values, and its own quality verdict.
 */
export function assertSnapshotBackendConformance(
  snapshot: Pick<CaptureSnapshotResult, 'nodes' | 'snapshotQuality' | 'truncated'>,
  backend: SnapshotPreferredBackend,
  fixture: SnapshotBackendConformanceFixture,
): void {
  const quality = snapshot.snapshotQuality;
  assert.equal(
    quality?.backend,
    backend,
    `${backend} capture must prove its backend in snapshotQuality: ${JSON.stringify(quality)}`,
  );
  assert.ok(
    quality?.state === 'healthy' || quality?.state === 'recovered',
    `${backend} capture must have a non-sparse quality verdict: ${JSON.stringify(quality)}`,
  );
  // The existing wire contract marks any recovered capture as truncated, including a complete
  // private-AX payload selected after the XCTest channel was deferred. Assert that relationship
  // instead of conflating recovery provenance with missing fixture controls.
  assert.equal(
    snapshot.truncated,
    quality.state !== 'healthy',
    `${backend} quality/truncation flags disagree: ${JSON.stringify(quality)}`,
  );
  assert.ok(
    snapshot.nodes.length >= fixture.minimumNodeCount,
    `${backend} capture returned too few nodes (${snapshot.nodes.length} < ${fixture.minimumNodeCount})`,
  );

  for (const expected of fixture.requiredControls) {
    const node = snapshot.nodes.find((candidate) => candidate.identifier === expected.identifier);
    assert.ok(
      node,
      `${backend} capture is missing ${expected.identifier}: ${JSON.stringify(snapshot.nodes)}`,
    );
    assert.equal(node.label, expected.label, `${backend} label drift for ${expected.identifier}`);
    assert.equal(
      canonicalRole(node.role ?? node.type ?? ''),
      expected.role,
      `${backend} role drift for ${expected.identifier}`,
    );
    assert.equal(node.enabled, true, `${backend} did not mark ${expected.identifier} enabled`);
    if (expected.interactive) {
      // #1933 makes iOS snapshot hittable a backend-independent geometric-actionability
      // predicate: enabled, non-empty geometry whose center lies inside the viewport. It is not
      // native hit-testing or occlusion evidence, but it is still a promised control invariant.
      assert.equal(
        isSemanticTouchTarget(node),
        true,
        `${backend} did not expose ${expected.identifier} as a semantic control`,
      );
      assert.ok(
        node.rect && node.rect.width > 0 && node.rect.height > 0,
        `${backend} did not expose positive interaction geometry for ${expected.identifier}`,
      );
      assert.equal(
        typeof node.hittable,
        'boolean',
        `${backend} omitted its structured hittable result for ${expected.identifier}`,
      );
      assert.equal(
        node.hittable,
        true,
        `${backend} did not expose ${expected.identifier} as geometrically actionable`,
      );
    }
    if (expected.value !== undefined) {
      assert.equal(node.value, expected.value, `${backend} value drift for ${expected.identifier}`);
    }
  }
}

function canonicalRole(value: string): string {
  const normalized = normalizeType(value);
  return (
    (
      {
        edittext: 'text-field',
        textfield: 'text-field',
        textarea: 'text-view',
      } as Record<string, string>
    )[normalized] ?? normalized
  );
}

export function snapshotBackendEvidence(
  snapshot: Pick<CaptureSnapshotResult, 'nodes' | 'snapshotQuality' | 'truncated'>,
  backend: SnapshotCaptureBackend,
) {
  return {
    backend,
    quality: snapshot.snapshotQuality,
    nodeCount: snapshot.nodes.length,
    truncated: snapshot.truncated,
    controls: snapshot.nodes
      .filter((node) => typeof node.identifier === 'string')
      .map((node) => ({
        identifier: node.identifier,
        label: node.label,
        role: canonicalRole(node.role ?? node.type ?? ''),
        value: node.value,
        enabled: node.enabled,
        hittable: node.hittable,
      })),
  };
}
