import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Timed UI effects for measuring `--settle`: each button starts one effect whose final screen is
 * known, so a settled tree can be checked against it. `settle-status` names the final state of the
 * last effect with its run number.
 */
const DELAYS_MS = [500, 800] as const;
const FADE_MS = 750;
const STAGE_MS = 600;
const NAVIGATE_AFTER_TOAST_MS = 700;

export function SettleLabScreen() {
  const [run, setRun] = useState(0);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('idle');
  const [stage, setStage] = useState<'none' | 'spinner' | 'plain'>('none');
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(1)).current;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const later = (ms: number, effect: () => void) => {
    timers.current.push(setTimeout(effect, ms));
  };
  const nextRun = () => {
    const next = run + 1;
    setRun(next);
    return next;
  };

  return (
    <View style={styles.frame} testID="settle-lab-root">
      <Text style={styles.title}>Settle lab</Text>
      <Text style={styles.status} testID="settle-status">
        {status}
      </Text>
      <Text style={styles.status} testID="settle-count">
        {`Count ${count}`}
      </Text>
      <LabButton id="settle-increment" label="Increment" onPress={() => setCount((c) => c + 1)} />
      {DELAYS_MS.map((delayMs) => (
        <LabButton
          id={`settle-delay-${delayMs}`}
          key={delayMs}
          label={`Delay ${delayMs}`}
          onPress={() => {
            const id = nextRun();
            later(delayMs, () => setStatus(`Delayed ${delayMs} done ${id}`));
          }}
        />
      ))}
      <LabButton
        id="settle-overlay"
        label="Fade overlay"
        onPress={() => {
          const id = nextRun();
          opacity.setValue(1);
          setOverlayVisible(true);
          Animated.timing(opacity, {
            toValue: 0,
            duration: FADE_MS,
            useNativeDriver: true,
          }).start(() => {
            setOverlayVisible(false);
            setStatus(`Overlay gone ${id}`);
          });
        }}
      />
      <LabButton
        id="settle-two-stage-spinner"
        label="Two stage spinner"
        onPress={() => {
          const id = nextRun();
          setStage('spinner');
          later(STAGE_MS, () => {
            setStage('none');
            setStatus(`Stage done ${id}`);
          });
        }}
      />
      <LabButton
        id="settle-two-stage-plain"
        label="Two stage plain"
        onPress={() => {
          const id = nextRun();
          setStage('plain');
          later(STAGE_MS, () => {
            setStage('none');
            setStatus(`Stage done ${id}`);
          });
        }}
      />
      <LabButton
        id="settle-toast-navigate"
        label="Toast then navigate"
        onPress={() => {
          const id = nextRun();
          setToast('Saving');
          later(NAVIGATE_AFTER_TOAST_MS, () => {
            setToast(null);
            router.push({ pathname: '/settle-lab-result', params: { run: String(id) } });
          });
        }}
      />
      {stage === 'spinner' ? (
        <View style={styles.row} testID="settle-stage-spinner">
          <ActivityIndicator />
          <Text style={styles.status}>Working</Text>
        </View>
      ) : null}
      {stage === 'plain' ? (
        <Text style={styles.status} testID="settle-stage-plain">
          Step 1 of 2
        </Text>
      ) : null}
      {toast ? (
        <View style={styles.toast} testID="settle-toast">
          <Text style={styles.toastLabel}>{toast}</Text>
        </View>
      ) : null}
      {overlayVisible ? (
        <Animated.View style={[styles.overlay, { opacity }]} testID="settle-overlay-panel">
          <Pressable accessibilityRole="button" style={styles.overlayButton}>
            <Text style={styles.toastLabel}>Overlay</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

export function SettleLabResultScreen({ run }: { run: string | undefined }) {
  return (
    <View style={styles.frame} testID="settle-lab-result">
      <Text style={styles.title}>{`Result ${run ?? ''}`}</Text>
      <LabButton id="settle-result-back" label="Back to lab" onPress={() => router.back()} />
    </View>
  );
}

function LabButton(props: { id: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={styles.button}
      testID={props.id}
    >
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, gap: 8, padding: 24, paddingTop: 72, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '700' },
  status: { fontSize: 16 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  button: { backgroundColor: '#e8eefc', borderRadius: 8, padding: 12 },
  buttonLabel: { fontSize: 16 },
  toast: {
    position: 'absolute',
    bottom: 48,
    left: 24,
    right: 24,
    backgroundColor: '#222',
    borderRadius: 8,
    padding: 12,
  },
  toastLabel: { color: '#fff', fontSize: 16 },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  overlayButton: { backgroundColor: '#333', borderRadius: 8, padding: 24 },
});
