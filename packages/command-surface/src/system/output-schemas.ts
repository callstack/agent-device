import { BACK_MODES } from '@agent-device/contracts/back-mode';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import {
  FOLD_SCREEN_COORDINATE_SPACE,
  FOLD_POSES,
  HARDWARE_BUTTON_NAMES,
  LOCK_SCREEN_STATES,
  ORIENTATION_REQUESTS,
  TELEPHONY_CALL_ACTIONS,
} from '@agent-device/contracts/device';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import { APPLE_APPLICATION_STATES } from '@agent-device/kernel/snapshot';
import type { JsonSchema } from '../command-contract.ts';
import {
  booleanSchema,
  constSchema,
  enumSchema,
  numberSchema,
  objectSchema,
  stringSchema,
} from '../command-input.ts';
import { tvRemoteButtonSchema } from './tv-remote.ts';

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields such as `settle`/`cost` keep
 * validating. `back`'s settle observation is grafted separately by the trait derivation pass.
 */
export const SYSTEM_COMMAND_OUTPUT_SCHEMAS = {
  back: objectSchema(
    {
      action: constSchema('back'),
      mode: enumSchema(BACK_MODES),
      message: stringSchema(),
    },
    ['action', 'mode', 'message'],
  ),
  home: objectSchema({ action: constSchema('home'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  orientation: objectSchema(
    {
      action: constSchema('orientation'),
      orientation: enumSchema(ORIENTATION_REQUESTS),
      message: stringSchema(),
      confirmed: booleanSchema(),
      warning: stringSchema(),
    },
    ['action', 'orientation', 'message'],
  ),
  'app-switcher': objectSchema({ action: constSchema('app-switcher'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  fold: objectSchema(
    {
      action: constSchema('fold'),
      pose: enumSchema(FOLD_POSES),
      hingeAngleDegrees: numberSchema(
        'Hinge angle read back after the pose settled: from CoreMotion inside the simulator on iOS, from the emulator hinge sensor on Android.',
      ),
      screen: objectSchema(
        {
          display: stringSchema('CoreDevice name of the panel the device now lights.'),
          coordinateSpace: constSchema(FOLD_SCREEN_COORDINATE_SPACE),
          widthPt: numberSchema(
            'Panel width in native panel points (pixels divided by point scale), NOT snapshot coordinates; take a fresh snapshot to place a tap.',
          ),
          heightPt: numberSchema(
            'Panel height in native panel points (pixels divided by point scale), NOT snapshot coordinates; take a fresh snapshot to place a tap.',
          ),
        },
        ['display', 'coordinateSpace', 'widthPt', 'heightPt'],
      ),
      message: stringSchema(),
    },
    ['action', 'pose', 'hingeAngleDegrees', 'message'],
  ),
  'action-button': objectSchema({ action: constSchema('action-button'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  shake: objectSchema({ action: constSchema('shake'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  'tv-remote': objectSchema(
    {
      action: constSchema('tv-remote'),
      button: tvRemoteButtonSchema,
      durationMs: numberSchema(),
      message: stringSchema(),
    },
    ['action', 'button', 'message'],
  ),
  'hardware-button': objectSchema(
    {
      action: constSchema('hardware-button'),
      button: enumSchema(HARDWARE_BUTTON_NAMES),
      message: stringSchema(),
    },
    ['action', 'button', 'message'],
  ),
  'lock-screen': objectSchema(
    {
      action: constSchema('lock-screen'),
      state: enumSchema(LOCK_SCREEN_STATES),
      message: stringSchema(),
    },
    ['action', 'state', 'message'],
  ),
  // packages/contracts/src/telephony-input.ts — discriminated union on `action`.
  telephony: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          action: enumSchema(TELEPHONY_CALL_ACTIONS),
          number: stringSchema(),
          message: stringSchema(),
        },
        ['action', 'number', 'message'],
      ),
      objectSchema(
        {
          action: constSchema('sms'),
          number: stringSchema(),
          textLength: numberSchema('Length of the delivered message text.'),
          message: stringSchema(),
        },
        ['action', 'number', 'textLength', 'message'],
      ),
    ],
  },
  // packages/contracts/src/clipboard.ts — discriminated union on `action`.
  clipboard: {
    type: 'object',
    oneOf: [
      objectSchema({ action: constSchema('read'), text: stringSchema() }, ['action', 'text']),
      objectSchema(
        { action: constSchema('write'), textLength: numberSchema(), message: stringSchema() },
        ['action', 'textLength', 'message'],
      ),
    ],
  },
  // packages/contracts/src/app-state.ts — discriminated union on `platform`.
  appstate: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          platform: enumSchema(['ios', 'macos']),
          appName: stringSchema(),
          appBundleId: stringSchema(),
          source: enumSchema(
            ['session', 'runner'],
            'runner when a live runner read the session app state; session when the record alone answered.',
          ),
          state: enumSchema(
            APPLE_APPLICATION_STATES,
            'The session app XCUIApplication state as a live runner reads it; absent with source session.',
          ),
          surface: enumSchema(SESSION_SURFACES),
          device_udid: stringSchema('iOS only — the session device UDID.'),
          ios_simulator_device_set: {
            type: ['string', 'null'],
            description: 'iOS only — the simulator set path, or null when unknown.',
          },
        },
        ['platform', 'appName', 'source', 'surface'],
      ),
      objectSchema(
        {
          platform: enumSchema(['android', 'harmonyos']),
          package: stringSchema(),
          activity: stringSchema(),
        },
        ['platform', 'package', 'activity'],
      ),
    ],
  },
  // packages/contracts/src/keyboard.ts — flat closed shape; `platform`/`action` always present.
  keyboard: objectSchema(
    {
      platform: enumSchema(['android', 'ios']),
      action: enumSchema(['status', 'dismiss', 'enter']),
      visible: booleanSchema(),
      wasVisible: booleanSchema(),
      dismissed: booleanSchema(),
      attempts: numberSchema(),
      inputType: stringSchema(),
      type: enumSchema(['text', 'number', 'email', 'phone', 'password', 'datetime', 'unknown']),
      inputMethodPackage: stringSchema(),
      focusedPackage: stringSchema(),
      focusedResourceId: stringSchema(),
      inputOwner: enumSchema(['app', 'ime', 'unknown']),
      // `status` on a visible keyboard only: what its return key offers, and where the platform can
      // read it, the wording the key shows. `command-output-schemas-system.test.ts` pins these twelve
      // words to `KEYBOARD_RETURN_KEYS`, the one owner of the vocabulary.
      returnKey: enumSchema([
        'go',
        'search',
        'send',
        'next',
        'done',
        'previous',
        'join',
        'route',
        'continue',
        'enter',
        'none',
        'unknown',
      ]),
      returnKeyLabel: stringSchema(),
      message: stringSchema(),
    },
    ['platform', 'action'],
  ),
} satisfies Pick<
  Record<keyof CommandResultMap, JsonSchema>,
  | 'back'
  | 'home'
  | 'orientation'
  | 'app-switcher'
  | 'fold'
  | 'action-button'
  | 'shake'
  | 'tv-remote'
  | 'hardware-button'
  | 'lock-screen'
  | 'telephony'
  | 'clipboard'
  | 'appstate'
  | 'keyboard'
>;
