import { describe, expect, test } from 'vitest';
import { SCRIPT_FLAG_COMMANDS, scriptFlagEntries } from '@agent-device/ad-script';
import {
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  DEVICE_SELECTION_FLAG_KEYS,
} from '@agent-device/command-registry/flag-groups';
import { getCliCommandSchema } from '../schema/command-schema.ts';
import {
  getFlagDefinitionsForKey,
  recordedFlagKeys,
} from '@agent-device/command-registry/flag-registry';

/**
 * #3197 was a divergence, not a bug: `--until` existed as a CLI flag with
 * `recorded: false`, and `wait --raw` was declared on the command and recorded, but
 * neither was admitted to the `.ad` script grammar — so the CLI form and the script
 * line disagreed and the script's own flag became a positional. The commands that
 * carry flags in their script line are declared in
 * `packages/ad-script/src/internal/script-utils.ts`; this pins admission in BOTH
 * directions so neither half can drift again:
 *
 * - a script token the grammar reads must be a long-spelled flag the command accepts,
 *   with the same spelling and value kind the declaration gives it, and one the
 *   recorder may carry (a grammar that accepted a `recorded: false` flag would parse
 *   a line the recording path can never write);
 * - the reverse: a flag the command accepts AND the recorder carries must be in the
 *   grammar, because that flag is exactly what a recording will one day write, and
 *   a script line carrying it must parse (the failure `--until` and `wait --raw` hit).
 */
describe.each(SCRIPT_FLAG_COMMANDS)('%s script flags', (command) => {
  const entries = scriptFlagEntries(command);
  const keys: string[] = [...new Set(entries.map((entry) => entry.key))];
  const acceptedFlagKeys = new Set<string>([
    ...(getCliCommandSchema(command).allowedFlags ?? []),
    ...(getCliCommandSchema(command).supportedFlags ?? []),
  ]);

  test('the command declares at least one script flag', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test('every flag the script line carries is one the command itself accepts', () => {
    expect(keys.filter((key) => !acceptedFlagKeys.has(key))).toEqual([]);
  });

  test('every flag the script line carries is one the recorder may carry', () => {
    expect(keys.filter((key) => !recordedFlagKeys().has(key as never))).toEqual([]);
  });

  test('every script token matches the declaration spelling and kind exactly', () => {
    // Long spelling only, and only a spelling the CLI itself declares: a short
    // alias invented here would parse a line the recording never writes, and a
    // single-letter token would reclassify positional data the grammar used to
    // leave alone.
    for (const entry of entries) {
      expect(entry.token.startsWith('--')).toBe(true);
      const definitions = getFlagDefinitionsForKey(entry.key as never);
      const definition = definitions.find((candidate) => candidate.names.includes(entry.token));
      expect(definition?.type).toBe(entry.kind);
    }
  });

  test('every recorded flag the command owns is in the script grammar', () => {
    // The direction #3197 actually broke: a flag a recording can write must be a
    // token the parser can read back, or the writer's own line would not replay.
    // Scoped to the flags the command owns — the common parser flags (device
    // selection, daemon wiring, `--no-record`) are recorded but deliberately not
    // part of a step, so they stay out of the grammar by declaration.
    const recorded = recordedFlagKeys();
    const missing = [...acceptedFlagKeys].filter(
      (key) =>
        recorded.has(key as never) && !isCommonOrDeviceSelectionFlagKey(key) && !keys.includes(key),
    );
    expect(missing).toEqual([]);
  });
});

function isCommonOrDeviceSelectionFlagKey(key: string): boolean {
  return (
    (COMMON_COMMAND_SUPPORTED_FLAG_KEYS as readonly string[]).includes(key) ||
    DEVICE_SELECTION_FLAG_KEYS.has(key as never)
  );
}

test('a command outside the declared set carries no script flags, so its line stays all-positional', () => {
  // The generic script branch treats every token as a positional, so a command
  // cannot gain a script flag without its own parse branch. `press` is the proof:
  // its `--button` handling lives in the click-like branch, not in this grammar.
  expect(scriptFlagEntries('press')).toEqual([]);
  expect(scriptFlagEntries('snapshot')).toEqual([]);
});
