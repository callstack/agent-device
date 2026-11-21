import { discloseDispatchAfterSteps } from '@agent-device/kernel/errors';
import type {
  LinuxInputProvider,
  LinuxToolProvider,
} from '@agent-device/contracts/linux-tool-provider';
import {
  DEFAULT_SCROLL_AMOUNT,
  type ScrollDirection,
} from '@agent-device/contracts/scroll-gesture';
import { ensureInputTool } from './linux-env.ts';

// ── Low-level wrappers ─────────────────────────────────────────────────

/** Per-action timeout — prevents hung xdotool/ydotool from blocking indefinitely. */
const INPUT_TIMEOUT_MS = 10_000;

async function xdotool(provider: LinuxToolProvider, ...args: string[]): Promise<void> {
  await provider.runCommand('xdotool', args, { allowFailure: false, timeoutMs: INPUT_TIMEOUT_MS });
}

async function ydotool(provider: LinuxToolProvider, ...args: string[]): Promise<void> {
  await provider.runCommand('ydotool', args, { allowFailure: false, timeoutMs: INPUT_TIMEOUT_MS });
}

/**
 * Move the pointer to (x, y) using the detected input tool.
 *
 * The no-op guard is load-bearing: `xdotool mousemove --sync` waits for a pointer-motion event,
 * and a move to the point the pointer already occupies emits none — the call hangs until the
 * action timeout kills it. Observed on the CI Smoke lane (#1935): a failed replay attempt parks
 * the pointer on its last coordinate action, and every retry of that action then dies in this
 * hang, reporting the retry's first coordinate step instead of the attempt's real failure.
 */
async function moveTo(provider: LinuxToolProvider, x: number, y: number): Promise<void> {
  const { tool } = await ensureInputTool(provider);
  if (tool === 'xdotool') {
    if (await pointerAlreadyAt(provider, x, y)) return;
    await xdotool(provider, 'mousemove', '--sync', String(x), String(y));
  } else {
    await ydotool(provider, 'mousemove', '--absolute', '-x', String(x), '-y', String(y));
  }
}

/** True when the X pointer already sits exactly on (x, y); a failed probe never blocks the move. */
async function pointerAlreadyAt(
  provider: LinuxToolProvider,
  x: number,
  y: number,
): Promise<boolean> {
  try {
    const result = await provider.runCommand('xdotool', ['getmouselocation', '--shell'], {
      allowFailure: true,
      timeoutMs: INPUT_TIMEOUT_MS,
    });
    const location = new Map(
      result.stdout
        .split('\n')
        .map((line) => line.trim().split('='))
        .filter((pair): pair is [string, string] => pair.length === 2)
        .map(([key, value]) => [key, Number(value)] as const),
    );
    return location.get('X') === Math.round(x) && location.get('Y') === Math.round(y);
  } catch {
    return false;
  }
}

/**
 * Send a key combination via the detected input tool.
 * Both `combo` (xdotool keysym notation) and `scancodes` (ydotool
 * key:state pairs) must be provided — ydotool requires scancodes.
 */
export async function sendKey(
  provider: LinuxToolProvider,
  combo: string,
  scancodes: string[],
): Promise<void> {
  const input: LinuxInputProvider | undefined = provider.input;
  if (input) {
    await input.key(combo, scancodes);
    return;
  }

  const { tool } = await ensureInputTool(provider);
  if (tool === 'xdotool') {
    await xdotool(provider, 'key', '--clearmodifiers', combo);
  } else {
    await ydotool(provider, 'key', ...scancodes);
  }
}

// ── Mouse actions ───────────────────────────────────────────────────────

// ydotool v1 button codes (Linux input event codes):
//   0xC0 = BTN_LEFT with click flags, 0xC1 = BTN_RIGHT, 0xC2 = BTN_MIDDLE
// These correspond to ydotool's packed button+action format.

async function clickButton(
  provider: LinuxToolProvider,
  x: number,
  y: number,
  xdoBtn: string,
  ydoCode: string,
): Promise<void> {
  await moveTo(provider, x, y);
  const { tool } = await ensureInputTool(provider);
  if (tool === 'xdotool') {
    await xdotool(provider, 'click', xdoBtn);
  } else {
    await ydotool(provider, 'click', ydoCode);
  }
}

