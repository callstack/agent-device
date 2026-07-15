#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerSynthesizedGesture : NSObject

+ (NSString * _Nullable)synthesizeSwipeWithApplication:(id)application
                                                    x:(double)x
                                                    y:(double)y
                                                   x2:(double)x2
                                                   y2:(double)y2
                                            durationMs:(double)durationMs;

+ (NSString * _Nullable)synthesizeContinuousDragWithApplication:(id)application
                                                             x:(double)x
                                                             y:(double)y
                                                            x2:(double)x2
                                                            y2:(double)y2
                                                     durationMs:(double)durationMs;

+ (NSString * _Nullable)synthesizeTapWithApplication:(id)application
                                                   x:(double)x
                                                   y:(double)y;

// Each pointer is an ordered array of { x, y, offsetMs } samples. The first sample
// starts contact; subsequent samples move it; all pointers lift at their final offset.
+ (NSString * _Nullable)synthesizeGestureWithApplication:(id)application
                                          pointerSamples:(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *)pointerSamples;

// UIInterfaceOrientation of the app (1 portrait, 2 upsideDown, 3 landscapeRight,
// 4 landscapeLeft), or 0 if unreadable.
+ (NSInteger)interfaceOrientationForApplication:(id)application;

@end

NS_ASSUME_NONNULL_END
