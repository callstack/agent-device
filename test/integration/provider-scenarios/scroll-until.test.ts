import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_UNTIL_PASS_LIMIT } from '@agent-device/capture-kit/scroll-until-visible';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

/**
 * `scroll --until <selector>` through the real daemon, provider admission, and capture path.
 *
 * The world serves a hierarchy whose target row starts below the viewport and climbs on each
 * capture, which is what lets the loop's stop condition be observed rather than asserted: the
 * command is expected to stop on the first capture that puts the row on screen, and to have spent
 * exactly the gestures that took to reach it.
 */
/**
 * The row climbs one screen per capture, so it is off-screen for the first captures and on screen
 * from the third. Keyed on captures rather than on injected gestures because the Android gesture
 * path runs through the persistent helper, not an adb shell command the world can count.
 */
function climbingRow(): () => number {
  let captures = 0;
  return () => {
    const top = Math.max(200, 1400 - captures * 600);
    captures += 1;
    return top;
  };
}

function climbingHierarchy(targetTop: () => number): () => string {
  return () =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<hierarchy rotation="0">',
      '  <node index="0" text="" resource-id="com.android.settings:id/main_content_scrollable_container" class="android.widget.ScrollView" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
      '    <node index="0" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="true" enabled="true" focusable="true" focused="false" />',
      `    <node index="1" text="Terms" resource-id="com.android.settings:id/terms" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,${targetTop()}][374,${targetTop() + 54}]" clickable="true" enabled="true" focusable="true" focused="false" />`,
      '  </node>',
      '</hierarchy>',
    ].join('\n');
}

test('Provider-backed integration scroll --until stops on the capture that brings the target on screen', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: climbingHierarchy(climbingRow()) }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });

      const result = await client.interactions.scroll({
        direction: 'down',
        until: 'text=Terms',
        ...world.selection,
      });

      const passes = typeof result.passes === 'number' ? result.passes : -1;
      assert.equal(result.until, 'text=Terms');
      assert.equal(result.direction, 'down');
      assert.ok(
        passes >= 1,
        `expected at least one pass to reach the off-screen row, saw ${passes}`,
      );
      assert.match(String(result.message), /until text=Terms was visible/);
      // Stopped on arrival rather than running the budget out.
      assert.ok(
        passes < SCROLL_UNTIL_PASS_LIMIT,
        `expected the loop to stop on arrival, spent ${passes} passes`,
      );
    },
  );
});

test('Provider-backed integration scroll --until reports the end of the content as a typed failure', async () => {
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        // Nothing below the fold and nothing hidden: the content cannot move further.
        snapshotXml: climbingHierarchy(() => 200),
      }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });

      await assert.rejects(
        () =>
          client.interactions.scroll({
            direction: 'down',
            until: 'text=NeverPresent',
            ...world.selection,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.match(String(error.message), /without text=NeverPresent becoming visible/);
          return true;
        },
      );
    },
  );
});

test('Provider-backed integration scroll rejects --until on the edge directions', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: climbingHierarchy(() => 200) }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });

      await assert.rejects(
        () =>
          client.interactions.scroll({
            direction: 'bottom',
            until: 'text=Terms',
            ...world.selection,
          }),
        /cannot take --until/,
      );
    },
  );
});
