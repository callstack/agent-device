#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerSynthesizedGesture : NSObject

+ (NSString * _Nullable)synthesizeTransformWithApplication:(id)application
                                                         x:(double)x
                                                         y:(double)y
                                                        dx:(double)dx
                                                        dy:(double)dy
                                                     scale:(double)scale
                                                   degrees:(double)degrees
                                                    radius:(double)radius
                                                durationMs:(double)durationMs;

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

// UIInterfaceOrientation of the app (1 portrait, 2 upsideDown, 3 landscapeRight,
// 4 landscapeLeft), or 0 if unreadable.
+ (NSInteger)interfaceOrientationForApplication:(id)application;

@end

NS_ASSUME_NONNULL_END
