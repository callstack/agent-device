import { describe, expect, test } from 'vitest';
import type { MaestroDaemonOperationRequest } from '../daemon-runtime-public-operation.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeRuntimeEnvelope, makeDependencies } from './daemon-runtime-port-fixtures.ts';

type TextCommand =
  | { kind: 'inputText'; source: { line: number }; text: string }
  | { kind: 'eraseText'; source: { line: number }; charactersToErase?: number };

async function typeRequestFor(
  platform: 'android' | 'ios',
  command: TextCommand,
): Promise<MaestroDaemonOperationRequest> {
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform, replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return request.command === 'snapshot'
        ? {
            ok: true,
            data: {
              createdAt: requests.length,
              nodes: [
                { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
              ],
            },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform,
  });
  await port.execute({
    command,
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  const request = requests.find((candidate) => candidate.command === 'type');
  if (!request) throw new Error(`${command.kind} did not reach the type command`);
  return request;
}

const MAESTRO_2_5_1_ANDROID_INPUT_TEXT_DELAY_MS = 75;
const INPUT_TEXT: TextCommand = { kind: 'inputText', source: { line: 2 }, text: 'hello' };
const ERASE_TEXT: TextCommand = { kind: 'eraseText', source: { line: 2 }, charactersToErase: 3 };

describe('Maestro inputText pacing', () => {
  test('Android types with the pinned Maestro per-character delay', async () => {
    const request = await typeRequestFor('android', INPUT_TEXT);
    expect(request.positionals).toEqual(['hello']);
    expect(request.flags?.delayMs).toBe(MAESTRO_2_5_1_ANDROID_INPUT_TEXT_DELAY_MS);
  });

  test.each(['android', 'ios'] as const)(
    '%s eraseText sends backspaces without a delay',
    async (platform) => {
      const request = await typeRequestFor(platform, ERASE_TEXT);
      expect(request.positionals).toEqual(['\b\b\b']);
      expect(request.flags).not.toHaveProperty('delayMs');
    },
  );

  test('iOS types without a delay', async () => {
    const request = await typeRequestFor('ios', INPUT_TEXT);
    expect(request.flags).not.toHaveProperty('delayMs');
  });
});
