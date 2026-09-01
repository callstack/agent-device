import { performance } from 'node:perf_hooks';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { PresentationMeasurement, RawAcquisition } from './types.ts';

export function presentAcquisitionForMeasurement(raw: RawAcquisition): {
  acquisition: IosSnapshotAcquisition;
  measurement: PresentationMeasurement;
} {
  const started = performance.now();
  const usage = process.resourceUsage();
  const acquisitionIntent = 'full' as const;
  const request = createIosSnapshotRequest({ raw: true, acquisitionIntent });
  const acquisition: IosSnapshotAcquisition = {
    producer: 'simulator-ax-bridge',
    intent: acquisitionIntent,
    hint: { ...deriveIosCaptureHint(request), acquisitionIntent },
    nodes: raw.nodes.map((node, index) => toRawSnapshotNode(node, index, nodeIndexes(raw.nodes))),
    truncated: raw.truncated,
    viewport: raw.viewport,
    lineage: {
      targetId: raw.targetId,
      ...(raw.targetGeneration === null ? {} : { generation: raw.targetGeneration }),
    },
    residue: raw.residue,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(acquisition));
  const nextUsage = process.resourceUsage();
  return {
    acquisition,
    measurement: {
      ok: true,
      payloadBytes,
      nodeCount: raw.nodes.length,
      durationMs: performance.now() - started,
      cpuMs: cpuMilliseconds(nextUsage) - cpuMilliseconds(usage),
      memoryBytes: process.memoryUsage().rss,
    },
  };
}

function toRawSnapshotNode(
  node: RawAcquisition['nodes'][number],
  index: number,
  nodeIndexes: ReadonlyMap<string, number>,
): RawSnapshotNode {
  return {
    index,
    ...optionalParent(node.parentId, nodeIndexes),
    ...optionalString(node, 'type'),
    ...optionalString(node, 'role'),
    ...optionalString(node, 'subrole'),
    ...optionalString(node, 'label'),
    ...optionalString(node, 'value'),
    ...optionalString(node, 'identifier'),
    ...optionalFrame(node.frame),
    ...optionalBoolean(node, 'enabled'),
    ...optionalBoolean(node, 'selected'),
    ...optionalBoolean(node, 'focused'),
  };
}

function nodeIndexes(nodes: RawAcquisition['nodes']): ReadonlyMap<string, number> {
  return new Map(nodes.map((node, index) => [node.id, index]));
}

function optionalParent(
  parentId: string | undefined,
  indexes: ReadonlyMap<string, number>,
): Partial<RawSnapshotNode> {
  if (parentId === undefined) return {};
  const parentIndex = indexes.get(parentId);
  return parentIndex === undefined ? {} : { parentIndex };
}

function optionalString(
  node: RawAcquisition['nodes'][number],
  key: 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier',
): Partial<RawSnapshotNode> {
  return node[key] === undefined ? {} : { [key]: node[key] };
}

function optionalBoolean(
  node: RawAcquisition['nodes'][number],
  key: 'enabled' | 'selected' | 'focused',
): Partial<RawSnapshotNode> {
  return node[key] === undefined ? {} : { [key]: node[key] };
}

function optionalFrame(frame: RawAcquisition['nodes'][number]['frame']): Partial<RawSnapshotNode> {
  return frame === undefined ? {} : { rect: frame };
}

function cpuMilliseconds(usage: NodeJS.ResourceUsage): number {
  return (usage.userCPUTime + usage.systemCPUTime) / 1_000;
}
