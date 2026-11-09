import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';

const { runHarmonyHdc, runHarmonyShell } = vi.hoisted(() => ({
  runHarmonyHdc: vi.fn(),
  runHarmonyShell: vi.fn(),
}));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc, runHarmonyShell }));

import { harmonyKeyboardBandFromWindowDump, readHarmonyKeyboardBand } from '../keyboard-band.ts';
import { snapshotHarmony } from '../snapshot.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

const WINDOW_TABLE_HEADER = [
  '-------------------------------[ability]-------------------------------',
  '----------------------------------WindowManagerService----------------------------------',
  '-------------------------------------ScreenGroup 0-------------------------------------',
  'WindowName           DisplayId Pid     WinId Type Mode Flag ZOrd Orientation [ x    y    w    h    ] [ OffsetX OffsetY ] [ ScaleX  ScaleY  PivotX  PivotY  ]',
  'SCBScenePanel12      0         5714    4     2109 1    0    100  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  'app-under-test0      0         8131    38    1    1    0    101  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  '---------------------------------------------------------------------------------------',
  'SCBStatusBar17       0         5714    23    2108 1    0    -1   0           [ 0    0    1080 108  ] [ 0       0       ] [ 1       1       0       0       ]',
].join('\n');

/** The measured hidden keyboard panel: the zero rect, not mere presence, says "hidden". */
const HIDDEN_KEYBOARD_TABLE = [
  ...WINDOW_TABLE_HEADER.split('\n'),
  'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    0    0    0    ] [ 0       0       ] [ 1       1       0       0       ]',
].join('\n');

/**
 * The real JUY-AL50 7.0.0.111 rows, captured verbatim from
 * `hidumper -s WindowManagerService -a -a` with the Settings search field focused and the IME
 * raised, then after a Back dismissal. The panel and the IME's own `softKeyboard1` window both
 * hold the full display rect in both states; only the z-order column moves (102/103 up,
 * both -1 hidden). No column in the public table carries the key plane.
 */
const REAL_KEYBOARD_UP_ROWS = [
  'softKeyboard1        0         6100    16    2105 102  0    103  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  'SCBKeyboardPanel     0         5714    17    2134 1    0    102  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
].join('\n');
const REAL_KEYBOARD_HIDDEN_ROWS = [
  'softKeyboard1        0         6100    16    2105 102  0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
].join('\n');

/** A panel rect materially smaller than the display: the shape a true key-plane report would take. */
const TRUE_BAND_KEYBOARD_ROW =
  'SCBKeyboardPanel     0         5714    17    2134 1    0    102  0           [ 0    1546    1080    860    ] [ 0       0       ] [ 1       1       0.5     0.5     ]';

beforeEach(() => {
  runHarmonyHdc.mockReset();
  runHarmonyShell.mockReset();
  runHarmonyShell.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('a zero-rect keyboard panel reads as hidden, not as a band', () => {
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(HIDDEN_KEYBOARD_TABLE), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('a zero rect on a positively ordered window still reads as hidden', () => {
  const zeroRectShownRow =
    'SCBKeyboardPanel     0         5714    17    2134 1    0    4400 0           [ 0    0    0    0    ] [ 0       0       ] [ 1       1       0       0       ]';
  const dump = `${WINDOW_TABLE_HEADER}\n${zeroRectShownRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('the real display-spanning up-state rows publish visibility-only, not a full-screen band', () => {
  const dump = `${WINDOW_TABLE_HEADER}\n${REAL_KEYBOARD_UP_ROWS}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: true,
  });
});

test('the real hidden-state rows publish visibility-only false', () => {
  const dump = `${WINDOW_TABLE_HEADER}\n${REAL_KEYBOARD_HIDDEN_ROWS}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('a panel rect materially smaller than the display publishes the band frame', () => {
  const dump = `${WINDOW_TABLE_HEADER}\n${TRUE_BAND_KEYBOARD_ROW}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visible',
    frame: { x: 0, y: 1546, width: 1080, height: 860 },
  });
});

test('a keyboard-only table with no display-sized row stays visibility-only', () => {
  // The panel's own rect is the only positive rect, so the display cannot be derived and a
  // frame must not be published from it: the band would be an unproven guess.
  const dump = [
    'WindowName           DisplayId Pid     WinId Type Mode Flag ZOrd Orientation [ x    y    w    h    ] [ OffsetX OffsetY ] [ ScaleX  ScaleY  PivotX  PivotY  ]',
    TRUE_BAND_KEYBOARD_ROW,
  ].join('\n');
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: true,
  });
});

test('a positive rect on a negatively ordered window stays hidden', () => {
  const staleRectRow =
    'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    1546    1080    860    ] [ 0       0       ] [ 1       1       0       0       ]';
  const dump = `${WINDOW_TABLE_HEADER}\n${staleRectRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('a table without the keyboard panel answers unmeasurable, not hidden', () => {
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(WINDOW_TABLE_HEADER), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-not-listed',
  });
});

test('a panel row without a readable rect answers unmeasurable', () => {
  const rectlessRow = 'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0';
  const dump = `${WINDOW_TABLE_HEADER}\n${rectlessRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-rect-unparseable',
  });
});

test('a failed window probe answers unmeasurable and never throws', async () => {
  runHarmonyShell.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'dump failed' });
  assert.deepEqual(await readHarmonyKeyboardBand(DEVICE), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-probe-failed',
  });

  runHarmonyShell.mockRejectedValue(new Error('hdc disconnected'));
  assert.deepEqual(await readHarmonyKeyboardBand(DEVICE), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-probe-failed',
  });
});

test('readHarmonyKeyboardBand dumps the window manager table', async () => {
  runHarmonyShell.mockImplementation(async (_device: unknown, words: string[]) => {
    if (words[0] === 'hidumper') {
      return { exitCode: 0, stdout: HIDDEN_KEYBOARD_TABLE, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await readHarmonyKeyboardBand(DEVICE);

  const hidumperCall = runHarmonyShell.mock.calls.find(
    (call) => (call[1] as string[])[0] === 'hidumper',
  );
  assert.deepEqual(hidumperCall?.[1], ['hidumper', '-s', 'WindowManagerService', '-a', '-a']);
});

test('snapshotHarmony carries the keyboard band beside its tree', async () => {
  runHarmonyShell.mockImplementation(async (_device: unknown, words: string[]) => {
    if (words[0] === 'hidumper') {
      return {
        exitCode: 0,
        stdout: `${WINDOW_TABLE_HEADER}\n${REAL_KEYBOARD_UP_ROWS}`,
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  runHarmonyHdc.mockImplementation(async (_device: unknown, args: string[]) => {
    if (args[0] === 'file' && args[1] === 'recv') {
      fs.writeFileSync(
        args[3] as string,
        JSON.stringify({
          attributes: { type: 'root', bounds: '[0,0][1080,2406]' },
          children: [{ attributes: { type: 'Button', text: 'first', clickable: 'true' } }],
        }),
        'utf8',
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const snapshot = await snapshotHarmony(DEVICE);

  assert.deepEqual(snapshot.keyboard, {
    kind: 'visibility-only',
    visible: true,
  });
  assert.deepEqual(
    snapshot.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
});
