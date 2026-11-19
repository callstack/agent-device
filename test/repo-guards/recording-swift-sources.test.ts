import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { stripSwiftComments } from '../../scripts/strip-swift-comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING_SCRIPTS = path.resolve(
  HERE,
  '../../apple/runner/AgentDeviceRunner/RecordingScripts',
);
type EmbeddedSources = Record<
  'RECORDING_OVERLAY_SOURCES' | 'RECORDING_FRAMES_SOURCES',
  readonly { fileName: string; text: string }[]
>;
// Read by file, as the generated artifact it is, the way the .swift files are read.
const { RECORDING_FRAMES_SOURCES, RECORDING_OVERLAY_SOURCES } = (await import(
  pathToFileURL(
    path.resolve(HERE, '../../packages/capture-kit/src/recording/recording-swift-sources.ts'),
  ).href
)) as EmbeddedSources;
const EMBEDDED = [...RECORDING_OVERLAY_SOURCES, ...RECORDING_FRAMES_SOURCES];
const REGENERATE =
  'Run `pnpm generate:recording-swift-sources` after changing a recording helper source.';

test.each(EMBEDDED.map((source) => [source.fileName, source.text]))(
  'the embedded %s is its .swift source with the comments stripped, line for line',
  (fileName, text) => {
    const canonical = fs.readFileSync(path.join(RECORDING_SCRIPTS, fileName), 'utf8');
    expect(text, REGENERATE).toBe(stripSwiftComments(canonical, fileName).contents);
    expect(text.split('\n').length).toBe(canonical.split('\n').length);
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

test('each helper compiles exactly its own sources, main file first', () => {
  expect(RECORDING_OVERLAY_SOURCES.map((source) => source.fileName)).toEqual([
    'recording-overlay.swift',
    'RecordingExportSupport.swift',
  ]);
  expect(RECORDING_FRAMES_SOURCES.map((source) => source.fileName)).toEqual([
    'recording-frames.swift',
    'RecordingExportSupport.swift',
  ]);
});
