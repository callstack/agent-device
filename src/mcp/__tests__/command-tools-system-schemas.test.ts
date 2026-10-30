import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCommandTools } from '../command-tools.ts';
import { commandSupportsSettleObservation } from '@agent-device/command-registry/registry';
import { COMMAND_OUTPUT_SCHEMAS } from '@agent-device/command-surface';
import { validateAgainstSchema } from './output-schema-validator.ts';

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
  assert.deepEqual(
    validateAgainstSchema(
      { platform: 'harmonyos', package: 'com.example.hmapp', activity: 'EntryAbility' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { platform: 'web', package: 'com.example.app', activity: '.MainActivity' },
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
        enum: ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right', 'auto'],
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
        description:
          'TV remote button. Android TV also accepts android-keycode:<n> with n from 1 to 2147483647.',
        oneOf: [
          {
            type: 'string',
            enum: [
              'up',
              'down',
              'left',
              'right',
              'select',
              'menu',
              'home',
              'back',
              'volume-up',
              'volume-down',
              'mute',
              'power',
              'sleep',
              'wake',
              'media-play-pause',
              'media-next',
              'media-previous',
              'media-rewind',
              'media-fast-forward',
              'channel-up',
              'channel-down',
              'last-channel',
              'guide',
              'info',
              'captions',
              'tv-input',
              'color-red',
              'color-green',
              'color-yellow',
              'color-blue',
            ],
          },
          {
            type: 'string',
            pattern:
              '^android-keycode:(?:[1-9][0-9]{0,8}|1[0-9]{9}|20[0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]|214748364[0-7])(?![\\s\\S])',
          },
        ],
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

test('MCP tv remote outputSchema accepts named buttons and raw codes and refuses other strings', () => {
  const tvRemote = listCommandTools().find((tool) => tool.name === 'tv-remote');
  assert.ok(tvRemote?.outputSchema);
  for (const button of ['up', 'volume-down', 'android-keycode:300', 'android-keycode:2147483647']) {
    assert.deepEqual(
      validateAgainstSchema(
        { action: 'tv-remote', button, message: 'Pressed TV remote' },
        tvRemote.outputSchema,
      ),
      [],
    );
  }
  for (const button of [
    'sideways',
    'android-keycode:0',
    'android-keycode:01',
    'android-keycode:2147483648',
    'android-keycode:300\n',
  ]) {
    assert.notDeepEqual(
      validateAgainstSchema(
        { action: 'tv-remote', button, message: 'Pressed TV remote' },
        tvRemote.outputSchema,
      ),
      [],
    );
  }
});
