import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  IosHittabilityEvidence,
  IosRunnerQualityPayloadFacts,
  IosSnapshotEngine,
  IosSnapshotInput,
  IosSnapshotPublication,
  IosSnapshotValidationFacts,
} from './ios-snapshot.ts';

const validation: IosSnapshotValidationFacts = {
  presentationKey: {
    projection: 'regular',
    interactiveOnly: false,
    depth: null,
    scope: null,
    customActions: false,
  },
  viewport: { kind: 'missing', reason: 'not-provided' },
  hittability: { kind: 'unavailable', reason: 'not-provided' },
  lineage: { targetId: 'simulator-1', generation: 'generation-1' },
  residue: [],
};

const acquired: IosSnapshotInput = {
  stage: 'acquired',
  acquisition: {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    hint: {
      projection: 'raw',
      rawTraversalDepth: null,
      regularPresentedDepth: null,
      interactiveOnly: false,
      customActions: false,
      acquisitionIntent: 'full',
    },
    nodes: [],
    truncated: false,
    viewport: { kind: 'missing', reason: 'not-supported' },
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    residue: [],
  },
};

const presented: IosSnapshotInput = {
  stage: 'presented',
  presentation: {
    producer: 'apple-runner',
    intent: 'full',
    payload: { nodes: [], truncated: false },
    qualityPayload: { nodes: [], truncated: false, scope: null },
  },
  validation,
};

const publication: IosSnapshotPublication = {
  payload: { nodes: [], truncated: false },
  presentationKey: validation.presentationKey,
  comparisonIdentity: {
    producer: 'apple-runner',
    intent: 'full',
    lineage: validation.lineage,
    presentationKey: validation.presentationKey,
    residue: [],
  },
  residue: [],
};

const nonRunnerPresentation: IosSnapshotInput = {
  stage: 'presented',
  presentation: {
    // @ts-expect-error a presented input cannot use a non-runner producer
    producer: 'appium-source',
    intent: 'full',
    payload: { nodes: [], truncated: false },
  },
  validation,
};

const doubleStage: IosSnapshotInput = {
  stage: 'acquired',
  acquisition: acquired.acquisition,
  // @ts-expect-error a stage carries exactly one acquisition or presentation payload
  presentation: presented.presentation,
};

// @ts-expect-error a presented stage cannot skip its runner presentation payload
const skippedPresentation: IosSnapshotInput = { stage: 'presented', validation };

const qualityPayloadWithScope: IosRunnerQualityPayloadFacts = {
  nodes: [],
  truncated: false,
  // @ts-expect-error quality validation payloads are explicitly unscoped
  scope: 'Card',
};

const manufacturedHittability = {
  // @ts-expect-error geometry and enabled state do not manufacture hittability evidence
  rect: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
} satisfies IosHittabilityEvidence;

const publicationWithQualityPayload: IosSnapshotPublication = {
  ...publication,
  // @ts-expect-error publication deliberately has no quality-payload field
  qualityPayload: { nodes: [], truncated: false, scope: null },
};

const engineWithSecondPresentation: IosSnapshotEngine = {
  plan: null as unknown as IosSnapshotEngine['plan'],
  publish: null as unknown as IosSnapshotEngine['publish'],
  // @ts-expect-error the engine surface has no second presentation operation
  present: null as never,
};

test('iOS snapshot stage and engine surfaces stay closed', () => {
  assert.equal(acquired.stage, 'acquired');
  assert.equal(presented.stage, 'presented');
  assert.deepEqual(['plan', 'publish'] satisfies (keyof IosSnapshotEngine)[], ['plan', 'publish']);
  void doubleStage;
  void skippedPresentation;
  void nonRunnerPresentation;
  void qualityPayloadWithScope;
  void manufacturedHittability;
  void publicationWithQualityPayload;
  void engineWithSecondPresentation;
});
