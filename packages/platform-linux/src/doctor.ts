import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import { linuxToolSlotCommands } from './tool-provider.ts';

/**
 * The toolchain row `doctor --platform linux` reports. The plugin answers it over the host command
 * route it was set up with, so the versions it reads are the ones the family would spawn, and nothing
 * is probed through the bundle's own copy of the host kit.
 *
 * Linux has no single toolchain to name — the family needs an input synthesizer, a clipboard tool, a
 * screenshot tool and the AT-SPI helper — so the row reports the tools it found and names the ones a
 * desktop session would be missing.
 */
export async function linuxToolchainCheck(provider: LinuxToolProvider): Promise<DoctorCheck> {
  const display = provider.display.detectDisplayServer();
  const found: string[] = [];
  const missing: string[] = [];
  for (const slot of requiredLinuxToolSlots(display)) {
    let present: string | undefined;
    for (const tool of slot) {
      if (await provider.whichCommand(tool)) {
        present = tool;
        break;
      }
    }
    if (present) found.push(present);
    else missing.push(slot.join(' or '));
  }
  const evidence = {
    display,
    tools: found,
    missingTools: missing,
  };
  if (missing.length > 0) {
    return {
      id: 'toolchain',
      status: missing.includes(inputToolFor(display)) ? 'fail' : 'warn',
      summary: `Linux desktop tools: missing ${missing.join(', ')}.`,
      hint: linuxInstallHint(display),
      command: `${inputToolFor(display)} --version`,
      evidence,
    };
  }
  return {
    id: 'toolchain',
    status: 'pass',
    summary: `Linux desktop tools: ${display} session with ${found.join(', ')}.`,
    command: `${inputToolFor(display)} --version`,
    evidence,
  };
}

function inputToolFor(display: 'wayland' | 'x11'): string {
  return display === 'wayland' ? 'ydotool' : 'xdotool';
}

/** One entry per slot the family needs; a slot is satisfied by any of its commands. */
function requiredLinuxToolSlots(display: 'wayland' | 'x11'): readonly (readonly string[])[] {
  const { clipboard, screenshot } = linuxToolSlotCommands(display);
  return [[inputToolFor(display)], clipboard, screenshot, ['python3']];
}

function linuxInstallHint(display: 'wayland' | 'x11'): string {
  return display === 'wayland'
    ? 'Install ydotool, wl-clipboard, grim and python3-gi with your distribution package manager.'
    : 'Install xdotool, xclip, scrot (or ImageMagick) and python3-gi with your distribution package manager.';
}
