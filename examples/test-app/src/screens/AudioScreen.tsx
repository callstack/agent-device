import { createElement, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
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

const SAMPLE_DURATION_SECONDS = 6;
const SAMPLE_FREQUENCY_HZ = 440;

export function AudioScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const audioRef = useRef<BrowserAudioElement | null>(null);
  const playbackRef = useRef<SamplePlayback | null>(null);
  const nativePlayerRef = useRef<AudioPlayer | null>(null);
  const nativeEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      stopNativeSample();
    };
  }, []);

  function playSample() {
    if (Platform.OS !== 'web') {
      playNativeSample();
      return;
    }
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
    if (Platform.OS !== 'web') {
      pauseNativeSample();
      return;
    }
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

  function playNativeSample() {
    stopNativeSample();
    try {
      const player = createAudioPlayer({ uri: createNativeBeepDataUri(), name: 'Agent Device beep' });
      nativePlayerRef.current = player;
      player.play();
      setPlaybackState('playing');
      nativeEndTimerRef.current = setTimeout(() => {
        stopNativeSample();
        setPlaybackState('ended');
      }, SAMPLE_DURATION_SECONDS * 1000);
    } catch {
      stopNativeSample();
      setPlaybackState('error');
    }
  }

  function pauseNativeSample() {
    stopNativeSample();
    setPlaybackState('paused');
  }

  function stopNativeSample() {
    if (nativeEndTimerRef.current) {
      clearTimeout(nativeEndTimerRef.current);
      nativeEndTimerRef.current = null;
    }
    const player = nativePlayerRef.current;
    nativePlayerRef.current = null;
    if (!player) return;
    try {
      player.pause();
    } catch {
      // Playback may already have finished.
    }
    player.remove();
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="Media"
        subtitle="A short generated audio sample with a visible playback state."
        title="Audio"
        testID="audio-title"
      />

      <SectionCard subtitle="Generated 440 Hz beep, 6 seconds." title="Audio sample">
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
          <View style={styles.player} testID="audio-sample-card">
            <View style={styles.nativeFallback} testID="audio-native-player">
              <Text style={styles.statusText}>Native audio sample</Text>
            </View>

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
  const durationSeconds = SAMPLE_DURATION_SECONDS;
  const startAt = context.currentTime + 0.03;
  const endAt = startAt + durationSeconds;

  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(SAMPLE_FREQUENCY_HZ, startAt);
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

function createNativeBeepDataUri(): string {
  const sampleRate = 8000;
  const dataSize = sampleRate * SAMPLE_DURATION_SECONDS;
  const headerSize = 44;
  const bytes = new Uint8Array(headerSize + dataSize);
  writeAscii(bytes, 0, 'RIFF');
  writeUint32(bytes, 4, 36 + dataSize);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  writeUint32(bytes, 16, 16);
  writeUint16(bytes, 20, 1);
  writeUint16(bytes, 22, 1);
  writeUint32(bytes, 24, sampleRate);
  writeUint32(bytes, 28, sampleRate);
  writeUint16(bytes, 32, 1);
  writeUint16(bytes, 34, 8);
  writeAscii(bytes, 36, 'data');
  writeUint32(bytes, 40, dataSize);

  for (let index = 0; index < dataSize; index += 1) {
    const cycle = Math.sin((2 * Math.PI * SAMPLE_FREQUENCY_HZ * index) / sampleRate);
    bytes[headerSize + index] = Math.round(128 + cycle * 96);
  }

  return `data:audio/wav;base64,${base64Encode(bytes)}`;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function writeUint16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    output += index + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] : '=';
    output += index + 2 < bytes.length ? alphabet[(third ?? 0) & 0x3f] : '=';
  }
  return output;
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
