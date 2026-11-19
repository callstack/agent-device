import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { SNAPSHOT_BACKEND_CAPABILITIES } from '@agent-device/capture-kit/snapshot-quality-backend-capabilities';
import {
  SNAPSHOT_COMMAND_OPTION_KEYS,
  snapshotOptionsFromFlags,
} from '@agent-device/kernel/snapshot';
import { SNAPSHOT_FLAGS } from '@agent-device/command-registry/flag-groups';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import {
  booleanField,
  enumSchema,
  integerField,
  numberSchema,
  objectSchema,
  optionField,
  stringArraySchema,
  stringField,
  stringSchema,
} from '../command-input.ts';
import type { JsonSchema } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  observationRecordInputFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet, defineParameterlessCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const SNAPSHOT_COMMAND_NAME = 'snapshot';

const snapshotCommandDescription =
  'Capture the accessibility tree or compare it with the previous session baseline. The result includes refs for semantic interactions; the diff option reports UI changes. interactiveOnly lists only elements you can act on. After an action with settle, take a snapshot only when its diff lacks the next target or did not settle.';

const snapshotBackendCapabilityHelp = Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
  .map(([backend, capability]) => {
    const gaps = capability.knownGaps.map((gap) => `known gap ${gap}`);
    return `${backend}: hittable=${capability.hittable}, regular-depth=${capability.regularDepth}, deep-extension=${capability.deepExtension}, depth-ladder=${capability.depthLadder}${gaps.length > 0 ? `, ${gaps.join(', ')}` : ''}`;
  })
  .join('; ');

const snapshotCommandMetadata = defineFieldCommandMetadata(
  SNAPSHOT_COMMAND_NAME,
  snapshotCommandDescription,
  {
    interactiveOnly: booleanField(),
    depth: integerField(),
    scope: stringField(),
    raw: booleanField(),
    customActions: optionField('snapshotCustomActions'),
    observeOnly: optionField('snapshotObserveOnly'),
    forceFull: booleanField(),
    timeoutMs: integerField('Maximum wall-clock time for the snapshot command.'),
    // #1271 stage 2: `snapshot` is observation-only, so a repair-armed heal
    // excludes an out-of-band one by default (ADR 0012 amendment). Exposed
    // here so the Node SDK's typed options and the MCP tool schema can set
    // both flags, mirroring `--no-record`/`--record` on the CLI.
    noRecord: booleanField('Do not record this action.'),
    record: booleanField(
      'Force-record this out-of-band observation into a repair-armed heal (mutually exclusive with noRecord). Authored replay steps are recorded automatically and never need this.',
    ),
  },
);

const snapshotCliSchema = {
  allowedFlags: [
    'snapshotDiff',
    ...SNAPSHOT_FLAGS,
    'snapshotCustomActions',
    'snapshotObserveOnly',
    'snapshotForceFull',
    'timeoutMs',
    'record',
  ],
} as const;

export const snapshotCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...observationRecordInputFromFlags(flags),
  ...snapshotOptionsFromFlags(flags, SNAPSHOT_COMMAND_OPTION_KEYS),
  timeoutMs: flags.timeoutMs,
});

const snapshotDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.snapshot);

export const snapshotCommandFacet = defineCommandFacet({
  name: SNAPSHOT_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Capture or diff the accessibility tree',
    searchHint: 'inspect screen hierarchy',
    cliDetail: `Scoped output (--scope) renders every returned ref with its ref generation pin (@eN~s<refsGeneration>) and one Refs generation line, so a pasted ref targets the ref frame that issued it; --json keeps plain refs plus the response-level refsGeneration, and --raw keeps byte-for-byte output. Regular Android ADB snapshots clip app rectangles outside measured status and navigation bars, including launcher-owned navigation; fully covered content is omitted and --raw retains reported bounds. Ref and selector taps honor measured visible bounds even for refs from raw snapshots. Regular iOS snapshots clip overflowing elements to their visible area and omit fully outside elements. In a regular (non-raw) snapshot, a listed element whose frame has no area is marked [unmeasured]: nothing confirms it is on screen. If it is inside scrollable content, reach it with scroll <direction> --until <selector> before acting on it. --json reports clipping counts in snapshotQualityNotes with code regular-geometry-clipped; --raw retains reported frames. --observe-only is local iOS snapshot-only: an already-ready compatible runner reads the session app without activation or foreground repair, refuses unavailable observation or a readable system alert over the app, and reports XCUIApplication state rather than verified foreground ownership (#2696). Regular targetActivation disclosure stays unchanged (#2682, #2694). Repeated equivalent unfiltered Android snapshots return a compact unchanged acknowledgement. Use --force-full to re-emit the tree; --json and --raw retain full output. Android Appium JSON snapshots publish a display viewport only when measurements before and after the tree agree, independent of tree extent or keyboard content resizing. On Android, JSON value carries field content rather than static labels; saved selectors and replay scripts using value= for static labels must use label= instead; a reported showing hint means value is empty, and text equal to the placeholder is preserved when hint state is unknown. HarmonyOS reads the on-screen keyboard's own system window and publishes the keyboard field of --json output: the field is visibility-only — visible or hidden per the keyboard window's z-order column; a failed probe, an unreadable or conflicting z-order, or a table without the panel publishes unmeasurable, never a guessed band. When an iOS snapshot reports a screen viewport, inspect rects with snapshot -i --json and press the intended control's center, then verify with diff snapshot -i or snapshot --diff. When a fallback cannot establish the screen origin, viewport is omitted and coordinate-derived element actions refuse with window-origin-unknown before input; the snapshot may warn about the unavailable origin. Use a plain screenshot to choose screen coordinates. --actions names the affordances an element merged away (iOS UIAccessibilityCustomAction, React Native accessibilityActions), so a card whose reply or options controls are not separate elements still lists them. The names are for planning, not invocation: no API triggers them, so reach the affordance through the element detail screen, through the same control exposed as a labeled element elsewhere, or by coordinates from its rect. An empty text field with no label or value prints its hint as [placeholder:"..."]; label=, text= and find do not match that hint. iOS backend capability contract: ${snapshotBackendCapabilityHelp}.`,
  },
  metadata: snapshotCommandMetadata,
  run: (client, input) => client.capture.snapshot(input),
  cliSchema: snapshotCliSchema,
  cliReader: snapshotCliReader,
  daemonWriter: snapshotDaemonWriter,
});

