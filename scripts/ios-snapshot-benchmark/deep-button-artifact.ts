import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACT_FILENAME = 'deep-button-fixture.v1.json' as const;
const ARTIFACT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), ARTIFACT_FILENAME);

export type FixtureNode = {
  id: string;
  parentId: string | null;
  depth: number;
  role: string;
  label: string;
  value?: string;
  state?: 'off' | 'on';
};

export type ArtifactObservation = {
  state: 'off' | 'on';
  shallowNodeIds: string[];
  fullNodeIds: string[];
  changedNode: FixtureNode;
  shallowDigest: string;
  fullDigest: string;
};

export type DeepButtonArtifact = {
  version: 1;
  fixture: 'deep-button-v1';
  depth: 72;
  changedDescendant: 'deep-button-state';
  nodes: FixtureNode[];
  before: ArtifactObservation;
  after: ArtifactObservation;
};

export function readDeepButtonFixtureArtifact(): DeepButtonArtifact {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read ${ARTIFACT_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new Error(`${ARTIFACT_FILENAME} must contain an object.`);
  if (value.version !== 1 || value.fixture !== 'deep-button-v1') {
    throw new Error(`${ARTIFACT_FILENAME} has an unsupported fixture identity.`);
  }
  if (value.depth !== 72 || value.changedDescendant !== 'deep-button-state') {
    throw new Error(`${ARTIFACT_FILENAME} has an unsupported depth or changed descendant.`);
  }
  const artifact: DeepButtonArtifact = {
    version: 1,
    fixture: 'deep-button-v1',
    depth: 72,
    changedDescendant: 'deep-button-state',
    nodes: readNodes(value.nodes),
    before: readObservation(value.before),
    after: readObservation(value.after),
  };
  validateArtifact(artifact);
  return artifact;
}

export function materializeNodes(
  nodes: FixtureNode[],
  ids: string[],
  changedNode: FixtureNode,
): FixtureNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return ids.map((id) => (id === changedNode.id ? changedNode : nodeById.get(id)!));
}

function validateArtifact(artifact: DeepButtonArtifact): void {
  if (artifact.nodes.length !== artifact.depth + 1) {
    throw new Error(`${ARTIFACT_FILENAME} must contain one root-to-leaf node per depth.`);
  }
  const nodeIds = artifact.nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error(`${ARTIFACT_FILENAME} contains duplicate node ids.`);
  }
  const nodeById = new Map(artifact.nodes.map((node) => [node.id, node]));
  for (const [index, node] of artifact.nodes.entries()) {
    const expectedParent = index === 0 ? null : artifact.nodes[index - 1]!.id;
    if (node.depth !== index || node.parentId !== expectedParent) {
      throw new Error(`${ARTIFACT_FILENAME} contains a broken ancestor chain at depth ${index}.`);
    }
  }
  validateObservation(artifact.before, nodeIds, nodeById, artifact);
  validateObservation(artifact.after, nodeIds, nodeById, artifact);
  if (artifact.before.shallowDigest !== artifact.after.shallowDigest) {
    throw new Error(`${ARTIFACT_FILENAME} changed its shallow output between states.`);
  }
  if (JSON.stringify(artifact.before.changedNode) === JSON.stringify(artifact.after.changedNode)) {
    throw new Error(`${ARTIFACT_FILENAME} did not change the deep button state.`);
  }
}

function validateObservation(
  source: ArtifactObservation,
  nodeIds: string[],
  nodeById: ReadonlyMap<string, FixtureNode>,
  artifact: DeepButtonArtifact,
): void {
  validateFullOutput(source, nodeIds);
  validateShallowOutput(source, nodeIds, nodeById);
  validateChangedNodeIdentity(source, artifact);
  validateChangedNodeDepth(source, artifact);
  validateChangedNodeParent(source, artifact);
  validateChangedNodeRole(source);
  validateChangedNodeState(source);
  validateChangedNodePresence(source, artifact);
  validateOutputDigests(source, artifact);
}

function validateFullOutput(source: ArtifactObservation, nodeIds: string[]): void {
  if (source.fullNodeIds.length !== nodeIds.length || !sameItems(source.fullNodeIds, nodeIds)) {
    throw new Error(`${ARTIFACT_FILENAME} full output does not contain the complete fixture.`);
  }
}

function validateShallowOutput(
  source: ArtifactObservation,
  nodeIds: string[],
  nodeById: ReadonlyMap<string, FixtureNode>,
): void {
  if (source.shallowNodeIds.length === 0) {
    throw new Error(`${ARTIFACT_FILENAME} shallow output is not a root prefix.`);
  }
  if (source.shallowNodeIds.some((id) => !nodeById.has(id))) {
    throw new Error(`${ARTIFACT_FILENAME} shallow output contains an unknown node.`);
  }
  if (source.shallowNodeIds.some((id, index) => id !== nodeIds[index])) {
    throw new Error(`${ARTIFACT_FILENAME} shallow output is not a root prefix.`);
  }
}

