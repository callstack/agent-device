import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { RECORDING_FRAMES_SOURCES, RECORDING_OVERLAY_SOURCES } from './recording-swift-sources.ts';

const RECORDING_SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../apple/runner/AgentDeviceRunner/RecordingScripts',
);
const EMBEDDED = [...RECORDING_OVERLAY_SOURCES, ...RECORDING_FRAMES_SOURCES];
const REGENERATE =
  'Run `pnpm generate:recording-swift-sources` after changing a recording helper source.';

test.each(EMBEDDED.map((source) => [source.fileName, source.text]))(
  'the embedded %s is byte-for-byte the shipped .swift source',
  (fileName, text) => {
    expect(text, REGENERATE).toBe(fs.readFileSync(path.join(RECORDING_SCRIPTS, fileName), 'utf8'));
  },
);

test('every recording helper source is embedded', () => {
  const embedded = new Set(EMBEDDED.map((source) => source.fileName));
  const onDisk = fs.readdirSync(RECORDING_SCRIPTS).filter((name) => name.endsWith('.swift'));

  expect(
    onDisk.filter((name) => !embedded.has(name)),
    REGENERATE,
  ).toEqual([]);
});
