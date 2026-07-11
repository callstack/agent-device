import { ensureInputTool } from './linux-env.ts';
import { resolveLinuxToolProvider, type LinuxPointerButton } from './tool-provider.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { ScrollDirection } from '../../contracts/scroll-gesture.ts';

// ── Low-level wrappers ─────────────────────────────────────────────────

/** Per-action timeout — prevents hung xdotool/ydotool from blocking indefinitely. */
const INPUT_TIMEOUT_MS = 10_000;

async function xdotool(...args: string[]): Promise<void> {
  await resolveLinuxToolProvider().runCommand('xdotool', args, {
    allowFailure: false,
    timeoutMs: INPUT_TIMEOUT_MS,
  });
}

async function ydotool(...args: string[]): Promise<void> {
  await resolveLinuxToolProvider().runCommand('ydotool', args, {
    allowFailure: false,
    timeoutMs: INPUT_TIMEOUT_MS,
  });
}

function resolveLinuxInputProvider() {
  return resolveLinuxToolProvider().input;
}

/** Move the pointer to (x, y) using the detected input tool. */
async function moveTo(x: number, y: number): Promise<void> {
  const { tool } = await ensureInputTool();
  if (tool === 'xdotool') {
    await xdotool('mousemove', '--sync', String(x), String(y));
  } else {
    await ydotool('mousemove', '--absolute', '-x', String(x), '-y', String(y));
  }
}

/**
 * Send a key combination via the detected input tool.
 * Both `combo` (xdotool keysym notation) and `scancodes` (ydotool
 * key:state pairs) must be provided — ydotool requires scancodes.
 */
export async function sendKey(combo: string, scancodes: string[]): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.key(combo, scancodes);
    return;
  }

  const { tool } = await ensureInputTool();
  if (tool === 'xdotool') {
    await xdotool('key', '--clearmodifiers', combo);
  } else {
    await ydotool('key', ...scancodes);
  }
}

// ── Mouse actions ───────────────────────────────────────────────────────

// ydotool v1 button codes (Linux input event codes):
//   0xC0 = BTN_LEFT with click flags, 0xC1 = BTN_RIGHT, 0xC2 = BTN_MIDDLE
// These correspond to ydotool's packed button+action format.

async function clickButton(x: number, y: number, xdoBtn: string, ydoCode: string): Promise<void> {
  await moveTo(x, y);
  const { tool } = await ensureInputTool();
  if (tool === 'xdotool') {
    await xdotool('click', xdoBtn);
  } else {
    await ydotool('click', ydoCode);
  }
}

async function clickLinuxButton(
  x: number,
  y: number,
  button: LinuxPointerButton,
  xdoBtn: string,
  ydoCode: string,
): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.click(x, y, button);
    return;
  }

  await clickButton(x, y, xdoBtn, ydoCode);
}

export async function pressLinux(x: number, y: number): Promise<void> {
  await clickLinuxButton(x, y, 'primary', '1', '0xC0');
}

export async function rightClickLinux(x: number, y: number): Promise<void> {
  await clickLinuxButton(x, y, 'secondary', '3', '0xC1');
}

export async function middleClickLinux(x: number, y: number): Promise<void> {
  await clickLinuxButton(x, y, 'middle', '2', '0xC2');
}

export async function doubleClickLinux(x: number, y: number): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.doubleClick(x, y);
    return;
  }

  const { tool } = await ensureInputTool();
  await moveTo(x, y);
  if (tool === 'xdotool') {
    await xdotool('click', '--repeat', '2', '1');
  } else {
    await ydotool('click', '0xC0');
    await ydotool('click', '0xC0');
  }
}

export async function longPressLinux(x: number, y: number, durationMs = 800): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.longPress(x, y, durationMs);
    return;
  }

  const { tool } = await ensureInputTool();
  await moveTo(x, y);
  if (tool === 'xdotool') {
    await xdotool('mousedown', '1');
    await sleep(durationMs);
    await xdotool('mouseup', '1');
  } else {
    // ydotool v1: use click --down / --up for press-hold
    await ydotool('click', '--down', '0xC0');
    await sleep(durationMs);
    await ydotool('click', '--up', '0xC0');
  }
}

