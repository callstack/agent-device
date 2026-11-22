import type { MacOsLeafOperations } from '@agent-device/contracts/macos-platform-leaf';

/**
 * The macOS operations of the installed leaf, bound to the Apple tools of the calling request. The
 * binding loads with the first macOS call, so importing this façade evaluates no Apple mechanics.
 */
export async function macOsDesktop(): Promise<MacOsLeafOperations> {
  const { macOsDesktop: bind } = await import('./core/macos-desktop.ts');
  return bind();
}
