import assert from 'node:assert/strict';
import { test } from 'vitest';
import { usage, usageForCommand } from '../../cli/parser/args.ts';
import { helpTopicIds } from './cli-help.ts';

// Agents often read only the first screen of a help text, and the help benchmark caps the root
// help at 30 lines (`--help:first30`). Each entry pins the rules that keep an agent safe on that
// screen: prerequisites, refusals, verification steps, and recovery. A new topic must declare its
// own entry.
const FIRST_SCREEN_LINES = 30;
const ROOT_HELP = '--help';

const FIRST_SCREEN_RULES: Record<string, readonly string[]> = {
  [ROOT_HELP]: [
    'agent-device open <app> --foreground',
    'Do not probe first with devices, apps, appstate, snapshot, or screenshot',
    'Never invent ids',
    'A bare screenshot is not verification',
    'End with: agent-device close',
  ],
  commands: ['Use agent-device help <command> for exact flags and behavior', 'Commands:'],
  'manual-qa': [
    'Do not explore unrelated screens',
    'Stop and report ambiguity',
    'use --relaunch only when the script needs fresh state',
    'If --settle prints not settled, follow its hint',
    'A bare screenshot/snapshot is not verification',
  ],
  maestro: [
    'replay <flow.yaml> --maestro',
    'there is no silent all: allow default',
    'do not place secrets in diagnostic identifiers',
    'not a security sandbox',
    'Unsupported syntax fails loudly',
  ],
  workflow: [
    'never a placeholder (@ref, @eN, @Label_Name)',
    'every platform rejects a stale pinned ref',
    'Never open artifact paths or invent package ids',
    'TV/D-pad focus: help tv',
    'Matches in distinct subtrees fail with AMBIGUOUS_MATCH',
  ],
  scripting: [
    'scroll down --until <selector>',
    'add an explicit landmark wait',
    '--record-as PASSWORD',
    'contain only ${PASSWORD}',
    'refuses a terminal, empty input, invalid UTF-8',
  ],
  gestures: [
    'coordinates only as a fallback',
    'instead of assuming requested values map exactly to recognizer output',
    'then diff snapshot -i',
    'Coordinates are fallback-only; document why you used them.',
  ],
  tv: [
    'move focus with remote/D-pad buttons, then activate the focused control',
    'not ADB',
    'Physical Fire TV devices remain unsupported',
    'The VVD is never booted implicitly',
    'remain unsupported until their Vega backends are implemented',
  ],
  debugging: [
    'Do not cat a full stale log into agent context',
    'do not split it into logs stop, logs clear, logs start',
    '--launch-console is only for direct iOS simulator app launches, not URL opens',
    'Do not write network log headers',
  ],
  'react-devtools': [
    'React Native 0.74 or newer',
    'find again after either',
    'fail with tree-unavailable',
    'Run profile start immediately before the interaction',
  ],
  cdp: [
    'Do not use this as the default React Native profiler',
    'adb reverse tcp:8081 tcp:8081',
    'agent-device cdp target select <target-id>',
    'cdp memory snapshot leak-triplet',
  ],
  'react-native': [
    'Do not run doctor as routine QA/dogfood prep',
    'prefer open --relaunch before the first snapshot',
    'Do not use agent-device reload',
    'the sandbox probe is not authoritative',
    'ask instead of inventing app ids or URLs',
  ],
  'physical-device': [
    'have Developer Mode enabled',
    'must be signed before commands can run on a physical device',
    "the Mac's DevToolsSecurity setting",
    "read from an iPhone's own report before the runner builds",
    'The two device reasons are never inferred from tool output or from each other',
    'Enable USB debugging',
  ],
  'ios-system-ui': [
    'agent-device open com.apple.springboard --platform ios',
    'instead of relying on the literal strings',
    'This is the one deliberate coordinate step',
    'Do not hard-code Edit/Done/Add Widget',
    'Reopen the app bundle under test',
  ],
  foldable: [
    'Do not add a screen flag to the normal loop',
    'never carry coordinates or refs across',
    'Re-snapshot after every fold',
    'fold-pose-unverified',
    'report which poses the run covered',
  ],
  remote: [
    'connect -> install/open -> commands -> close -> disconnect',
    'not the app artifact name, ARN, or lt:// id',
    'run its printed reconnect command',
    'Do not run devices as a pre-open catalog probe for direct providers',
    'It does not expose connect/disconnect',
  ],
  macos: [
    'Do not output inspect as a command',
    '--button secondary',
    'Do not let iOS simulator-set scoping hide macOS desktop targets',
    'instead of guessing coordinates',
    'without raising the app',
  ],
  web: [
    'Use --platform web only for the minimal browser command loop',
    'agent-device web doctor',
    'Web automation requires Node 24+',
    'output only agent-device command lines',
  ],
  dogfood: [
    'Do not read app source or invent findings from code',
    'ask only if missing',
    'Keep stateful commands serial within the same session',
    'use react-native dismiss-overlay',
  ],
  validate: [
    'Do not validate against stale dist output',
    'start with pnpm build',
    'run pnpm build:android before pnpm clean:daemon',
    'Do not build the Apple runner for TypeScript-only changes',
    'Close sessions and release leases before finishing',
  ],
};

async function renderHelp(id: string): Promise<string> {
  if (id === ROOT_HELP) return await usage();
  const text = await usageForCommand(id);
  if (text === null) throw new Error(`Expected help text for topic ${id}`);
  return text;
}

test('every help topic and the root help declare first-screen rules', () => {
  assert.deepEqual(Object.keys(FIRST_SCREEN_RULES).sort(), [ROOT_HELP, ...helpTopicIds()].sort());
});

test.each(Object.entries(FIRST_SCREEN_RULES))(
  'help %s keeps its key rules in the first 30 lines',
  async (id, rules) => {
    const lines = (await renderHelp(id)).split('\n');
    const firstScreen = lines.slice(0, FIRST_SCREEN_LINES).join('\n');
    for (const rule of rules) {
      const line = lines.findIndex((text) => text.includes(rule)) + 1;
      assert.ok(
        firstScreen.includes(rule),
        line > 0
          ? `"${rule}" is on line ${line}, below the first ${FIRST_SCREEN_LINES} lines of help ${id}`
          : `"${rule}" is missing from help ${id}`,
      );
    }
  },
);
