import { beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DEVELOPER_DIR, XCODE_SELECT_LINK_PATH } from '../runner-toolchain-identity.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

export {
  STUBBED_APPLE_TOOLCHAIN,
  stubbedAppleDeveloperDir,
  writeXcodeFixture,
} from '@agent-device/test-kit';

/**
 * The host's selection link and default Xcode as the toolchain identity sees them. Undefined keeps
 * a path absent; a case that owns one points it at a path it created. `targetErrorCode` makes the
 * link's target fail to resolve with that code.
 */
export const appleSelectionLink: {
  target: string | undefined;
  targetErrorCode: string | undefined;
  defaultDeveloperDir: string | undefined;
} = { target: undefined, targetErrorCode: undefined, defaultDeveloperDir: undefined };

/**
 * Hides the selection link and default Xcode of the machine running the suite, so a case decides the
 * host's selection rather than inheriting it.
 */
export function stubAppleSelectionLink(): void {
  const realRealpathSync = fs.realpathSync;
  const realReadlinkSync = fs.readlinkSync;
  const failure = (code: string) => Object.assign(new Error(code), { code });
  const absent = () => failure('ENOENT');
  beforeEach(() => {
    // The host's own default Xcode stays out of reach: an absent default resolves to a path that
    // does not exist, so every read under it fails.
    const missingDefaultDeveloperDir = path.join(
      mkdtempForTestSync('no-default-xcode-'),
      'Xcode.app/Contents/Developer',
    );
    appleSelectionLink.target = undefined;
    appleSelectionLink.targetErrorCode = undefined;
    appleSelectionLink.defaultDeveloperDir = undefined;
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realReadlinkSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      return appleSelectionLink.target;
    }) as typeof fs.readlinkSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target) === DEFAULT_DEVELOPER_DIR) {
        if (appleSelectionLink.defaultDeveloperDir === undefined) return missingDefaultDeveloperDir;
        return realRealpathSync(appleSelectionLink.defaultDeveloperDir);
      }
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realRealpathSync(target);
      if (appleSelectionLink.target === undefined) throw absent();
      if (appleSelectionLink.targetErrorCode) throw failure(appleSelectionLink.targetErrorCode);
      return realRealpathSync(appleSelectionLink.target);
    });
  });
}
