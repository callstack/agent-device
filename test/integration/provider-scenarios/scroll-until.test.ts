import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_UNTIL_PASS_LIMIT } from '../../../src/daemon/scroll-until.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

/**
 * `scroll --until <selector>` through the real daemon, provider admission, and capture path.
 *
 * The row climbs one screen per capture, so it is off-screen for the first captures and on screen
 * from the third: the loop's stop condition is observed rather than asserted. Keyed on captures
 * rather than on injected gestures because the Android gesture path runs through the persistent
 * helper, not an adb shell command the world can count.
 */
/** Two screens below the fold, climbing one screen per capture: visible on the third capture. */
const ARRIVAL_PASSES = 2;

function climbingRow(): () => number {
  let captures = 0;
  return () => {
    const top = Math.max(200, 1400 - captures * 600);
    captures += 1;
    return top;
  };
}

function climbingHierarchy(targetTop: () => number): () => string {
  return () => {
    // Read the stateful position ONCE: calling it per bound advanced the row twice per capture and
    // produced an inverted rectangle on the first one.
    const top = targetTop();
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<hierarchy rotation="0">',
      '  <node index="0" text="" resource-id="com.android.settings:id/main_content_scrollable_container" class="android.widget.ScrollView" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
      '    <node index="0" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="true" enabled="true" focusable="true" focused="false" />',
      `    <node index="1" text="Terms" resource-id="com.android.settings:id/terms" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,${top}][374,${top + 54}]" clickable="true" enabled="true" focusable="true" focused="false" />`,
      '  </node>',
      '</hierarchy>',
    ].join('\n');
  };
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

      assert.equal(result.until, 'text=Terms');
      assert.equal(result.direction, 'down');
      // An exact count is what proves repeated scrolling on valid geometry, rather than a lucky
      // first capture or a budget burned to the limit.
      assert.equal(result.passes, ARRIVAL_PASSES);
      assert.ok(ARRIVAL_PASSES < SCROLL_UNTIL_PASS_LIMIT);
      assert.match(
        String(result.message),
        new RegExp(`Scrolled down ${ARRIVAL_PASSES} passes until text=Terms was visible`),
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
