import assert from 'node:assert/strict';
import { test } from 'vitest';
import { commandSupportsSettleObservation } from '../../core/command-descriptor/registry.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

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