export async function focusLinux(x: number, y: number): Promise<void> {
  await pressLinux(x, y);
}

// ── Swipe / scroll ──────────────────────────────────────────────────────

export async function swipeLinux(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300,
): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.drag(x1, y1, x2, y2, durationMs);
    return;
  }

  const { tool } = await ensureInputTool();
  await moveTo(x1, y1);
  if (tool === 'xdotool') {
    await xdotool('mousedown', '1');
    await xdotool('mousemove', '--sync', String(x2), String(y2));
    await sleep(durationMs);
    await xdotool('mouseup', '1');
  } else {
    // ydotool v1: use click --down / --up for drag
    await ydotool('click', '--down', '0xC0');
    await ydotool('mousemove', '--absolute', '-x', String(x2), '-y', String(y2));
    await sleep(durationMs);
    await ydotool('click', '--up', '0xC0');
  }
}

const DEFAULT_SCROLL_CLICKS = 5;

export async function scrollLinux(
  direction: ScrollDirection,
  options?: { amount?: number; pixels?: number; durationMs?: number },
): Promise<Record<string, unknown>> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.scroll(direction, options);
    return scrollDurationResult(options);
  }

  const { tool } = await ensureInputTool();

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
    // amount is a fraction (0–1+) of the viewport; scale relative to default
    scrollCount = Math.max(1, Math.round(DEFAULT_SCROLL_CLICKS * (options.amount / 0.6)));
  }

  // xdotool: button 4=up, 5=down, 6=left, 7=right
  if (tool === 'xdotool') {
    const button =
      direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
    await runPacedScrollSteps(scrollCount, options?.durationMs, async (stepCount) => {
      await xdotool('click', '--repeat', String(stepCount), button);
    });
  } else {
    // ydotool: wheel events use positive/negative values
    if (direction === 'up' || direction === 'down') {
      await runPacedScrollSteps(scrollCount, options?.durationMs, async (stepCount) => {
        const stepValue = direction === 'up' ? String(-stepCount) : String(stepCount);
        await ydotool('mousemove', '--wheel', '-y', stepValue);
      });
    } else {
      await runPacedScrollSteps(scrollCount, options?.durationMs, async (stepCount) => {
        const stepValue = direction === 'left' ? String(-stepCount) : String(stepCount);
        await ydotool('mousemove', '--wheel', '-x', stepValue);
      });
    }
  }
  return scrollDurationResult(options);
}

async function runPacedScrollSteps(
  totalCount: number,
  durationMs: number | undefined,
  runStep: (stepCount: number) => Promise<void>,
): Promise<void> {
  if (durationMs === undefined || durationMs <= 0 || totalCount <= 1) {
    await runStep(totalCount);
    return;
  }

  const intervalMs = durationMs / Math.max(1, totalCount - 1);
  for (let index = 0; index < totalCount; index += 1) {
    await runStep(1);
    if (index < totalCount - 1) await sleep(intervalMs);
  }
}

function scrollDurationResult(
  options: { durationMs?: number } | undefined,
): Record<string, unknown> {
  return options?.durationMs !== undefined ? { durationMs: options.durationMs } : {};
}

// ── Keyboard actions ────────────────────────────────────────────────────

export async function typeLinux(text: string, delayMs = 0): Promise<void> {
  const provider = resolveLinuxInputProvider();
  if (provider) {
    await provider.typeText(text, { delayMs });
    return;
  }

  const { tool } = await ensureInputTool();
  if (tool === 'xdotool') {
    const args = ['type'];
    if (delayMs > 0) args.push('--delay', String(delayMs));
    args.push('--clearmodifiers', '--', text);
    await xdotool(...args);
  } else {
    await ydotool('type', '--', text);
  }
}

export async function fillLinux(x: number, y: number, text: string, delayMs = 0): Promise<void> {
  // Click to focus the field
  await pressLinux(x, y);
  await sleep(100);
  // Select all existing text (Ctrl+A scancodes: Ctrl=29, A=30)
  await sendKey('ctrl+a', ['29:1', '30:1', '30:0', '29:0']);
  await sleep(50);
  // Type replacement text
  await typeLinux(text, delayMs);
}