const AUDIT_COMMAND_NAME = 'audit';

/**
 * This family's advertised MCP `outputSchema`, keyed by daemon command name and projected into
 * the command map by `command-output-schemas.ts`. Non-strict: additive response fields keep
 * validating.
 */
export const AUDIT_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/audit.ts
  audit: objectSchema(
    {
      findings: {
        type: 'array',
        items: objectSchema(
          {
            kind: enumSchema(['small-target', 'missing-name', 'ambiguous-name', 'covered-control']),
            severity: enumSchema(['warning', 'observation']),
            ref: stringSchema('Plain ref, usable in the frame this audit published.'),
            rect: objectSchema(
              {
                x: numberSchema(),
                y: numberSchema(),
                width: numberSchema(),
                height: numberSchema(),
              },
              ['x', 'y', 'width', 'height'],
            ),
            role: stringSchema(),
            label: stringSchema(),
            identifier: stringSchema(),
            detail: {
              oneOf: [
                // A `small-target` detail.
                objectSchema(
                  {
                    unit: enumSchema(['pt', 'dp']),
                    width: numberSchema(),
                    height: numberSchema(),
                    recommendedSize: numberSchema(),
                  },
                  ['unit', 'width', 'height', 'recommendedSize'],
                ),
                // An `ambiguous-name` detail.
                objectSchema({ name: stringSchema(), count: numberSchema() }, ['name', 'count']),
              ],
            },
          },
          ['kind', 'severity', 'ref', 'role'],
        ),
      },
      guidance: objectSchema(
        {
          'small-target': stringSchema(),
          'missing-name': stringSchema(),
          'ambiguous-name': stringSchema(),
          'covered-control': stringSchema(),
        },
        [],
      ),
      checks: objectSchema(
        {
          snapshot: enumSchema(
            ['complete', 'partial', 'unknown'],
            'unknown: the capture cannot report truncation, so controls may be missing.',
          ),
        },
        ['snapshot'],
      ),
      limitations: stringArraySchema(),
      refsGeneration: numberSchema(
        'Present only with findings: pair each ref with it (@eN~sG) before a mutation.',
      ),
      warnings: stringArraySchema(),
    },
    ['findings', 'guidance', 'checks', 'limitations'],
  ),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'audit'>;

const auditCommandDescription =
  'Report advisory accessibility findings from one fresh capture of the current screen: touch targets below the platform recommendation, controls without an accessible name, controls of one role that share one accessible name, and covered controls. Each finding shows its role. Missing-name findings omit rejected labels and can show the captured identifier. Other findings include the captured label when available. Guidance follows once per finding kind. Covered controls remain findings inside scroll containers. UIKit sheet grabbers are exempt from size and name checks. Direct items of recognized native iOS bars skip size checks and keep name checks. Custom bar children and nested app content remain subject to size checks. Findings are review prompts, not failures, and the audit changes nothing on the device.';

export const auditCommandFacet = defineParameterlessCommandFacet({
  name: AUDIT_COMMAND_NAME,
  effect: 'write',
  description: auditCommandDescription,
  text: {
    summary: 'Report advisory accessibility findings',
    searchHint: 'a11y lint voiceover talkback',
    cliDetail:
      'Findings are a partial ref publication, like find: the text prints each ref pinned (@eN~sG), and a plain ref from before the audit stays refused after the frame expires. An audit with no findings changes no ref state. Target size is checked on iOS in points (44) and on Android in dp (48, from the captured display density); other targets report a limitation instead. Duplicate wrapper controls collapse only when a control is the sole child of a control with the same role. A name two or more controls of one role share is reported once per control, ignoring case and surrounding whitespace; controls of different roles may share a name.',
  },
  run: (client, input) => client.capture.audit(input),
});
