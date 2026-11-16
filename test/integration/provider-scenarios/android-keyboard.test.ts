import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

type AndroidKeyboardWorld = Awaited<ReturnType<typeof createAndroidSettingsWorld>>;

// The world's own `dumpsys input_method` fixture keeps the keyboard hidden, which is what the long
// Settings flow needs. Every case here scripts its own IME dump instead: the return key comes from
// the same output the visibility comes from, so the only thing a case has to say is what that one
// dump reports.
function createAndroidKeyboardWorld(dump: string) {
  return async () =>
    await createAndroidSettingsWorld({
      onAdbExec: (args) =>
        args.join(' ') === 'shell dumpsys input_method'
          ? { stdout: dump, stderr: '', exitCode: 0 }
          : undefined,
    });
}

function countImeDumps(world: AndroidKeyboardWorld): number {
  return world.adbCalls.filter((call) => call.join(' ') === 'shell dumpsys input_method').length;
}

// Reading the return key is not a second device round-trip: it comes from the one `dumpsys
// input_method` the visibility read already made.
test('Provider-backed integration Android keyboard status names the focused field return key', async () => {
  const createWorld = createAndroidKeyboardWorld(
    [
      'mInputShown=true mIsInputViewShown=true',
      'mCurMethodId=com.google.android.inputmethod.latin/.LatinIME',
      'inputType=0x200001 imeOptions=0x00000004 actionLabel=Send Message packageName=com.example.demo',
    ].join('\n'),
  );
  await withProviderScenarioResource(createWorld, async (world) => {
    const client = world.daemon.client();
    await client.apps.open({ app: 'settings', ...world.selection });

    const status = await client.command.keyboard({ action: 'status', ...world.selection });
    assert.equal(status.platform, 'android');
    assert.equal(status.action, 'status');
    assert.equal(status.visible, true);
    assert.equal(status.returnKey, 'send');
    assert.equal(status.returnKeyLabel, 'Send Message');
    assert.equal(status.inputOwner, 'app');
    assert.equal(countImeDumps(world), 1, JSON.stringify(world.adbCalls));
  });
});

// Closest negative: a hidden keyboard keeps its last editor's attributes in the dump. Nothing is
// being typed into, so no key offers anything, and both fields stay off the answer rather than
// reporting an action no key carries.
test('Provider-backed integration Android keyboard status reports no return key while the keyboard is hidden', async () => {
  const createWorld = createAndroidKeyboardWorld(
    ['mInputShown=false mIsInputViewShown=false', 'inputType=0x1 imeOptions=0x00000003'].join('\n'),
  );
  await withProviderScenarioResource(createWorld, async (world) => {
    const client = world.daemon.client();
    await client.apps.open({ app: 'settings', ...world.selection });

    const status = await client.command.keyboard({ action: 'status', ...world.selection });
    assert.equal(status.visible, false);
    assert.equal('returnKey' in status, false);
    assert.equal('returnKeyLabel' in status, false);
  });
});
