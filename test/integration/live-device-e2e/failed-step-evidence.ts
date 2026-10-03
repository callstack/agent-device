import fs from 'node:fs';

import type { CliJsonResult } from '../cli-json.ts';

export type FailedStepEvidence = {
  screenshotPath?: string;
  snapshotPath?: string;
  devicePath?: string;
};

export type FailedStepEvidenceInput = {
  /** Artifact path prefix, e.g. `<artifactDir>/failed-step-7`. */
  stem: string;
  /** The CLI bound to the failed step's device and session. */
  runCli: (args: string[]) => Promise<CliJsonResult>;
  /** Platform-owned device facts, read outside the CLI. */
  deviceEvidence?: () => Promise<string | undefined>;
  /** Upper bound for the device facts as a group; the CLI evidence never waits on them. */
  deviceEvidenceTimeoutMs?: number;
};

const DEVICE_EVIDENCE_TIMEOUT_MS = 15_000;

/**
 * What the device showed when a step failed: the pixels and the accessibility tree the next
 * capture would have read, plus whatever the platform can say about the device outside
 * agent-device. Every collector is best-effort and independent: a throw, a non-zero exit, or a
 * timed-out hook records nothing for that item and nothing else.
 */
export async function collectFailedStepEvidence(
  input: FailedStepEvidenceInput,
): Promise<FailedStepEvidence> {
  const [cli, devicePath] = await Promise.all([
    collectCliEvidence(input),
    collectDeviceEvidence(input),
  ]);
  return { ...cli, ...(devicePath ? { devicePath } : {}) };
}

async function collectCliEvidence(
  input: FailedStepEvidenceInput,
): Promise<Pick<FailedStepEvidence, 'screenshotPath' | 'snapshotPath'>> {
  const screenshotPath = await captureScreenshot(input);
  const snapshotPath = await captureSnapshot(input);
  return {
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(snapshotPath ? { snapshotPath } : {}),
  };
}

async function captureScreenshot(input: FailedStepEvidenceInput): Promise<string | undefined> {
  const screenshotPath = `${input.stem}.png`;
  try {
    const result = await input.runCli(['screenshot', screenshotPath]);
    return result.status === 0 ? screenshotPath : undefined;
  } catch {
    return undefined;
  }
}

async function captureSnapshot(input: FailedStepEvidenceInput): Promise<string | undefined> {
  const snapshotPath = `${input.stem}-snapshot.json`;
  try {
    const result = await input.runCli(['snapshot']);
    if (result.status !== 0 || result.json === undefined) return undefined;
    fs.writeFileSync(snapshotPath, JSON.stringify(result.json, null, 2));
    return snapshotPath;
  } catch {
    return undefined;
  }
}

async function collectDeviceEvidence(input: FailedStepEvidenceInput): Promise<string | undefined> {
  if (!input.deviceEvidence) return undefined;
  const devicePath = `${input.stem}-device.txt`;
  try {
    const facts = await withinTimeout(
      input.deviceEvidence(),
      input.deviceEvidenceTimeoutMs ?? DEVICE_EVIDENCE_TIMEOUT_MS,
    );
    if (facts === undefined) return undefined;
    fs.writeFileSync(devicePath, facts);
    return devicePath;
  } catch {
    return undefined;
  }
}

async function withinTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`device evidence exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}
