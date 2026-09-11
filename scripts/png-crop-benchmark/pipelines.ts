import type { Rect } from '@agent-device/kernel/snapshot';
import { PNG } from '@agent-device/capture-kit/png';
import {
  cropPngBytesAsync,
  decodePngAsync,
  encodePngAsync,
} from '@agent-device/capture-kit/png-worker-client';
import type { Capture, CropScenario } from './corpus.ts';
import { cropBoxOf } from './corpus.ts';
import { measureAsync } from './statistics.ts';

/**
 * The two ways this repository can crop a capture, both run as PNG worker jobs over the same
 * bytes, so what differs between them is the algorithm rather than the thread it lands on:
 *
 * - `wholeImage`: the previous crop. One job decodes the whole capture to RGBA, the box rows are
 *   copied out of that bitmap, and a second job encodes the box.
 * - `region`: the shipped crop. One job reads the box's rows and encodes them.
 *
 * Neither writes a file. Publishing the artifact is the same work on both sides, so it would only
 * dilute the ratio; the byte length of the encoded answer is reported instead.
 */

export type PipelineSample = Readonly<{ medianMs: number; bestMs: number; outBytes: number }>;

export type ScenarioSample = Readonly<{
  capture: string;
  label: string;
  scenario: string;
  captureBytes: number;
  box: Rect;
  wholeImage: PipelineSample;
  region: PipelineSample;
}>;

export async function sampleScenario(
  capture: Capture,
  scenario: CropScenario,
  rounds: number,
): Promise<ScenarioSample> {
  const box = cropBoxOf(capture, scenario);
  const wholeImageBytes = await wholeImageCrop(capture.bytes, box);
  const regionBytes = await regionCrop(capture.bytes, box);
  const wholeImage = await measureAsync(rounds, async () => {
    await wholeImageCrop(capture.bytes, box);
  });
  const region = await measureAsync(rounds, async () => {
    await regionCrop(capture.bytes, box);
  });
  return {
    capture: capture.name,
    label: capture.label,
    scenario: scenario.name,
    captureBytes: capture.bytes.length,
    box,
    wholeImage: { ...wholeImage, outBytes: wholeImageBytes },
    region: { ...region, outBytes: regionBytes },
  };
}

async function wholeImageCrop(source: Buffer, box: Rect): Promise<number> {
  const decoded = await decodePngAsync(source, 'capture');
  const cropped = new PNG({ width: box.width, height: box.height });
  for (let row = 0; row < box.height; row += 1) {
    const from = ((row + box.y) * decoded.width + box.x) * 4;
    decoded.data.copy(cropped.data, row * cropped.width * 4, from, from + box.width * 4);
  }
  return (await encodePngAsync(cropped)).length;
}

async function regionCrop(source: Buffer, box: Rect): Promise<number> {
  const cropped = await cropPngBytesAsync(source, box, 'capture');
  return cropped === null ? source.length : cropped.length;
}