function validateChangedNodeIdentity(
  source: ArtifactObservation,
  artifact: DeepButtonArtifact,
): void {
  if (source.changedNode.id !== artifact.changedDescendant) {
    throw new Error(`${ARTIFACT_FILENAME} changed node has the wrong identity.`);
  }
}

function validateChangedNodeDepth(source: ArtifactObservation, artifact: DeepButtonArtifact): void {
  if (source.changedNode.depth !== artifact.depth) {
    throw new Error(`${ARTIFACT_FILENAME} changed node does not reach the declared depth.`);
  }
}

function validateChangedNodeParent(
  source: ArtifactObservation,
  artifact: DeepButtonArtifact,
): void {
  if (source.changedNode.parentId !== artifact.nodes.at(-2)?.id) {
    throw new Error(`${ARTIFACT_FILENAME} changed node has the wrong parent.`);
  }
}

function validateChangedNodeRole(source: ArtifactObservation): void {
  if (source.changedNode.role !== 'button') {
    throw new Error(`${ARTIFACT_FILENAME} changed node is not a button.`);
  }
}

function validateChangedNodeState(source: ArtifactObservation): void {
  if (source.changedNode.state !== source.state || source.changedNode.value !== source.state) {
    throw new Error(`${ARTIFACT_FILENAME} changed node state does not match its observation.`);
  }
}

function validateChangedNodePresence(
  source: ArtifactObservation,
  artifact: DeepButtonArtifact,
): void {
  if (!source.fullNodeIds.includes(artifact.changedDescendant)) {
    throw new Error(`${ARTIFACT_FILENAME} full output omitted the changed node.`);
  }
  if (source.shallowNodeIds.includes(artifact.changedDescendant)) {
    throw new Error(`${ARTIFACT_FILENAME} shallow output included the changed node.`);
  }
}

function validateOutputDigests(source: ArtifactObservation, artifact: DeepButtonArtifact): void {
  const surfaceNodes = materializeNodes(artifact.nodes, source.shallowNodeIds, source.changedNode);
  const fullNodes = materializeNodes(artifact.nodes, source.fullNodeIds, source.changedNode);
  if (digest(surfaceNodes) !== source.shallowDigest || digest(fullNodes) !== source.fullDigest) {
    throw new Error(`${ARTIFACT_FILENAME} contains a stale output digest.`);
  }
}

function readNodes(value: unknown): FixtureNode[] {
  if (!Array.isArray(value)) throw new Error(`${ARTIFACT_FILENAME} nodes must be an array.`);
  return value.map(readNode);
}

function readObservation(value: unknown): ArtifactObservation {
  if (!isRecord(value)) throw new Error(`${ARTIFACT_FILENAME} observation must be an object.`);
  if (value.state !== 'off' && value.state !== 'on') {
    throw new Error(`${ARTIFACT_FILENAME} observation has an invalid state.`);
  }
  return {
    state: value.state,
    shallowNodeIds: readStringArray(value.shallowNodeIds),
    fullNodeIds: readStringArray(value.fullNodeIds),
    changedNode: readNode(value.changedNode),
    shallowDigest: readString(value.shallowDigest),
    fullDigest: readString(value.fullDigest),
  };
}

function readNode(value: unknown): FixtureNode {
  if (!isRecord(value)) throw new Error(`${ARTIFACT_FILENAME} node must be an object.`);
  const id = readRequiredString(value.id, 'node id');
  const parentId = readParentId(value.parentId);
  const depth = readInteger(value.depth, 'node depth');
  const role = readRequiredString(value.role, 'node role');
  const label = readRequiredString(value.label, 'node label');
  const nodeValue = readOptionalString(value.value, 'node value');
  const state = readOptionalState(value.state);
  return {
    id,
    parentId,
    depth,
    role,
    label,
    ...(nodeValue === undefined ? {} : { value: nodeValue }),
    ...(state === undefined ? {} : { state }),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${ARTIFACT_FILENAME} node ids must be strings.`);
  }
  return value.map((item) => item as string);
}

function readString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${ARTIFACT_FILENAME} digest must be a non-empty string.`);
  }
  return value;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new Error(`${ARTIFACT_FILENAME} contains an invalid ${label}.`);
  return value;
}

function readParentId(value: unknown): string | null {
  return value === null ? null : readRequiredString(value, 'node parent');
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${ARTIFACT_FILENAME} contains an invalid ${label}.`);
  }
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, label);
}

function readOptionalState(value: unknown): 'off' | 'on' | undefined {
  if (value === undefined) return undefined;
  if (value === 'off' || value === 'on') return value;
  throw new Error(`${ARTIFACT_FILENAME} contains an invalid node state.`);
}

function sameItems(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function digest(nodes: FixtureNode[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(nodes)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
