import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMAND_OWNER_FILES,
  ownerFilesForCommand,
} from '@agent-device/command-registry/owner-files';
import { commandSupportsSettleObservation } from '@agent-device/command-registry/registry';
import { SYSTEM_COMMAND_OUTPUT_SCHEMAS } from '../../commands/system/index.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

const SYSTEM_COMMANDS = Object.keys(SYSTEM_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof SYSTEM_COMMAND_OUTPUT_SCHEMAS
>;

// `back` is the one entry in this family with a post-action observation trait (#1652): the
// composed map grafts a `settle` property onto a COPY, so it is not reference-equal to the
// module's own object. Every other entry in the family carries no such trait and must survive
// the spread untouched.
const SETTLE_DERIVED_COMMANDS = new Set(['back']);

test('MCP system family output schemas are the family module entries, not copies', () => {
  for (const command of SYSTEM_COMMANDS) {
    if (SETTLE_DERIVED_COMMANDS.has(command)) continue;
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      SYSTEM_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the system module's own schema object`,
    );
  }
});

test('a settle-derived system entry still grafts onto the module object, not a foreign copy', () => {
  const moduleBack = SYSTEM_COMMAND_OUTPUT_SCHEMAS.back;
  const derivedBack = COMMAND_OUTPUT_SCHEMAS.back;
  assert.notEqual(derivedBack, moduleBack, 'the derivation pass must copy, never mutate in place');
  assert.equal(derivedBack.required, moduleBack.required, 'required list is not re-derived');
  assert.equal(
    derivedBack.properties?.mode,
    moduleBack.properties?.mode,
    'a field object nested under the derived copy must still be the module property, not a rebuild',
  );
});

test('every system-owned command claims this module, and the module claims nothing else', () => {
  for (const command of SYSTEM_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/system/index.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }

  const commandsOwnedByThisModule = (
    Object.entries(COMMAND_OWNER_FILES) as Array<[string, readonly string[]]>
  )
    .filter(([, ownerFiles]) => ownerFiles.includes('src/commands/system/index.ts'))
    .map(([command]) => command)
    .sort();
  assert.deepEqual(
    commandsOwnedByThisModule,
    [...SYSTEM_COMMANDS].sort(),
    'a command the registry attributes to this module is missing from SYSTEM_COMMAND_OUTPUT_SCHEMAS (or vice versa)',
  );
});

// `appstate` on iOS answers from the session record, and from a live runner when one can read the
// session app's XCUIApplication state; the schema must accept both answers and reject a state word
// the contract does not declare.
const IOS_SESSION_ANSWER: Readonly<Record<string, unknown>> = {
  platform: 'ios',
  appName: 'Benchmark',
  appBundleId: 'dev.e2e.benchmark',
  source: 'session',
  surface: 'app',
  device_udid: '279A81EC-B61A-4BE2-9F71-6A40FB8D2F9A',
  ios_simulator_device_set: null,
};

test('MCP appstate schema accepts the runner-read iOS answer beside the session-only one', () => {
  assert.deepEqual(validateAgainstSchema(IOS_SESSION_ANSWER, COMMAND_OUTPUT_SCHEMAS.appstate), []);
  assert.deepEqual(
    validateAgainstSchema(
      { ...IOS_SESSION_ANSWER, source: 'runner', state: 'runningBackgroundSuspended' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...IOS_SESSION_ANSWER, source: 'runner', state: 'sleeping' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
  assert.deepEqual(
    validateAgainstSchema(
      { platform: 'android', package: 'com.example.app', activity: '.MainActivity' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
});

test('MCP keyboard outputSchema validates a full result and refuses a dropped required action', () => {
  const KEYBOARD_RESULT = {
    platform: 'android',
    action: 'status',
    visible: true,
    inputType: 'text',
  };
  assert.deepEqual(validateAgainstSchema(KEYBOARD_RESULT, COMMAND_OUTPUT_SCHEMAS.keyboard), []);

  const { action: _dropped, ...withoutAction } = KEYBOARD_RESULT;
  assert.deepEqual(validateAgainstSchema(withoutAction, COMMAND_OUTPUT_SCHEMAS.keyboard), [
    '$.action: missing required property',
  ]);
});

// The closed dispatch shape each navigation command's runtime returns
// (packages/contracts/src/navigation.ts). `back` is the settle-capable one, so
// its published schema is this shape PLUS the opt-in `--settle` observation and
// nothing else; the other four must match verbatim.
const NAVIGATION_DISPATCH_SHAPES: Readonly<
  Record<string, { properties: Record<string, unknown>; required: readonly string[] }>
> = {
  back: {
    properties: {
      action: { type: 'string', const: 'back' },
      mode: { type: 'string', enum: ['in-app', 'system'] },
      message: { type: 'string' },
    },
    required: ['action', 'mode', 'message'],
  },
  home: {
    properties: {
      action: { type: 'string', const: 'home' },
      message: { type: 'string' },
    },
    required: ['action', 'message'],
  },
  orientation: {
    properties: {
      action: { type: 'string', const: 'orientation' },
      orientation: {
        type: 'string',
        enum: ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'],
      },
      message: { type: 'string' },
      confirmed: { type: 'boolean' },
      warning: { type: 'string' },
    },
    required: ['action', 'orientation', 'message'],
  },
  'app-switcher': {
    properties: {
      action: { type: 'string', const: 'app-switcher' },
      message: { type: 'string' },
    },
    required: ['action', 'message'],
  },
  'tv-remote': {
    properties: {
      action: { type: 'string', const: 'tv-remote' },
      button: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'back'],
      },
      durationMs: { type: 'number' },
      message: { type: 'string' },
    },
    required: ['action', 'button', 'message'],
  },
};

test('MCP navigation output schemas advertise the closed dispatch shapes', () => {
  for (const [name, dispatchShape] of Object.entries(NAVIGATION_DISPATCH_SHAPES)) {
    const schema = COMMAND_OUTPUT_SCHEMAS[name as keyof typeof COMMAND_OUTPUT_SCHEMAS] as {
      type?: unknown;
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    assert.deepEqual(
      Object.keys(schema).sort(),
      ['properties', 'required', 'type'],
      `${name}: must advertise exactly type/properties/required at the top level`,
    );
    assert.equal(schema.type, 'object', `${name}: must advertise an object schema`);
    const { settle, ...dispatchProperties } = schema.properties ?? {};
    assert.equal(
      Boolean(settle),
      commandSupportsSettleObservation(name),
      `${name}: settle property must track the post-action observation trait`,
    );
    assert.deepEqual(dispatchProperties, dispatchShape.properties);
    assert.deepEqual(schema.required, dispatchShape.required);
  }
});
