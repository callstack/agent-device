import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { InlineBadge, ScreenTitle, SectionCard } from '../components';
import { useAppColors, type AppColors } from '../theme';

type BrowserAudioElement = {
  srcObject: MediaStream | null;
  pause: () => void;
  play: () => Promise<void>;
};

type SamplePlayback = {
  stream: MediaStream;
  stop: () => void;
};

export function AudioScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const audioRef = useRef<BrowserAudioElement | null>(null);
  const playbackRef = useRef<SamplePlayback | null>(null);
  const [playbackState, setPlaybackState] = useState<'ready' | 'playing' | 'paused' | 'ended'>(
    'ready',
  );

  useEffect(() => {
    return () => stopSample('ended');
  }, []);

  function playSample() {
    const audio = audioRef.current;
    if (!audio) return;
    stopSample('ready');
    const playback = createClassicLoopStream(() => {
      stopSample('ended');
    });
    playbackRef.current = playback;
    audio.srcObject = playback.stream;
    void audio.play().then(() => setPlaybackState('playing'));
  }

  function pauseSample() {
    stopSample('paused');
  }

  function stopSample(nextState: 'ready' | 'paused' | 'ended') {
    const audio = audioRef.current;
    playbackRef.current?.stop();
    playbackRef.current = null;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    setPlaybackState(nextState);
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="Media"
        subtitle="A short browser media sample with a visible playback state."
        title="Audio"
        testID="audio-title"
      />

      <SectionCard subtitle="Generated tracker-style loop, 8 seconds." title="Classic loop">
        {Platform.OS === 'web' ? (
          <View style={styles.player} testID="classic-audio-card">
            {createElement('audio', {
              'aria-label': 'Classic sample audio',
              controls: true,
              loop: false,
              onPause: () => {
                if (playbackState === 'playing') setPlaybackState('paused');
              },
              onPlay: () => setPlaybackState('playing'),
              ref: (node: BrowserAudioElement | null) => {
                audioRef.current = node;
              },
              style: { width: '100%' },
              'data-testid': 'classic-audio',
            })}

            <View style={styles.statusRow}>
              <InlineBadge
                label={playbackState === 'playing' ? 'Playing' : playbackState}
                tone={playbackState === 'playing' ? 'success' : 'neutral'}
              />
              <Text style={styles.statusText} testID="audio-playback-state">
                {playbackState}
              </Text>
            </View>

            <View style={styles.actionRow}>
              {createElement(
                'button',
                {
                  'aria-label': 'Start sample',
                  onClick: playSample,
                  style: webButtonStyle(colors, 'primary'),
                  'data-testid': 'start-audio',
                },
                'Start sample',
              )}
              {createElement(
                'button',
                {
                  'aria-label': 'Pause',
                  onClick: pauseSample,
                  style: webButtonStyle(colors, 'secondary'),
                  'data-testid': 'pause-audio',
                },
                'Pause',
              )}
            </View>
          </View>
        ) : (
          <View style={styles.nativeFallback} testID="audio-native-fallback">
            <Text style={styles.statusText}>Browser audio sample</Text>
          </View>
        )}
      </SectionCard>
    </ScrollView>
  );
}

function webButtonStyle(colors: AppColors, kind: 'primary' | 'secondary') {
  return {
    backgroundColor: kind === 'primary' ? colors.text : 'transparent',
    border: `1px solid ${kind === 'primary' ? colors.text : colors.lineStrong}`,
    borderRadius: 4,
    color: kind === 'primary' ? colors.surface : colors.text,
    cursor: 'pointer',
    fontSize: 15,
    fontWeight: 600,
    padding: '13px 16px',
  };
}

function createClassicLoopStream(onEnded: () => void): SamplePlayback {
  const webkitAudio = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = window.AudioContext ?? webkitAudio.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Web Audio API is not available.');
  const context = new AudioContextCtor();
  const destination = context.createMediaStreamDestination();
  const master = context.createGain();
  const durationSeconds = 8;
  const startAt = context.currentTime + 0.03;
  const melody = [196, 247, 294, 330, 392, 330, 294, 247, 220, 262, 330, 392, 494, 392, 330, 262];

  master.gain.value = 0.55;
  master.connect(destination);
  void context.resume();

  for (let step = 0; step < durationSeconds * 4; step += 1) {
    const noteStart = startAt + step * 0.25;
    const frequency = melody[step % melody.length] ?? 220;
    scheduleTone(context, master, frequency, noteStart, 0.2, 0.42);
    if (step % 4 === 0) scheduleTone(context, master, 98, noteStart, 0.22, 0.25);
    if (step % 2 === 0) scheduleTone(context, master, 1760, noteStart, 0.04, 0.08);
  }

  const endTimer = window.setTimeout(onEnded, durationSeconds * 1000);
  return {
    stream: destination.stream,
    stop: () => {
      window.clearTimeout(endTimer);
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}

function scheduleTone(
  context: AudioContext,
  output: AudioNode,
  frequency: number,
  startAt: number,
  duration: number,
  volume: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(output);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.01);
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    player: {
      gap: 14,
    },
    statusRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    statusText: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
      textTransform: 'capitalize',
    },
    actionRow: {
      gap: 10,
    },
    nativeFallback: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 14,
    },
  });
}
