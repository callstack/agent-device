import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Text, View, type GestureResponderEvent } from 'react-native';
import {
  Directions,
  FlingGestureHandler,
  Gesture,
  GestureDetector,
  PanGestureHandler,
  PinchGestureHandler,
  RotationGestureHandler,
  State,
  type FlingGestureHandlerStateChangeEvent,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
  type PinchGestureHandlerGestureEvent,
  type PinchGestureHandlerStateChangeEvent,
  type RotationGestureHandlerGestureEvent,
  type RotationGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';

import { SectionCard } from '../components';
import { useAppColors } from '../theme';
import { createGestureLabStyles } from './gesture-lab-styles';
import { disableDevelopmentGestureInterceptors } from './gesture-lab-dev-menu';

const gestureImageUri = 'https://reactnative.dev/img/logo-share.png';

type TransformState = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
};

type GestureCounts = {
  fling: number;
  twoPointerPan: number;
};

type AndroidTouchStart = TransformState & {
  angle: number;
  centroidX: number;
  centroidY: number;
  span: number;
};

const initialTransform: TransformState = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
};

const initialCounts: GestureCounts = {
  fling: 0,
  twoPointerPan: 0,
};
const minScale = 0.5;
const maxScale = 2;

export function GestureLab() {
  const colors = useAppColors();
  const styles = createGestureLabStyles(colors);
  const [canaryReady, setCanaryReady] = useState(false);
  const [transform, setTransform] = useState<TransformState>(initialTransform);
  const [counts, setCounts] = useState<GestureCounts>(initialCounts);
  const transformRef = useRef<TransformState>(initialTransform);
  const gestureStartRef = useRef<TransformState>(initialTransform);
  const androidTouchStartRef = useRef<AndroidTouchStart | undefined>(undefined);
  const legacyFlingDownRef = useRef(null);
  const legacyFlingLeftRef = useRef(null);
  const legacyFlingRightRef = useRef(null);
  const legacyFlingUpRef = useRef(null);
  const legacyPanRef = useRef(null);
  const legacyPinchRef = useRef(null);
  const legacyRotationRef = useRef(null);
  const activeTransformHandlerTagsRef = useRef(new Set<number>());

  useEffect(() => {
    void disableDevelopmentGestureInterceptors()
      .catch(() => undefined)
      .finally(() => setCanaryReady(true));
  }, []);

  function updateTransform(nextTransform: TransformState) {
    transformRef.current = nextTransform;
    setTransform(nextTransform);
  }

  function beginTransformGesture(handlerTag: number) {
    const activeHandlerTags = activeTransformHandlerTagsRef.current;
    if (activeHandlerTags.size === 0) {
      gestureStartRef.current = transformRef.current;
    }
    activeHandlerTags.add(handlerTag);
  }

  function endTransformGesture(handlerTag: number) {
    activeTransformHandlerTagsRef.current.delete(handlerTag);
  }

  function handlePan(translationX: number, translationY: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      offsetX: clamp(start.offsetX + translationX, -72, 72),
      offsetY: clamp(start.offsetY + translationY, -56, 56),
    });
  }

  function handlePinch(scale: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      scale: clamp(start.scale * scale, minScale, maxScale),
    });
  }

  function handleRotation(rotation: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      rotation: start.rotation + rotation,
    });
  }

  function handleFling() {
    setCounts((current) => ({ ...current, fling: current.fling + 1 }));
  }

  function handleTwoPointerPan() {
    setCounts((current) => ({
      ...current,
      twoPointerPan: current.twoPointerPan + 1,
    }));
  }

  function handleLegacyTransformStateChange(
    event:
      | PanGestureHandlerStateChangeEvent
      | PinchGestureHandlerStateChangeEvent
      | RotationGestureHandlerStateChangeEvent,
  ) {
    if (event.nativeEvent.state === State.BEGAN) {
      beginTransformGesture(event.nativeEvent.handlerTag);
    } else if (
      event.nativeEvent.state === State.END ||
      event.nativeEvent.state === State.FAILED ||
      event.nativeEvent.state === State.CANCELLED
    ) {
      endTransformGesture(event.nativeEvent.handlerTag);
    }
  }

  function handleLegacyFling(event: FlingGestureHandlerStateChangeEvent) {
    if (event.nativeEvent.state === State.ACTIVE) handleFling();
  }

  function handleAndroidTouchStart(event: GestureResponderEvent) {
    const [first, second] = event.nativeEvent.touches;
    if (!first || !second) return;
    androidTouchStartRef.current = {
      ...transformRef.current,
      angle: Math.atan2(second.pageY - first.pageY, second.pageX - first.pageX),
      centroidX: (first.pageX + second.pageX) / 2,
      centroidY: (first.pageY + second.pageY) / 2,
      span: Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY),
    };
  }

  function handleAndroidTouchMove(event: GestureResponderEvent) {
    const start = androidTouchStartRef.current;
    const [first, second] = event.nativeEvent.touches;
    if (!start || !first || !second) return;
    const centroidX = (first.pageX + second.pageX) / 2;
    const centroidY = (first.pageY + second.pageY) / 2;
    const span = Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
    const angle = Math.atan2(second.pageY - first.pageY, second.pageX - first.pageX);
    updateTransform({
      offsetX: clamp(start.offsetX + centroidX - start.centroidX, -72, 72),
      offsetY: clamp(start.offsetY + centroidY - start.centroidY, -56, 56),
      rotation: start.rotation + normalizedRadians(angle - start.angle),
      scale: clamp(start.scale * (span / start.span), minScale, maxScale),
    });
  }

  const twoPointerPanGesture = Gesture.Pan()
    .averageTouches(true)
    .minPointers(2)
    .maxPointers(2)
    .minDistance(4)
    .runOnJS(true)
    .onStart(handleTwoPointerPan);
  const legacyFlingRefs = [
    legacyFlingLeftRef,
    legacyFlingRightRef,
    legacyFlingUpRef,
    legacyFlingDownRef,
  ];

  const androidTransformTarget = (
    <FlingGestureHandler
      direction={Directions.LEFT}
      onHandlerStateChange={handleLegacyFling}
      ref={legacyFlingLeftRef}
      simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
    >
      <FlingGestureHandler
        direction={Directions.RIGHT}
        onHandlerStateChange={handleLegacyFling}
        ref={legacyFlingRightRef}
        simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
      >
        <FlingGestureHandler
          direction={Directions.UP}
          onHandlerStateChange={handleLegacyFling}
          ref={legacyFlingUpRef}
          simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
        >
          <FlingGestureHandler
            direction={Directions.DOWN}
            onHandlerStateChange={handleLegacyFling}
            ref={legacyFlingDownRef}
            simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
          >
            <RotationGestureHandler
              onGestureEvent={(event: RotationGestureHandlerGestureEvent) =>
                handleRotation(event.nativeEvent.rotation)
              }
              onHandlerStateChange={handleLegacyTransformStateChange}
              ref={legacyRotationRef}
              simultaneousHandlers={[legacyPanRef, legacyPinchRef, ...legacyFlingRefs]}
            >
              <PinchGestureHandler
                onGestureEvent={(event: PinchGestureHandlerGestureEvent) =>
                  handlePinch(event.nativeEvent.scale)
                }
                onHandlerStateChange={handleLegacyTransformStateChange}
                ref={legacyPinchRef}
                simultaneousHandlers={[legacyPanRef, legacyRotationRef, ...legacyFlingRefs]}
              >
                <PanGestureHandler
                  avgTouches
                  maxPointers={2}
                  minDist={4}
                  minPointers={2}
                  onGestureEvent={(event: PanGestureHandlerGestureEvent) =>
                    handlePan(event.nativeEvent.translationX, event.nativeEvent.translationY)
                  }
                  onHandlerStateChange={handleLegacyTransformStateChange}
                  ref={legacyPanRef}
                  simultaneousHandlers={[legacyPinchRef, legacyRotationRef, ...legacyFlingRefs]}
                >
                  <View
                    accessibilityLabel="Transform gesture target"
                    style={styles.androidTransformTarget}
                    testID="transform-gesture-target"
                  />
                </PanGestureHandler>
              </PinchGestureHandler>
            </RotationGestureHandler>
          </FlingGestureHandler>
        </FlingGestureHandler>
      </FlingGestureHandler>
    </FlingGestureHandler>
  );

  const rotationDegrees = Math.round((transform.rotation * 180) / Math.PI);
  const statusLabel = `x ${Math.round(transform.offsetX)}, y ${Math.round(
    transform.offsetY,
  )}, scale ${transform.scale.toFixed(2)}, rotate ${rotationDegrees}`;
  const panChanged = Math.abs(transform.offsetX) > 1 || Math.abs(transform.offsetY) > 1;
  const pinchChanged = Math.abs(transform.scale - 1) > 0.01;
  const rotateChanged = rotationDegrees !== 0;
  const changeStatusLabel = `pan changed ${panChanged ? 'yes' : 'no'}, pinch changed ${
    pinchChanged ? 'yes' : 'no'
  }, rotate changed ${rotateChanged ? 'yes' : 'no'}`;

  return (
    <SectionCard
      subtitle={`Image target for pan, pinch, rotate, and fling. ${changeStatusLabel}`}
      title="Gesture lab"
      testID="gesture-lab-card"
    >
      <View
        accessibilityLabel="Gesture test image"
        onTouchEnd={
          Platform.OS === 'android' ? () => (androidTouchStartRef.current = undefined) : undefined
        }
        onTouchMove={Platform.OS === 'android' ? handleAndroidTouchMove : undefined}
        onTouchStart={Platform.OS === 'android' ? handleAndroidTouchStart : undefined}
        style={styles.target}
        testID="gesture-target"
      >
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel="Gesture test image"
          resizeMode="cover"
          source={{ uri: gestureImageUri }}
          style={[
            styles.image,
            {
              transform: [
                { translateX: transform.offsetX },
                { translateY: transform.offsetY },
                { scale: transform.scale },
                { rotate: `${rotationDegrees}deg` },
              ],
            },
          ]}
          testID="gesture-target-image"
        />
        {androidTransformTarget}
        <GestureDetector gesture={twoPointerPanGesture}>
          <View
            accessibilityLabel="Exact two-pointer pan target"
            style={styles.twoPointerTarget}
            testID="two-pointer-pan-target"
          />
        </GestureDetector>
      </View>

      <View style={styles.metrics} testID="gesture-metrics">
        <Text style={styles.metric} testID="gesture-canary-ready">
          gesture canary {canaryReady ? 'ready' : 'preparing'}
        </Text>
        <Text style={styles.metric} testID="gesture-transform-status">
          {statusLabel}
        </Text>
        <Text style={styles.metric} testID="gesture-fling-status">
          fling {counts.fling}
        </Text>
        <Text style={styles.metric} testID="gesture-two-pointer-pan-status">
          two-pointer pan activations {counts.twoPointerPan}
        </Text>
        <Text style={styles.metric} testID="gesture-change-status">
          {changeStatusLabel}
        </Text>
      </View>
    </SectionCard>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizedRadians(value: number): number {
  if (value > Math.PI) return value - Math.PI * 2;
  if (value < -Math.PI) return value + Math.PI * 2;
  return value;
}
