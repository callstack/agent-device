import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';
import { resolveCommandRecordsSessionAction } from '../../core/command-descriptor/registry.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { AppError } from '../../kernel/errors.ts';
import { NAVIGATION_COMMAND_PROJECTIONS } from '../../commands/system/navigation-projection.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

test('MCP command tool executor hides client creation behind an execution adapter', async () => {
  const client = {} as AgentDeviceClient;
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return client;
    },
    runCommand: async (actualClient, name, input) => {
      calls.push({ client: actualClient, name, input });
      return { message: `Ran ${name}`, ok: true };
    },
  });

  const result = await executor.execute('wait', {
    stateDir: '/tmp/agent-device-mcp',
    mcpOutputFormat: 'optimized',
  });

  assert.deepEqual(createdConfigs, [{ stateDir: '/tmp/agent-device-mcp' }]);
  assert.deepEqual(calls, [
    {
      client,
      name: 'wait',
      input: {},
    },
  ]);
  assert.deepEqual(result.structuredContent, { message: 'Ran wait', ok: true });
  assert.equal(result.content[0]?.text, 'Ran wait');
});

test('MCP command tool executor renders optimized snapshot text by default', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Button',
          label: 'Continue',
          enabled: true,
        },
      ],
      truncated: false,
    }),
  });

  const result = await executor.execute('snapshot', {});

  assert.match(result.content[0]?.text ?? '', /@e1 \[button\] "Continue"/);
  assert.doesNotMatch(result.content[0]?.text ?? '', /^\{/);
});

test('MCP renders a non-default response level as JSON text, not misleading optimized text', async () => {
  // With responseLevel:digest the daemon returns the digest shape (no `nodes`).
  // The optimized snapshot formatter expects `nodes` and would print
  // "Snapshot: 0 nodes" — contradicting structuredContent. The text must instead
  // be the digest payload verbatim (JSON), even though mcpOutputFormat is optimized.
  const digest = { nodeCount: 3, refs: [{ ref: 'e1', label: 'Continue' }], truncated: false };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => digest,
  });

  const result = await executor.execute('snapshot', {
    mcpOutputFormat: 'optimized',
    responseLevel: 'digest',
  });

  assert.deepEqual(result.structuredContent, digest);
  assert.match(result.content[0]?.text ?? '', /^\{/);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), digest);
  assert.doesNotMatch(result.content[0]?.text ?? '', /Snapshot: 0 nodes/);
});

test('MCP command tool executor renders JSON text when requested', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, _name, input) => {
      assert.deepEqual(input, {});
      return {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'Button',
            label: 'Continue',
            enabled: true,
          },
        ],
        truncated: false,
      };
    },
  });

  const result = await executor.execute('snapshot', { mcpOutputFormat: 'json' });

  assert.match(result.content[0]?.text ?? '', /^\{\n  "nodes": \[/);
  assert.match(result.content[0]?.text ?? '', /"label": "Continue"/);
});

test('MCP tool schemas add MCP client config fields at the MCP boundary', () => {
  const devicesTool = listCommandTools().find((tool) => tool.name === 'devices');

  assert.ok(devicesTool);
  assert.ok('stateDir' in (devicesTool.inputSchema.properties ?? {}));
  assert.deepEqual(
    (devicesTool.inputSchema.properties?.mcpOutputFormat as { enum?: unknown[] } | undefined)?.enum,
    ['optimized', 'json'],
  );
  assert.equal(
    (devicesTool.inputSchema.properties?.includeCost as { type?: string } | undefined)?.type,
    'boolean',
  );
  assert.deepEqual(
    (devicesTool.inputSchema.properties?.responseLevel as { enum?: unknown[] } | undefined)?.enum,
    ['digest', 'default', 'full'],
  );
});

test('MCP gesture tool exposes and forwards two-finger pan topology', async () => {
  const gesture = listCommandTools().find((tool) => tool.name === 'gesture');
  assert.ok(gesture);
  assert.deepEqual(gesture.inputSchema.properties?.pointerCount, {
    type: 'integer',
    description: 'Pan touch pointer count (1 or 2).',
    minimum: 1,
    maximum: 2,
  });

  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { message: 'Panned' };
    },
  });
  await executor.execute('gesture', {
    kind: 'pan',
    origin: { x: 100, y: 200 },
    delta: { x: 40, y: -20 },
    pointerCount: 2,
  });

  assert.deepEqual(calls, [
    {
      name: 'gesture',
      input: {
        kind: 'pan',
        origin: { x: 100, y: 200 },
        delta: { x: 40, y: -20 },
        pointerCount: 2,
      },
    },
  ]);
});

