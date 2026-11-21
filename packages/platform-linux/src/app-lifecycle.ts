import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import { sendKey } from './input-actions.ts';

/**
 * Open an application or URL on Linux.
 *
 * Accepts:
 * - A URL (opens via xdg-open)
 * - A .desktop file name or binary name
 */
export async function openLinuxApp(provider: LinuxToolProvider, app: string): Promise<void> {
  await provider.desktop.openTarget(app);
}

/**
 * Close an application by name on Linux.
 *
 * Uses wmctrl if available, falls back to pkill.
 */
export async function closeLinuxApp(provider: LinuxToolProvider, app: string): Promise<void> {
  await provider.desktop.closeApp(app);
}

/**
 * Send Alt+Left arrow to go back (standard browser/app back navigation).
 */
export async function backLinux(provider: LinuxToolProvider): Promise<void> {
  // Alt=56, Left=105
  await sendKey(provider, 'alt+Left', ['56:1', '105:1', '105:0', '56:0']);
}

/**
 * Show desktop (minimize all windows) via Super+D.
 */
export async function homeLinux(provider: LinuxToolProvider): Promise<void> {
  // Super=125, D=32
  await sendKey(provider, 'super+d', ['125:1', '32:1', '32:0', '125:0']);
}