async function clickLinuxButton(
  provider: LinuxToolProvider,
  x: number,
  y: number,
  button: 'primary' | 'secondary' | 'middle',
  xdoBtn: string,
  ydoCode: string,
): Promise<void> {
  if (provider.input) {
    await provider.input.click(x, y, button);
    return;
  }

  await clickButton(provider, x, y, xdoBtn, ydoCode);
}

export async function pressLinux(provider: LinuxToolProvider, x: number, y: number): Promise<void> {
  await clickLinuxButton(provider, x, y, 'primary', '1', '0xC0');
}

export async function rightClickLinux(
  provider: LinuxToolProvider,
  x: number,
  y: number,
): Promise<void> {
  await clickLinuxButton(provider, x, y, 'secondary', '3', '0xC1');
}

export async function middleClickLinux(
  provider: LinuxToolProvider,
  x: number,
  y: number,
): Promise<void> {
  await clickLinuxButton(provider, x, y, 'middle', '2', '0xC2');
}

export async function doubleClickLinux(
  provider: LinuxToolProvider,
  x: number,
  y: number,
): Promise<void> {
  if (provider.input) {
    await provider.input.doubleClick(x, y);
    return;
  }

  const { tool } = await ensureInputTool(provider);
  await moveTo(provider, x, y);
  if (tool === 'xdotool') {
    await xdotool(provider, 'click', '--repeat', '2', '1');
  } else {
    await ydotool(provider, 'click', '0xC0');
    await ydotool(provider, 'click', '0xC0');
  }
}

export async function longPressLinux(
  provider: LinuxToolProvider,
  x: number,
  y: number,
  durationMs = 800,
): Promise<void> {
  if (provider.input) {
    await provider.input.longPress(x, y, durationMs);
    return;
  }

  const { tool } = await ensureInputTool(provider);
  await moveTo(provider, x, y);
  if (tool === 'xdotool') {
    await xdotool(provider, 'mousedown', '1');
    await provider.sleep(durationMs);
    await xdotool(provider, 'mouseup', '1');
  } else {
    // ydotool v1: use click --down / --up for press-hold
    await ydotool(provider, 'click', '--down', '0xC0');
    await provider.sleep(durationMs);
    await ydotool(provider, 'click', '--up', '0xC0');
  }
}

export async function focusLinux(provider: LinuxToolProvider, x: number, y: number): Promise<void> {
  await pressLinux(provider, x, y);
}

// ── Swipe / scroll ──────────────────────────────────────────────────────

export async function swipeLinux(
  provider: LinuxToolProvider,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300,
): Promise<void> {
  if (provider.input) {
    await provider.input.drag(x1, y1, x2, y2, durationMs);
    return;
  }

  const { tool } = await ensureInputTool(provider);
  await moveTo(provider, x1, y1);
  if (tool === 'xdotool') {
    await xdotool(provider, 'mousedown', '1');
    await xdotool(provider, 'mousemove', '--sync', String(x2), String(y2));
    await provider.sleep(durationMs);
    await xdotool(provider, 'mouseup', '1');
  } else {
    // ydotool v1: use click --down / --up for drag
    await ydotool(provider, 'click', '--down', '0xC0');
    await ydotool(provider, 'mousemove', '--absolute', '-x', String(x2), '-y', String(y2));
    await provider.sleep(durationMs);
    await ydotool(provider, 'click', '--up', '0xC0');
  }
}

const DEFAULT_SCROLL_CLICKS = 5;

