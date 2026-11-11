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
  'SCBStatusBar17       0         5714    23    2108 1    0    -1  0           [ 0    0    1080 108  ] [ 0       0       ] [ 1       1       0       0       ]',
].join('\n');

/**
 * The real JUY-AL50 7.0.0.111 rows, captured verbatim from
 * `hidumper -s WindowManagerService -a -a` with the Settings search field focused and the IME
 * raised, then after a Back dismissal. The panel and the IME's own `softKeyboard1` window both
 * hold the full display rect in both states; only the z-order column moves (102/103 up,
 * both -1 hidden). No column in the public table carries the key plane — the producer reads
 * z-order only and publishes visibility, never a frame.
 */
const REAL_KEYBOARD_UP_ROWS = [
  'softKeyboard1        0         6100    16    2105 102  0    103  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  'SCBKeyboardPanel     0         5714    17    2134 1    0    102  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
].join('\n');
const REAL_KEYBOARD_HIDDEN_ROWS = [
  'softKeyboard1        0         6100    16    2105 102  0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
  'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]',
].join('\n');

/** A panel rect materially smaller than the display: what a true key-plane report would look like. */
const PARTIAL_RECT_SHOWN_ROW =
  'SCBKeyboardPanel     0         5714    17    2134 1    0    102  0           [ 0    1546    1080    860    ] [ 0       0       ] [ 1       1       0.5     0.5     ]';

beforeEach(() => {
  runHarmonyHdc.mockReset();
  runHarmonyShell.mockReset();
  runHarmonyShell.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('the real display-spanning up-state rows publish visibility-only true, never a band frame', () => {
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

test('a partial panel rect would still publish visibility-only, never a band frame', () => {
  // The future-build risk from review: a partial container must not become the key plane.
  // The producer never reads the rect column, so no rect shape can publish a frame.
  const dump = `${WINDOW_TABLE_HEADER}\n${PARTIAL_RECT_SHOWN_ROW}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: true,
  });
});

test('a negatively ordered panel row stays hidden whatever its rect claims', () => {
  // A stale band-shaped rect on a hidden panel must not read as shown: z-order is the only
  // visibility signal.
  const staleRectRow =
    'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    1546    1080    860    ] [ 0       0       ] [ 1       1       0       0       ]';
  const dump = `${WINDOW_TABLE_HEADER}\n${staleRectRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('a zero-rect hidden panel row reads as hidden', () => {
  // The rect column is never read; this row class (some builds hide via zero rect) still
  // resolves through its -1 z-order.
  const hiddenZeroRectRow =
    'SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    0    0    0    ] [ 0       0       ] [ 1       1       0       0       ]';
  const dump = `${WINDOW_TABLE_HEADER}\n${hiddenZeroRectRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: false,
  });
});

test('a table whose panel is the only window row still publishes visibility-only', () => {
  // No display-sized row to compare against — irrelevant now: nothing is derived from the
  // table's other rows, so a bare panel table answers through its own z-order.
  const dump = [
    'WindowName           DisplayId Pid     WinId Type Mode Flag ZOrd Orientation [ x    y    w    h    ] [ OffsetX OffsetY ] [ ScaleX  ScaleY  PivotX  PivotY  ]',
    PARTIAL_RECT_SHOWN_ROW,
  ].join('\n');
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: true,
  });
});

test('conflicting panel rows across displays answer unmeasurable, not a guess', () => {
  // A multi-display table lists one panel per display and the probe has no display scope, so
  // disagreeing z-orders must not pick a winner — the guard's fail-open verdict stands.
  const foreignShownRow =
    'SCBKeyboardPanel     2         5714    17    2134 1    0    500  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]';
  const dump = `${WINDOW_TABLE_HEADER}\n${REAL_KEYBOARD_HIDDEN_ROWS}\n${foreignShownRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-zorder-conflict',
  });
});

test('a table without the keyboard panel answers unmeasurable, not hidden', () => {
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(WINDOW_TABLE_HEADER), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-not-listed',
  });
});

test('a panel row without a readable z-order answers unmeasurable', () => {
  // With the rect column never read, an unreadable z-order means the probe measured nothing.
  // (A row lacking only the rect still reads through its z-order — that column is not used.)
  const truncatedRow = 'SCBKeyboardPanel     0         5714    17    2134 1    0';
  const dump = `${WINDOW_TABLE_HEADER}\n${truncatedRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'unmeasurable',
    reason: 'keyboard-window-zorder-unreadable',
  });
});

test('a rect-less panel row still reads through its z-order', () => {
  // The rect column is never read, so a row that ends before the rect group still measures
  // visibility from its eighth token; the truncated row above fails only because its eighth
  // token is missing, not because the rect is.
  const rectlessShownRow = 'SCBKeyboardPanel     0         5714    17    2134 1    0    102  0';
  const dump = `${WINDOW_TABLE_HEADER}\n${rectlessShownRow}`;
  assert.deepEqual(harmonyKeyboardBandFromWindowDump(dump), {
    kind: 'visibility-only',
    visible: true,
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
      return { exitCode: 0, stdout: REAL_KEYBOARD_HIDDEN_ROWS, stderr: '' };
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
