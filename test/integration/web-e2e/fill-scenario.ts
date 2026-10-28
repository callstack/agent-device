import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from '../cli-json.ts';
import {
  FILL_FIXTURE_POINTS,
  type FillFixtureState,
  startFillFixtureServer,
} from './fill-fixture.ts';

type Point = readonly [number, number];
type Field = {
  name: Exclude<keyof typeof FILL_FIXTURE_POINTS, 'blank' | 'button'>;
  stateKey: keyof FillFixtureState;
  /** What the replace step types; a number input accepts digits only. */
  text?: string;
};

const EDITABLE_FIELDS: readonly Field[] = [
  { name: 'plain', stateKey: 'plain' },
  { name: 'textarea', stateKey: 'textarea' },
  { name: 'contenteditable', stateKey: 'contenteditable' },
  { name: 'shadowInput', stateKey: 'shadowInput' },
  { name: 'shadowContenteditable', stateKey: 'shadowContenteditable' },
  { name: 'sameOriginFrame', stateKey: 'sameOriginFrame' },
  // A frame-local point is (click point - the frame's page origin) / its rendered scale.
  { name: 'scaledHalfFrame', stateKey: 'scaledHalfFrame' },
  { name: 'scaledDoubleFrame', stateKey: 'scaledDoubleFrame' },
  { name: 'emailInput', stateKey: 'emailInput', text: 'new@example.test' },
  { name: 'numberInput', stateKey: 'numberInput', text: '42' },
  // Several paragraphs and a hidden span: the selection must cover all of it, though the text the
  // browser renders for the selection differs from the text of the range.
  { name: 'multiParagraph', stateKey: 'multiParagraph' },
];

// A fill that cannot confirm an editable target must leave the page untouched, so each of these is
// refused and its field keeps the value it had before the fill.
const REFUSED_FIELDS: readonly Field[] = [
  { name: 'crossOriginFrame', stateKey: 'crossOriginFrame' },
  { name: 'closedShadowInput', stateKey: 'closedShadowInput' },
  { name: 'readonlyInput', stateKey: 'readonlyInput' },
  { name: 'dateInput', stateKey: 'dateInput' },
  { name: 'select', stateKey: 'select' },
];

/**
 * Live coordinate `fill` on the managed headless backend. It claims the one web device, so it runs
 * in the web smoke file's sequence, never beside another web scenario.
 */
export async function runLiveFillScenario(): Promise<void> {
  const live = await startLiveFill();
  try {
    await live.setup();
    await live.run(['open', live.url]);
    await live.run(['viewport', '900', '700']);
    assert.equal((await live.readState()).plain, 'old');

    for (const field of EDITABLE_FIELDS) {
      await assertFillReplacesAndClears(live, field);
    }
    for (const field of REFUSED_FIELDS) {
      await assertFillRefused(live, field.name, field.stateKey);
    }
    await assertCheckboxFillRefused(live);
    await assertMissKeepsPreviouslyFocusedField(live);
    await assertButtonFillSendsNoKeys(live);
  } finally {
    await live.close();
  }
}

async function assertFillReplacesAndClears(live: LiveFill, field: Field): Promise<void> {
  const text = field.text ?? 'new';
  const replaced = await live.fill(FILL_FIXTURE_POINTS[field.name], text);
  assert.equal(replaced.status, 0, debug(field.name, replaced));
  assert.equal((await live.readState())[field.stateKey], text, `${field.name} replace`);

  const cleared = await live.fill(FILL_FIXTURE_POINTS[field.name], '');
  assert.equal(cleared.status, 0, debug(field.name, cleared));
  assert.equal((await live.readState())[field.stateKey], '', `${field.name} clear`);
}

async function assertFillRefused(
  live: LiveFill,
  name: Field['name'],
  stateKey: keyof FillFixtureState,
): Promise<void> {
  const before = (await live.readState())[stateKey];
  const result = await live.fill(FILL_FIXTURE_POINTS[name], 'new');
  assertRefusal(name, result);
  assert.equal((await live.readState())[stateKey], before, `${name} stays unchanged`);
}

