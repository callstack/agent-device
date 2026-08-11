import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/index.ts';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { isPlayableVideo } from './video.ts';

const directory = mkdtempForTestSync('agent-device-video-webm-');
const playableWebm = likelyPlayableWebmContainer();

test('accepts a real WebM video track and complete media block without AVFoundation', async () => {
  await expect(isPlayableVideo(writeFixture('capture.webm', playableWebm))).resolves.toBe(true);
});

test('does not infer WebM from bytes when the requested container is different', async () => {
  await expect(isPlayableVideo(writeFixture('capture.bin', playableWebm))).resolves.toBe(false);
});

function writeFixture(name: string, bytes: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}
