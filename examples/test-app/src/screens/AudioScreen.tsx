import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton, InlineBadge, ScreenTitle, SectionCard } from '../components';
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
  const [playbackState, setPlaybackState] = useState<
    'ready' | 'playing' | 'paused' | 'ended' | 'error'
  >('ready');

  useEffect(() => {
    return () => {
      playbackRef.current?.stop();
      playbackRef.current = null;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.srcObject = null;
      }
    };
  }, []);

  function playSample() {
    const audio = audioRef.current;
    if (!audio) return;
    stopSample('ready');
    const playback = createBeepStream(() => {
      stopSample('ended');
    });
    playbackRef.current = playback;
    audio.srcObject = playback.stream;
    void audio
      .play()
      .then(() => setPlaybackState('playing'))
      .catch(() => {
        stopSample('error');
      });
  }

  function pauseSample() {
    stopSample('paused');
  }

  function stopSample(nextState: 'ready' | 'paused' | 'ended' | 'error') {
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

      <SectionCard subtitle="Generated browser beep, 6 seconds." title="Audio sample">
        {Platform.OS === 'web' ? (
          <View style={styles.player} testID="audio-sample-card">
            {createElement('audio', {
              'aria-label': 'Sample audio',
              controls: true,
              loop: false,
              onPause: () => {
                if (playbackRef.current) setPlaybackState('paused');
              },
              onPlay: () => setPlaybackState('playing'),
              ref: (node: BrowserAudioElement | null) => {
                audioRef.current = node;
              },
              style: { width: '100%' },
              'data-testid': 'sample-audio',
            })}

            <View style={styles.statusRow} testID="audio-playback-state">
              <InlineBadge
                label={playbackLabel(playbackState)}
                tone={
                  playbackState === 'playing'
                    ? 'success'
                    : playbackState === 'error'
                      ? 'danger'
                      : 'neutral'
                }
              />
            </View>

            <View style={styles.actionRow}>
              <ActionButton label="Start sample" onPress={playSample} testID="start-audio" />
              <ActionButton
                kind="secondary"
                label="Pause"
                onPress={pauseSample}
                testID="pause-audio"
              />
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

function playbackLabel(state: 'ready' | 'playing' | 'paused' | 'ended' | 'error'): string {
  return state === 'error' ? 'Playback blocked' : state === 'playing' ? 'Playing' : state;
}

function createBeepStream(onEnded: () => void): SamplePlayback {
  const webkitAudio = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = window.AudioContext ?? webkitAudio.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Web Audio API is not available.');
  const context = new AudioContextCtor();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const durationSeconds = 6;
  const startAt = context.currentTime + 0.03;
  const endAt = startAt + durationSeconds;

  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(440, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.05);
  gain.gain.setValueAtTime(0.35, endAt - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.01);
  void context.resume();

  const endTimer = window.setTimeout(onEnded, durationSeconds * 1000);
  return {
    stream: destination.stream,
    stop: () => {
      window.clearTimeout(endTimer);
      try {
        oscillator.stop();
      } catch {
        // The scheduled stop may already have fired.
      }
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
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