test('MCP gesture metadata exposes pan/transform duration', () => {
  const gesture = listCommandTools().find((tool) => tool.name === 'gesture');
  assert.ok(gesture);
  assert.equal(gesture.inputSchema.properties?.velocity, undefined);
  assert.deepEqual(gesture.inputSchema.properties?.durationMs, {
    type: 'integer',
    description: 'Pan/transform duration.',
    minimum: 16,
    maximum: 10_000,
  });
});

test('MCP swipe tool exposes bounded repetition inputs', () => {
  const swipe = listCommandTools().find((tool) => tool.name === 'swipe');
  assert.ok(swipe);
  assert.deepEqual(swipe.inputSchema.properties?.count, {
    type: 'integer',
    description: 'Number of swipe repetitions.',
    minimum: 1,
    maximum: 200,
  });
  assert.deepEqual(swipe.inputSchema.properties?.pauseMs, {
    type: 'integer',
    description: 'Pause between repeated swipes.',
    minimum: 0,
    maximum: 10_000,
  });
});

test('MCP includeCost:true opts into agent-cost: sets client.cost, strips the arg, surfaces cost', async () => {
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { waitedMs: 42, cost: { wallClockMs: 42, runnerRoundTrips: 0 } };
    },
  });

  const result = await executor.execute('wait', { includeCost: true });

  // includeCost maps to the client `cost` config (→ meta.includeCost on the daemon).
  assert.deepEqual(createdConfigs, [{ cost: true }]);
  // includeCost is an MCP-boundary field and must not leak into the command input.
  assert.deepEqual(calls, [{ name: 'wait', input: {} }]);
  // The daemon-provided cost rides through structuredContent unchanged.
  assert.deepEqual(result.structuredContent, {
    waitedMs: 42,
    cost: { wallClockMs: 42, runnerRoundTrips: 0 },
  });
});

test('MCP includeCost absent/false leaves the request shape untouched (no cost config)', async () => {
  const createdConfigs: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ message: 'ok' }),
  });

  const absent = await executor.execute('wait', {});
  const explicitFalse = await executor.execute('wait', { includeCost: false });

  // Neither path sets `cost` on the client config; both are byte-identical configs.
  assert.deepEqual(createdConfigs, [{}, {}]);
  assert.deepEqual(absent.structuredContent, { message: 'ok' });
  assert.equal(JSON.stringify(absent), JSON.stringify(explicitFalse));
});

test('MCP includeCost rejects non-boolean values at the boundary', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({}),
  });

  await assert.rejects(
    executor.execute('wait', { includeCost: 'yes' }),
    /Expected includeCost to be a boolean\./,
  );
});

test('MCP responseLevel:digest opts into a verbosity level: sets client.responseLevel, strips the arg', async () => {
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { message: `Ran ${name}` };
    },
  });

  const result = await executor.execute('wait', { responseLevel: 'digest' });

  // responseLevel maps to the client `responseLevel` config (→ meta.responseLevel on the daemon).
  assert.deepEqual(createdConfigs, [{ responseLevel: 'digest' }]);
  // responseLevel is an MCP-boundary field and must not leak into the command input.
  assert.deepEqual(calls, [{ name: 'wait', input: {} }]);
  assert.deepEqual(result.structuredContent, { message: 'Ran wait' });
});

test('MCP responseLevel absent leaves the request shape untouched (no responseLevel config)', async () => {
  const createdConfigs: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ message: 'ok' }),
  });

  const absent = await executor.execute('wait', {});

  // The absent path never sets `responseLevel`; the config is byte-identical to today.
  assert.deepEqual(createdConfigs, [{}]);
  assert.deepEqual(absent.structuredContent, { message: 'ok' });
});

test('MCP responseLevel rejects unknown values at the boundary', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({}),
  });

  await assert.rejects(
    executor.execute('wait', { responseLevel: 'verbose' }),
    /Expected responseLevel to be one of 'digest', 'default', or 'full'\./,
  );
});

test('MCP keyboard outputSchema advertises flat contract discriminants', () => {
  const tools = listCommandTools();

  const keyboard = tools.find((tool) => tool.name === 'keyboard');
  assert.ok(keyboard);
  assert.ok(keyboard.outputSchema);
  assert.equal(keyboard.outputSchema.type, 'object');
  assert.deepEqual(
    (keyboard.outputSchema.properties?.action as { enum?: unknown[] } | undefined)?.enum,
    ['status', 'dismiss', 'enter'],
  );
  assert.deepEqual(
    (keyboard.outputSchema.properties?.platform as { enum?: unknown[] } | undefined)?.enum,
    ['android', 'ios'],
  );
});

