import {
  attachSnapshotClickabilityEvidence,
  attachSnapshotOcclusionContextEvidence,
  type AndroidSnapshotBackendMetadata,
  type SnapshotClickabilityEvidence,
  type SnapshotOcclusionContextEvidence,
} from '@agent-device/contracts/capture';
import type {
  RawSnapshotNode,
  SnapshotBackend,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotAnalysis } from './ui-hierarchy.ts';

const androidCaptureEvidence = Symbol('androidSnapshotCaptureEvidence');

type AndroidCaptureEvidence = Readonly<{
  clickability: Extract<SnapshotClickabilityEvidence, { provider: 'android-helper' }>;
  occlusionContext?: SnapshotOcclusionContextEvidence;
}>;

type AndroidSnapshotCaptureData = Readonly<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
  androidSnapshot: AndroidSnapshotBackendMetadata;
  quality?: SnapshotQualityVerdict;
}>;

/** Opaque acquisition envelope: exact Android facts cannot be detached from the captured nodes. */
export type AndroidSnapshotCapture = AndroidSnapshotCaptureData & {
  readonly [androidCaptureEvidence]: AndroidCaptureEvidence;
};

export type AndroidSnapshotPublicationInput = AndroidSnapshotCaptureData & {
  backend: Extract<SnapshotBackend, 'android'>;
  producer: 'android-uiautomator';
};

export function createAndroidSnapshotCapture(
  data: AndroidSnapshotCaptureData,
  evidence: AndroidCaptureEvidence,
): AndroidSnapshotCapture {
  Object.defineProperty(data, androidCaptureEvidence, { value: evidence });
  return data as AndroidSnapshotCapture;
}

/** The sole adapter from Android acquisition into daemon snapshot publication. */
export function androidSnapshotPublicationInput(
  capture: AndroidSnapshotCapture,
): AndroidSnapshotPublicationInput {
  const publication: AndroidSnapshotPublicationInput = {
    ...capture,
    backend: 'android',
    producer: 'android-uiautomator',
  };
  const evidence = capture[androidCaptureEvidence];
  attachSnapshotClickabilityEvidence(publication, evidence.clickability);
  if (evidence.occlusionContext) {
    attachSnapshotOcclusionContextEvidence(publication, evidence.occlusionContext);
  }
  return publication;
}
