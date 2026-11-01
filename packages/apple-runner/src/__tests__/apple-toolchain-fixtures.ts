import { beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { XCODE_SELECT_LINK_PATH } from '../runner-toolchain-identity.ts';

const DEFAULT_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

export {
  STUBBED_APPLE_TOOLCHAIN,
  stubbedAppleDeveloperDir,
  writeXcodeFixture,
} from '@agent-device/test-kit';

/**
 * The host's selection link and default Xcode as the toolchain identity sees them. Undefined keeps
 * a path absent; a case that owns one points it at a path it created.
 */
export const appleSelectionLink: {
  target: string | undefined;
  defaultDeveloperDir: string | undefined;
} = { target: undefined, defaultDeveloperDir: undefined };

/**
 * Hides the selection link and default Xcode of the machine running the suite, so a case decides the
 * host's selection rather than inheriting it.
 */
export function stubAppleSelectionLink(): void {
  const realRealpathSync = fs.realpathSync;
  const realReadlinkSync = fs.readlinkSync;
  const absent = () =>
    Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  beforeEach(() => {
    appleSelectionLink.target = undefined;
    appleSelectionLink.defaultDeveloperDir = undefined;
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realReadlinkSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      return appleSelectionLink.target;
    }) as typeof fs.readlinkSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target) === DEFAULT_DEVELOPER_DIR) {
        if (appleSelectionLink.defaultDeveloperDir === undefined) throw absent();
        return realRealpathSync(appleSelectionLink.defaultDeveloperDir);
      }
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realRealpathSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      return realRealpathSync(appleSelectionLink.target);
    });
  });
}