export async function scrollLinux(
  provider: LinuxToolProvider,
  direction: ScrollDirection,
  options?: { amount?: number; pixels?: number; durationMs?: number },
): Promise<Record<string, unknown>> {
  if (provider.input) {
    await provider.input.scroll(direction, options);
    return scrollDurationResult(options);
  }

  const { tool } = await ensureInputTool(provider);

  // Translate amount/pixels into a discrete click count.
  // xdotool button clicks scroll ~15px each (3 lines × 5px).
  // ydotool wheel units are ~40px each.
  let scrollCount = DEFAULT_SCROLL_CLICKS;
  if (options?.pixels != null) {
    scrollCount =
      tool === 'xdotool'
        ? Math.max(1, Math.round(options.pixels / 15))
        : Math.max(1, Math.round(options.pixels / 40));
  } else if (options?.amount != null) {
    // amount is a fraction (0–1+) of the viewport; scale relative to the shared default
    scrollCount = Math.max(
      1,
      Math.round(DEFAULT_SCROLL_CLICKS * (options.amount / DEFAULT_SCROLL_AMOUNT)),
    );
  }

  // xdotool: button 4=up, 5=down, 6=left, 7=right
  if (tool === 'xdotool') {
    const button =
      direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
    await runPacedScrollSteps(provider, scrollCount, options?.durationMs, async (stepCount) => {
      await xdotool(provider, 'click', '--repeat', String(stepCount), button);
    });
  } else {
    // ydotool: wheel events use positive/negative values
    if (direction === 'up' || direction === 'down') {
      await runPacedScrollSteps(provider, scrollCount, options?.durationMs, async (stepCount) => {
        const stepValue = direction === 'up' ? String(-stepCount) : String(stepCount);
        await ydotool(provider, 'mousemove', '--wheel', '-y', stepValue);
      });
    } else {
      await runPacedScrollSteps(provider, scrollCount, options?.durationMs, async (stepCount) => {
        const stepValue = direction === 'left' ? String(-stepCount) : String(stepCount);
        await ydotool(provider, 'mousemove', '--wheel', '-x', stepValue);
      });
    }
  }
  return scrollDurationResult(options);
}

async function runPacedScrollSteps(
  provider: LinuxToolProvider,
  totalCount: number,
  durationMs: number | undefined,
  runStep: (stepCount: number) => Promise<void>,
): Promise<void> {
  if (durationMs === undefined || durationMs <= 0 || totalCount <= 1) {
    await runStep(totalCount);
    return;
  }

  const intervalMs = durationMs / Math.max(1, totalCount - 1);
  let dispatchedSteps = 0;
  try {
    for (let index = 0; index < totalCount; index += 1) {
      await runStep(1);
      dispatchedSteps += 1;
      if (index < totalCount - 1) await provider.sleep(intervalMs);
    }
  } catch (error) {
    throw discloseDispatchAfterSteps(error, dispatchedSteps);
  }
}

function scrollDurationResult(
  options: { durationMs?: number } | undefined,
): Record<string, unknown> {
  return options?.durationMs !== undefined ? { durationMs: options.durationMs } : {};
}

// ── Keyboard actions ────────────────────────────────────────────────────

export async function typeLinux(
  provider: LinuxToolProvider,
  text: string,
  delayMs = 0,
): Promise<void> {
  if (provider.input) {
    await provider.input.typeText(text, { delayMs });
    return;
  }

  const { tool } = await ensureInputTool(provider);
  if (tool === 'xdotool') {
    const args = ['type'];
    if (delayMs > 0) args.push('--delay', String(delayMs));
    args.push('--clearmodifiers', '--', text);
    await xdotool(provider, ...args);
  } else {
    await ydotool(provider, 'type', '--', text);
  }
}

export async function fillLinux(
  provider: LinuxToolProvider,
  x: number,
  y: number,
  text: string,
  delayMs = 0,
): Promise<void> {
  // Click to focus the field
  await pressLinux(provider, x, y);
  await provider.sleep(100);
  // Select all existing text (Ctrl+A scancodes: Ctrl=29, A=30)
  await sendKey(provider, 'ctrl+a', ['29:1', '30:1', '30:0', '29:0']);
  await provider.sleep(50);
  if (text.length === 0) {
    // The clear-field request (#2063): typing zero characters over the selection would leave
    // the old value selected but intact, so delete the selection instead (BackSpace=14).
    await sendKey(provider, 'BackSpace', ['14:1', '14:0']);
    return;
  }
  // Type replacement text
  await typeLinux(provider, text, delayMs);
}
