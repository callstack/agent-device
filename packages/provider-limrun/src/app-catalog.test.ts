import { describe, expect, test, vi } from 'vitest';
import {
  assertLimrunUploadedAppAccess,
  listLimrunAppAssets,
  resolveInstalledAppIdForAsset,
  resolveLimrunAppAsset,
} from './app-catalog.ts';

describe('Limrun uploaded app catalog', () => {
  test('rejects uploaded app access on the public daemon HTTP surface', () => {
    expect(() => assertLimrunUploadedAppAccess(true)).toThrow(/public daemon HTTP surface/);
    expect(() => assertLimrunUploadedAppAccess(false)).not.toThrow();
  });

  test('lists only uploaded assets compatible with the requested platform', async () => {
    const list = vi.fn(async () => [
      { id: 'android-explicit', name: 'build.bin', os: 'android', md5: 'a' },
      { id: 'android-apk', name: 'com.example.app.apk', md5: 'b' },
      { id: 'ios-zip', name: 'Example.app.zip', md5: 'c' },
      { id: 'pending', name: 'pending.apk' },
      { id: 'unknown', name: 'notes.txt', md5: 'd' },
    ]);
    const limrun = { assets: { list } } as never;

    await expect(listLimrunAppAssets(limrun, 'android')).resolves.toEqual([
      { id: 'android-explicit', name: 'build.bin' },
      { id: 'android-apk', name: 'com.example.app.apk' },
    ]);
    await expect(listLimrunAppAssets(limrun, 'ios')).resolves.toEqual([
      { id: 'ios-zip', name: 'Example.app.zip' },
    ]);
  });

  test('resolves an exact uploaded asset name and rejects platform mismatches', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'similar-1', name: 'Example.app.zip.backup.zip', md5: 'z' },
        { id: 'similar-2', name: 'Example.app.zip.previous.zip', md5: 'y' },
        { id: 'ios-app', name: 'Example.app.zip', md5: 'a' },
      ])
      .mockResolvedValueOnce([{ id: 'android-app', name: 'Example.apk', md5: 'b' }]);
    const limrun = { assets: { list } } as never;

    await expect(resolveLimrunAppAsset(limrun, 'ios', 'Example.app.zip')).resolves.toEqual({
      id: 'ios-app',
      name: 'Example.app.zip',
    });
    await expect(resolveLimrunAppAsset(limrun, 'ios', 'Example.apk')).resolves.toBeUndefined();
    expect(list).toHaveBeenNthCalledWith(
      1,
      { limit: 1_000, nameFilter: 'Example.app.zip' },
      { signal: undefined },
    );
  });

  test('matches an uploaded iOS asset when the instance also contains Expo Go', () => {
    expect(
      resolveInstalledAppIdForAsset('easagentdevice.app.zip', [
        { id: 'dev.expo.easagentdevice', name: 'Agent Device' },
        { id: 'host.exp.Exponent', name: 'Expo Go' },
      ]),
    ).toBe('dev.expo.easagentdevice');
    expect(
      resolveInstalledAppIdForAsset('unrelated-build.zip', [
        { id: 'com.example.first' },
        { id: 'com.example.second' },
      ]),
    ).toBeUndefined();
  });

  test('rejects colliding exact installed identities', () => {
    expect(
      resolveInstalledAppIdForAsset('example.app.zip', [
        { id: 'com.first', name: 'Example' },
        { id: 'com.second.example', name: 'Second' },
      ]),
    ).toBeUndefined();
  });
});