test('MCP clipboard outputSchema advertises action union branches', () => {
  const tools = listCommandTools();

  const clipboard = tools.find((tool) => tool.name === 'clipboard');
  assert.ok(clipboard);
  assert.ok(clipboard.outputSchema);
  const clipboardActions = (clipboard.outputSchema.oneOf ?? []).map(
    (branch) => (branch.properties?.action as { const?: unknown } | undefined)?.const,
  );
  assert.deepEqual(clipboardActions, ['read', 'write']);
});

test('MCP tv remote outputSchema advertises button values', () => {
  const tools = listCommandTools();

  const tvRemote = tools.find((tool) => tool.name === 'tv-remote');
  assert.ok(tvRemote);
  assert.ok(tvRemote.outputSchema);
  assert.deepEqual(
    (tvRemote.outputSchema.properties?.button as { enum?: unknown[] } | undefined)?.enum,
    ['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'back'],
  );
});

test('MCP navigation output schemas are projected from the canonical executable contracts', () => {
  for (const [name, projection] of Object.entries(NAVIGATION_COMMAND_PROJECTIONS)) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[name as keyof typeof COMMAND_OUTPUT_SCHEMAS],
      projection.outputSchema,
    );
  }
});

test('MCP newly typed outputSchemas advertise public contract keys', () => {
  const tools = listCommandTools();

  const wait = tools.find((tool) => tool.name === 'wait');
  assert.ok(wait);
  assert.ok(wait.outputSchema);
  assert.deepEqual(wait.outputSchema.required, ['waitedMs']);

  const triggerAppEvent = tools.find((tool) => tool.name === 'trigger-app-event');
  assert.ok(triggerAppEvent);
  assert.ok(triggerAppEvent.outputSchema);
  assert.equal(
    (triggerAppEvent.outputSchema.properties?.transport as { const?: unknown } | undefined)?.const,
    'deep-link',
  );
});

test('MCP click outputSchema validates default and digest resolution disclosures', () => {
  const click = listCommandTools().find((tool) => tool.name === 'click');
  assert.ok(click?.outputSchema);
  assert.equal(click.outputSchema, COMMAND_OUTPUT_SCHEMAS.click);

  const resolutionSchema = click.outputSchema.properties?.resolution;
  const disambiguated = resolutionSchema?.oneOf?.find(
    (branch) =>
      (branch.properties?.kind as { const?: unknown } | undefined)?.const === 'disambiguated',
  );
  assert.ok(disambiguated);

  const digestResolution = {
    source: 'runtime',
    phase: 'pre-action',
    kind: 'disambiguated',
    matchCount: 2,
    winnerDiagnostic: { diagnosticRef: 'diag-e2' },
    tiebreak: 'deepest',
  };
  for (const required of disambiguated.required ?? []) {
    assert.ok(
      required in digestResolution,
      `digest resolution is missing required key: ${required}`,
    );
  }
  // The verbose default/full response still exposes the bounded candidate list.
  assert.ok('alternatives' in (disambiguated.properties ?? {}));
});

test('MCP prepare outputSchema stays complete for the typed non-exposed command', () => {
  const prepareSchema = COMMAND_OUTPUT_SCHEMAS.prepare;
  assert.ok(prepareSchema.required?.includes('runner'));
  assert.ok(prepareSchema.required?.includes('timing'));
});

test('MCP untyped object tools stay byte-identical: no outputSchema key', () => {
  const tools = listCommandTools();

  // snapshot is intentionally absent from the typed registry (dynamic shape).
  const snapshot = tools.find((tool) => tool.name === 'snapshot');
  assert.ok(snapshot);
  assert.equal('outputSchema' in snapshot, false);
});

test('MCP boot structuredContent is consistent with its advertised outputSchema', async () => {
  const bootResult = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 16',
    id: 'UDID-123',
    kind: 'simulator',
    booted: true,
  };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => bootResult,
  });

  const bootTool = listCommandTools().find((tool) => tool.name === 'boot');
  assert.ok(bootTool?.outputSchema);
  const required = bootTool.outputSchema.required ?? [];
  for (const key of required) {
    assert.ok(key in bootResult, `boot result is missing required outputSchema key: ${key}`);
  }

  const result = await executor.execute('boot', {});
  assert.deepEqual(result.structuredContent, bootResult);
});