async function assertCheckboxFillRefused(live: LiveFill): Promise<void> {
  const result = await live.fill(FILL_FIXTURE_POINTS.checkbox, 'new');
  assertRefusal('checkbox', result);
}

// A click on non-focusable content leaves the previously focused field focused. The fill must not
// select and overwrite that old field.
async function assertMissKeepsPreviouslyFocusedField(live: LiveFill): Promise<void> {
  assert.equal((await live.fill(FILL_FIXTURE_POINTS.plain, 'kept')).status, 0);
  const result = await live.fill(FILL_FIXTURE_POINTS.blank, 'overwritten');
  assertRefusal('blank', result);
  assert.equal((await live.readState()).plain, 'kept');
}

// A newline in the text is an Enter key press. Refusing before any typing means the button is
// activated by the fill's own click only, never a second time by Enter.
async function assertButtonFillSendsNoKeys(live: LiveFill): Promise<void> {
  const before = await live.readState();
  const result = await live.fill(FILL_FIXTURE_POINTS.button, 'new\n');
  assertRefusal('button', result);
  const after = await live.readState();
  assert.equal(after.clicks, before.clicks + 1, 'only the fill click reached the button');
  assert.equal(after.enters, before.enters, 'no Enter key was sent');
}

function assertRefusal(label: string, result: CliJsonResult): void {
  assert.notEqual(result.status, 0, debug(label, result));
  assert.equal(result.json?.error?.code, 'COMMAND_FAILED', debug(label, result));
  assert.equal(
    result.json?.error?.details?.reason,
    'text_entry_focus_not_observed',
    debug(label, result),
  );
  // The click already reached the page, so the failure must not claim nothing was dispatched.
  assert.equal(result.json?.error?.details?.dispatched, 'unknown', debug(label, result));
}

function debug(label: string, result: CliJsonResult): string {
  return formatResultDebug(label, [], result);
}

type LiveFill = {
  url: string;
  setup(): Promise<void>;
  run(args: string[]): Promise<CliJsonResult>;
  fill(point: Point, text: string): Promise<CliJsonResult>;
  readState(): Promise<FillFixtureState>;
  close(): Promise<void>;
};

async function startLiveFill(): Promise<LiveFill> {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-device-web-fill-'));
  const stateDir = path.join(root, 'state');
  const configPath = path.join(root, 'agent-browser.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ headed: false }));
  const { server, port } = await startFillFixtureServer();
  const session = `wf-${process.pid.toString(36)}-${(Date.now() % 1_679_616).toString(36)}`;
  const env = {
    ...process.env,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_BROWSER_CONFIG: configPath,
    AGENT_BROWSER_HEADED: 'false',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '30000',
  };
  const common = ['--platform', 'web', '--session', session, '--json'];
  const run = (args: string[]) => runBuiltCliJson([...args, ...common], env);
  let opened = false;

  return {
    url: `http://127.0.0.1:${port}/`,
    setup: async () => {
      const result = await runBuiltCliJson(['web', 'setup', '--json'], env);
      assert.equal(result.status, 0, debug('web setup', result));
    },
    run: async (args) => {
      const result = await run(args);
      if (args[0] === 'open') opened = result.status === 0;
      assert.equal(result.status, 0, debug(args.join(' '), result));
      return result;
    },
    fill: (point, text) => run(['fill', String(point[0]), String(point[1]), text]),
    readState: async () => {
      const result = await run(['snapshot']);
      assert.equal(result.status, 0, debug('read state', result));
      const nodes: { value?: unknown }[] = result.json?.data?.nodes ?? [];
      const state = nodes.find((node) => String(node.value).startsWith('{"plain"'));
      assert.ok(state, debug('state node', result));
      return JSON.parse(String(state.value)) as FillFixtureState;
    },
    close: async () => {
      try {
        if (opened) await run(['close']);
      } finally {
        await closeServer(server);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
