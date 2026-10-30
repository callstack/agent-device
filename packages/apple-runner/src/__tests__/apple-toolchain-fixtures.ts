import { beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { XCODE_SELECT_LINK_PATH } from '../runner-toolchain-identity.ts';

export {
  STUBBED_APPLE_TOOLCHAIN,
  stubbedAppleDeveloperDir,
  writeXcodeFixture,
} from '@agent-device/test-kit';

/**
 * The host's default selection link as the toolchain identity sees it. Undefined keeps the link
 * unreadable; a case that owns a link points it at a path it created.
 */
export const appleSelectionLink: { target: string | undefined } = { target: undefined };

/**
 * Hides the selection link of the machine running the suite, so a case decides the host's selection
 * rather than inheriting it.
 */
export function stubAppleSelectionLink(): void {
  const realRealpathSync = fs.realpathSync;
  const realReadlinkSync = fs.readlinkSync;
  const absent = () =>
    Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  beforeEach(() => {
    appleSelectionLink.target = undefined;
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realReadlinkSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      return appleSelectionLink.target;
    }) as typeof fs.readlinkSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realRealpathSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      return realRealpathSync(appleSelectionLink.target);
    });
  });
}
