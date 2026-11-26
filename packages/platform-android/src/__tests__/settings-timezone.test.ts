import { expect, test } from 'vitest';
import { setAndroidSetting } from '../settings.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';

/**
 * A device whose `alarm set-timezone` lands in `persist.sys.timezone` unless `honor` is false, and
 * whose `auto_time_zone` row starts at `initialAutoTimeZone` and holds whatever is written to it.
 */
function timeZoneDevice(
  options: { honor?: boolean; known?: boolean; initialAutoTimeZone?: string } = {},
) {
  let zone = 'America/Los_Angeles';
  const state = { autoTimeZone: options.initialAutoTimeZone ?? '1' };
  const script = (args: string[]): FakeAdbResponse => {
    const flat = args.join(' ');
    if (flat === 'shell getprop persist.sys.timezone') return `${zone}\n`;
    if (flat === 'shell settings get global auto_time_zone') return `${state.autoTimeZone}\n`;
    const auto = /^shell settings put global auto_time_zone ([01])$/.exec(flat);
    if (auto) {
      state.autoTimeZone = auto[1]!;
      return '';
    }
    const write = /^shell cmd alarm set-timezone (\S+)$/.exec(flat);
    if (write) {
      if (options.known === false) {
        return {
          stdout: 'java.lang.IllegalArgumentException: Timezone ID not valid',
          exitCode: 255,
        };
      }
      if (options.honor !== false) zone = write[1]!;
      return '';
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
  return Object.assign(script, { state });
}

test('settings timezone turns automatic time zone off, then sets and reads back the zone', async () => {
  await withFakeAdb(timeZoneDevice(), async ({ calls, device }) => {
    expect(await setAndroidSetting(device, 'timezone', 'Asia/Kolkata')).toEqual({
      timeZone: 'Asia/Kolkata',
      previousTimeZone: 'America/Los_Angeles',
      autoTimeZone: false,
    });
    const flat = calls.map((args) => args.join(' '));
    expect(flat).toContain('shell settings put global auto_time_zone 0');
    expect(flat.indexOf('shell settings put global auto_time_zone 0')).toBeLessThan(
      flat.indexOf('shell cmd alarm set-timezone Asia/Kolkata'),
    );
  });
});

test('settings timezone runs over adb on a physical Android device as well as an emulator', async () => {
  const physical = { ...ANDROID_EMULATOR, id: 'R5CT1234', kind: 'device' as const };
  await withFakeAdb(
    timeZoneDevice(),
    async ({ device }) => {
      expect(await setAndroidSetting(device, 'timezone', 'Asia/Kolkata')).toEqual({
        timeZone: 'Asia/Kolkata',
        previousTimeZone: 'America/Los_Angeles',
        autoTimeZone: false,
      });
    },
    { device: physical },
  );
});

test('settings timezone reset turns automatic time zone back on without naming a zone', async () => {
  await withFakeAdb(timeZoneDevice(), async ({ calls, device }) => {
    expect(await setAndroidSetting(device, 'timezone', 'reset')).toEqual({
      timeZone: null,
      previousTimeZone: 'America/Los_Angeles',
      autoTimeZone: true,
    });
    const flat = calls.map((args) => args.join(' '));
    expect(flat).toContain('shell settings put global auto_time_zone 1');
    expect(flat.some((args) => args.includes('set-timezone'))).toBe(false);
  });
});

test.each([
  { name: 'keeps the old zone', options: { honor: false }, reason: 'time-zone-not-applied' },
  { name: 'rejects the zone', options: { known: false }, reason: undefined },
])(
  'settings timezone fails when the device $name and puts automatic time zone back',
  async ({ options, reason }) => {
    const fake = timeZoneDevice(options);
    await withFakeAdb(fake, async ({ device }) => {
      const failure = await setAndroidSetting(device, 'timezone', 'Asia/Kolkata').catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: 'COMMAND_FAILED',
        details: { dispatched: 'unknown', autoTimeZone: true },
      });
      expect((failure as { details: { reason?: string } }).details.reason).toBe(reason);
      expect(fake.state.autoTimeZone).toBe('1');
    });
  },
);

test('settings timezone keeps automatic time zone off on failure when it was already off', async () => {
  const fake = timeZoneDevice({ honor: false, initialAutoTimeZone: '0' });
  await withFakeAdb(fake, async ({ device }) => {
    await expect(setAndroidSetting(device, 'timezone', 'asia/kolkata')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'time-zone-not-applied',
        dispatched: 'unknown',
        timeZone: 'asia/kolkata',
        storedTimeZone: 'America/Los_Angeles',
        autoTimeZone: false,
      },
    });
    expect(fake.state.autoTimeZone).toBe('0');
  });
});