// --- #1219 public Apple platform parity in MCP output schemas ---
// These validate representative structured content against the COMPLETE
// advertised schema (enums/consts and nested required fields), not just the
// presence of required keys, and pin the negative cases the required-only check
// silently accepted.

function bootResultFor(platform: 'ios' | 'macos') {
  return {
    platform,
    target: platform === 'macos' ? 'desktop' : 'mobile',
    device: platform === 'macos' ? 'My Mac' : 'iPhone 16',
    id: 'UDID-123',
    kind: platform === 'macos' ? 'device' : 'simulator',
    booted: true,
    // Additive Apple-OS discriminant rides alongside the leaf platform.
    appleOs: platform,
  } as const;
}

function shutdownResultFor(platform: 'ios' | 'macos') {
  const { platform: leaf, target, device, id, kind, appleOs } = bootResultFor(platform);
  return {
    platform: leaf,
    target,
    device,
    id,
    kind,
    appleOs,
    shutdown: { success: true, exitCode: 0, stdout: '', stderr: '' },
  };
}

function prepareResultFor(platform: 'ios' | 'macos') {
  return {
    action: 'ios-runner',
    platform,
    deviceId: 'UDID-123',
    deviceName: 'iPhone 16',
    kind: 'simulator',
    durationMs: 1200,
    runner: {},
    connectMs: 100,
    healthCheckMs: 50,
    timing: {
      totalMs: 1200,
      additiveParts: { connectAfterBuildMs: 100, healthCheckMs: 50 },
      containment: { healthCheckMs: [] },
      note: 'ok',
    },
    message: 'prepared',
  };
}

test('MCP boot/shutdown schemas advertise public Apple leaves, never internal apple', () => {
  const platformEnum = COMMAND_OUTPUT_SCHEMAS.boot.properties?.platform?.enum;
  assert.deepEqual(platformEnum, ['ios', 'macos', 'android', 'linux', 'web']);
  assert.equal(platformEnum?.includes('apple'), false);
  // shutdown shares the same resolved-device header.
  assert.deepEqual(COMMAND_OUTPUT_SCHEMAS.shutdown.properties?.platform?.enum, platformEnum);
});

test('MCP valid ios/macos boot results satisfy the complete boot schema', () => {
  for (const platform of ['ios', 'macos'] as const) {
    assert.deepEqual(
      validateAgainstSchema(bootResultFor(platform), COMMAND_OUTPUT_SCHEMAS.boot),
      [],
    );
  }
});

test('MCP valid ios/macos shutdown results satisfy the complete shutdown schema', () => {
  for (const platform of ['ios', 'macos'] as const) {
    assert.deepEqual(
      validateAgainstSchema(shutdownResultFor(platform), COMMAND_OUTPUT_SCHEMAS.shutdown),
      [],
    );
  }
});

test('MCP boot schema rejects the internal apple platform and unknown enum values', () => {
  // Internal identity must not be advertised on the public result field.
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...bootResultFor('ios'), platform: 'apple' },
      COMMAND_OUTPUT_SCHEMAS.boot,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...bootResultFor('ios'), platform: 'windows' },
      COMMAND_OUTPUT_SCHEMAS.boot,
    ),
    [],
  );
  // The `booted` discriminant is a const true; a false value fails the schema.
  assert.notDeepEqual(
    validateAgainstSchema({ ...bootResultFor('ios'), booted: false }, COMMAND_OUTPUT_SCHEMAS.boot),
    [],
  );
  // A missing nested-required shutdown field (stderr) fails validation.
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...shutdownResultFor('ios'), shutdown: { success: true, exitCode: 0, stdout: '' } },
      COMMAND_OUTPUT_SCHEMAS.shutdown,
    ),
    [],
  );
});

test('MCP prepare schema mirrors its PublicPlatform contract', () => {
  const platformEnum = COMMAND_OUTPUT_SCHEMAS.prepare.properties?.platform?.enum;
  assert.deepEqual(platformEnum, ['ios', 'macos', 'android', 'linux', 'web']);
  assert.equal(platformEnum?.includes('apple'), false);

  for (const platform of ['ios', 'macos'] as const) {
    assert.deepEqual(
      validateAgainstSchema(prepareResultFor(platform), COMMAND_OUTPUT_SCHEMAS.prepare),
      [],
    );
  }
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...prepareResultFor('ios'), platform: 'apple' },
      COMMAND_OUTPUT_SCHEMAS.prepare,
    ),
    [],
  );
});

