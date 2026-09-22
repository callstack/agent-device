#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSInteger RunnerContinuousDragFrameCount(double durationMs);
FOUNDATION_EXPORT NSInteger RunnerControlledScrollFrameCount(double durationMs);
FOUNDATION_EXPORT double RunnerControlledScrollProgress(double t);

@interface RunnerSynthesizedGesture : NSObject

// `resolvedWindow` is the app window the caller already resolved for the gesture's reference
// frame. The record's display ID is read from that same window so geometry and routing can never
// name different windows; pass nil to fall back to the application's first window.
+ (NSString * _Nullable)synthesizeSwipeWithApplication:(id)application
                                        resolvedWindow:(id _Nullable)resolvedWindow
                                                    x:(double)x
                                                    y:(double)y
                                                   x2:(double)x2
                                                   y2:(double)y2
                                            durationMs:(double)durationMs;

+ (NSString * _Nullable)synthesizeContinuousDragWithApplication:(id)application
                                                resolvedWindow:(id _Nullable)resolvedWindow
                                                             x:(double)x
                                                             y:(double)y
                                                            x2:(double)x2
                                                            y2:(double)y2
                                                     durationMs:(double)durationMs;

+ (NSString * _Nullable)synthesizeControlledScrollWithApplication:(id)application
                                                 resolvedWindow:(id _Nullable)resolvedWindow
                                                                x:(double)x
                                                                y:(double)y
                                                               x2:(double)x2
                                                               y2:(double)y2
                                                        durationMs:(double)durationMs;

+ (NSString * _Nullable)synthesizeTapWithApplication:(id)application
                                      resolvedWindow:(id _Nullable)resolvedWindow
                                                   x:(double)x
                                                   y:(double)y;

// Each pointer is an ordered array of { x, y, offsetMs } samples. The first sample
// starts contact; subsequent samples move it; all pointers lift at their final offset.
+ (NSString * _Nullable)synthesizeGestureWithApplication:(id)application
                                          resolvedWindow:(id _Nullable)resolvedWindow
                                          pointerSamples:(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *)pointerSamples;

// UIInterfaceOrientation of the app (1 portrait, 2 upsideDown, 3 landscapeRight,
// 4 landscapeLeft), or 0 if unreadable.
+ (NSInteger)interfaceOrientationForApplication:(id)application;

@end

NS_ASSUME_NONNULL_END
