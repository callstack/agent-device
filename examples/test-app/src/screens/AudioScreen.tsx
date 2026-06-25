import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton, InlineBadge, ScreenTitle, SectionCard } from '../components';
import { useAppColors, type AppColors } from '../theme';

type BrowserAudioElement = {
  currentTime: number;
  pause: () => void;
  play: () => Promise<void>;
};

export function AudioScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const audioRef = useRef<BrowserAudioElement | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | undefined>();
  const [playbackState, setPlaybackState] = useState<'ready' | 'playing' | 'paused' | 'ended'>(
    'ready',
  );

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const url = createClassicLoopWavUrl();
    setAudioSrc(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, []);

  function playSample() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().then(() => setPlaybackState('playing'));
  }

  function pauseSample() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    setPlaybackState('paused');
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
        {Platform.OS === 'web' && audioSrc ? (
          <View style={styles.player} testID="classic-audio-card">
            {createElement('audio', {
              'aria-label': 'Classic sample audio',
              controls: true,
              loop: false,
              onEnded: () => setPlaybackState('ended'),
              onPause: () => {
                if (playbackState === 'playing') setPlaybackState('paused');
              },
              onPlay: () => setPlaybackState('playing'),
              ref: (node: BrowserAudioElement | null) => {
                audioRef.current = node;
              },
              src: audioSrc,
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

function createClassicLoopWavUrl(): string {
  const sampleRate = 11_025;
  const durationSeconds = 8;
  const sampleCount = sampleRate * durationSeconds;
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = sampleCount * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const melody = [196, 247, 294, 330, 392, 330, 294, 247, 220, 262, 330, 392, 494, 392, 330, 262];
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    const step = Math.floor(t * 4) % melody.length;
    const beatPhase = (t * 4) % 1;
    const envelope = Math.max(0.18, 1 - beatPhase * 0.72);
    const bass = squareWave(98, t) * 0.18;
    const lead = squareWave(melody[step] ?? 220, t) * 0.42 * envelope;
    const hat = ((index * 17) % 31 < 2 ? 0.12 : 0) * (beatPhase < 0.08 ? 1 : 0);
    const sample = Math.max(-0.82, Math.min(0.82, lead + bass + hat));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function squareWave(frequency: number, t: number): number {
  return Math.sin(Math.PI * 2 * frequency * t) >= 0 ? 1 : -1;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
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