test('MCP session tool exposes publication and resolves state-dir without a daemon round-trip', async () => {
  const sessionTool = listCommandTools().find((tool) => tool.name === 'session');
  assert.ok(sessionTool);
  assert.deepEqual(
    (sessionTool.inputSchema.properties?.action as { enum?: unknown[] } | undefined)?.enum,
    ['list', 'state-dir', 'save-script'],
  );

  const executor = createCommandToolExecutor({
    createClient: () =>
      ({
        sessions: { stateDir: async () => '/tmp/agent-device-dev-state' },
      }) as unknown as AgentDeviceClient,
  });
  const result = await executor.execute('session', { action: 'state-dir' });

  assert.deepEqual(result.structuredContent, { stateDir: '/tmp/agent-device-dev-state' });
});

test('MCP renders tool text from the unpinned input so the model never sees suffixes', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) =>
      name === 'snapshot'
        ? { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 9 }
        : { message: 'Tapped @e2 (10, 20)' },
  });

  await executor.execute('snapshot', {});
  const result = await executor.execute('press', { target: { kind: 'ref', ref: '@e2' } });

  assert.doesNotMatch(result.content[0]?.text ?? '', /~s9/);
});

test('MCP command tool executor pins refs for runCommand while keeping rendered text unpinned', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      if (name === 'snapshot') {
        return { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 500012 };
      }
      return { message: 'Tapped @e2 (10, 20)' };
    },
  });

  await executor.execute('snapshot', { session: 'demo' });
  const result = await executor.execute('press', {
    session: 'demo',
    target: { kind: 'ref', ref: '@e2' },
  });

  assert.deepEqual(runCalls[1], {
    name: 'press',
    input: { session: 'demo', target: { kind: 'ref', ref: '@e2~s500012' } },
  });
  assert.doesNotMatch(result.content[0]?.text ?? '', /~s500012/);
});

// --- ADR 0012 migration step 2: replay divergence is a ref-issuing error ---

function replayDivergenceError(): AppError {
  return new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2 (click "Save"): not hittable', {
    step: 2,
    action: 'click',
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 2 } },
      action: 'click "Save"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: {
        state: 'available',
        refsGeneration: 12,
        refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
      },
      suggestions: [
        { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
      ],
      suggestionCount: 1,
      resume: { allowed: false, reason: 'resume not yet supported' },
      // ADR 0012 decision 6: always present, and must survive every
      // projection — text, JSON, client AppError, and this MCP structuredContent.
      repairHint: 'record-and-heal',
    },
  });
}

test('MCP tool error is a ref-issuing result: isError, structuredContent, and pinned screen refs', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      if (name === 'replay') throw replayDivergenceError();
      return {};
    },
  });

  const result = await executor.execute('replay', { positionals: ['/tmp/flow.ad'] });

  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    code: string;
    details?: {
      divergence?: { screen?: { refs?: Array<{ ref: string }> }; repairHint?: string };
    };
  };
  assert.equal(structured.code, 'REPLAY_DIVERGENCE');
  assert.equal(structured.details?.divergence?.screen?.refs?.[0]?.ref, 'e5');
  // ADR 0012 decision 6: repairHint survives the structuredContent projection.
  assert.equal(structured.details?.divergence?.repairHint, 'record-and-heal');
  // The MCP TEXT path must carry the same repair data as structuredContent —
  // no text-only divergence that loses the screen refs / suggestions.
  const text = result.content[0]?.text ?? '';
  assert.match(text, /Error \(REPLAY_DIVERGENCE\)/);
  assert.match(text, /Divergence at step 2 \(\/tmp\/flow\.ad:2\)/);
  assert.match(text, /Screen: 1 actionable ref\(s\) captured/);
  // The ref entries themselves ride in the text so a text-only agent can act.
  assert.match(text, /@e5 \[button\] "Save"/);
  assert.match(text, /Suggestions:/);
  assert.match(text, /\[id\] "Save" id="save"/);
  // ADR 0012 decision 6: repairHint survives the MCP text projection too.
  assert.match(text, /Repair hint: record-and-heal/);

  // The error-path screen ref is pinned exactly like a successful ref-issuing
  // response — the caller's next command against @e5 forwards the generation.
  await executor.execute('press', { target: { kind: 'ref', ref: '@e5' } });
  assert.deepEqual(runCalls[1]?.input, { target: { kind: 'ref', ref: '@e5~s12' } });
});

