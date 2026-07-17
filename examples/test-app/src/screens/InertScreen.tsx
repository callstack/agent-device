import { StyleSheet, Text, View } from 'react-native';

import { useAppColors, type AppColors } from '../theme';

/**
 * A surface on which a tap provably changes nothing.
 *
 * `retryTapIfNoChange` only re-taps when the post-tap snapshot signature equals
 * the pre-tap one, and that signature hashes EVERY node on screen — not just the
 * tapped subtree. So any live content anywhere on the screen suppresses the
 * retry, which is what made the layer-3 tap-retry scenario a coin flip on the
 * home screen (its gesture lab loads a remote image whose arrival lands on either
 * side of the tap). See https://github.com/callstack/agent-device/issues/1300.
 *
 * Everything here is therefore deliberately constrained, and each rule is load-
 * bearing for that scenario rather than stylistic:
 *
 * - no state, effects, timers, or async work — nothing to arrive after capture
 * - no images (a remote one loads whenever the network says so)
 * - no ScrollView — scroll offset moves node bounds, which are part of the hash
 * - nothing pressable, so a tap cannot mutate the screen even by accident
 *
 * Adding any of those back re-opens #1300. Put dynamic fixtures on another
 * screen; this one exists to hold still.
 */
export function InertScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View style={styles.content}>
      <Text style={styles.title} testID="inert-title">
        Inert surface
      </Text>
      <Text style={styles.body} testID="inert-target">
        Tapping this text changes nothing on screen.
      </Text>
      <Text style={styles.footnote}>
        Nothing here reacts to touch, loads, or animates, so a tap leaves the
        hierarchy byte-identical and retryTapIfNoChange must re-tap.
      </Text>
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    body: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
    content: {
      gap: 16,
    },
    footnote: {
      color: colors.textSoft,
      fontSize: 14,
      lineHeight: 21,
    },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '700',
    },
  });
}