// --- #1262: a `caution` divergence's dual-path must reach a structured caller,
// not only text. `resume.alternateFrom` rides the MCP structuredContent
// projection (parity with a text caller, who reads the second `--from`
// command), and the MCP text carries BOTH concrete commands. ---
test("MCP projections carry a caution divergence's alternateFrom (structuredContent) and both --from commands (text)", async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) => {
      if (name === 'replay') {
        throw new AppError('REPLAY_DIVERGENCE', 'Replay diverged at step 2 (click label="Save")', {
          divergence: {
            version: 1,
            kind: 'identity-mismatch',
            step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
            action: 'click label="Save"',
            cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
            screen: {
              state: 'available',
              refsGeneration: 4,
              refs: [{ ref: 'e1', role: 'button' }],
            },
            suggestions: [],
            suggestionCount: 0,
            resume: { allowed: true, from: 2, planDigest: 'deadbeef', alternateFrom: 3 },
            repairHint: 'caution',
          },
        });
      }
      return {};
    },
  });

  const result = await executor.execute('replay', { positionals: ['/tmp/flow.ad'] });
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    details?: { divergence?: { resume?: { from?: number; alternateFrom?: number } } };
  };
  // Parity: the structured caller gets BOTH ordinals, not just `from`.
  assert.equal(structured.details?.divergence?.resume?.from, 2);
  assert.equal(structured.details?.divergence?.resume?.alternateFrom, 3);
  // The MCP text carries both concrete commands, the second from alternateFrom.
  const text = result.content[0]?.text ?? '';
  assert.match(text, /Repair hint: caution/);
  assert.match(text, /if you fixed app state with --no-record actions: replay --from 2/);
  assert.match(text, /if you performed the step's intent as a recorded action: replay --from 3/);
});

// --- #1271 stage 2 (ADR 0012 amendment): `record`/`noRecord` on the MCP
// tool schema for the observation-only commands the repair-segment default
// exclusion targets. ---

test('MCP get/is/find/snapshot tools expose record and noRecord in their input schema', () => {
  for (const name of ['get', 'is', 'find', 'snapshot']) {
    const tool = listCommandTools().find((candidate) => candidate.name === name);
    assert.ok(tool, `expected an MCP tool named ${name}`);
    const properties = tool.inputSchema.properties ?? {};
    assert.equal(
      (properties.record as { type?: string } | undefined)?.type,
      'boolean',
      `${name} tool is missing a boolean 'record' input`,
    );
    assert.equal(
      (properties.noRecord as { type?: string } | undefined)?.type,
      'boolean',
      `${name} tool is missing a boolean 'noRecord' input`,
    );
  }
});

test('MCP forwards record/noRecord from a get tool call through to the executed command input', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { text: 'hello' };
    },
  });
  await executor.execute('get', {
    format: 'text',
    target: { kind: 'ref', ref: '@e5' },
    record: true,
  });
  assert.deepEqual(calls, [
    {
      name: 'get',
      input: { format: 'text', target: { kind: 'ref', ref: '@e5' }, record: true },
    },
  ]);
});

// --- #1310: `noRecord` on every recordable command's MCP tool schema ---

test('MCP tool schemas advertise noRecord for every recordable command', () => {
  for (const tool of listCommandTools()) {
    const properties = tool.inputSchema.properties ?? {};
    if (resolveCommandRecordsSessionAction(tool.name)) {
      assert.equal(
        (properties.noRecord as { type?: string } | undefined)?.type,
        'boolean',
        `${tool.name} tool is missing a boolean 'noRecord' input`,
      );
      // --record is scoped to observation-only commands; mutating actions record by default.
      if (properties.record !== undefined) {
        assert.equal(
          (properties.record as { type?: string } | undefined)?.type,
          'boolean',
          `${tool.name} tool has a non-boolean 'record' input`,
        );
      }
    } else {
      assert.equal(
        properties.noRecord,
        undefined,
        `${tool.name} tool should not expose 'noRecord'`,
      );
    }
  }
});

test('MCP forwards noRecord from a press tool call through to the executed command input', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });
  await executor.execute('press', {
    target: { kind: 'ref', ref: '@e5' },
    noRecord: true,
  });
  assert.deepEqual(calls, [
    {
      name: 'press',
      input: { target: { kind: 'ref', ref: '@e5' }, noRecord: true },
    },
  ]);
});
