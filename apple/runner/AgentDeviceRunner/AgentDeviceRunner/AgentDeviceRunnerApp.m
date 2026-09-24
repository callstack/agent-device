#import <TargetConditionals.h>

#if TARGET_OS_OSX
#import <Cocoa/Cocoa.h>

@interface AgentDeviceRunnerAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  NSRect frame = NSMakeRect(0, 0, 360, 220);
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                       NSWindowStyleMaskMiniaturizable)
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"Agent Device Runner";

  NSTextField *label = [NSTextField labelWithString:@"Agent Device Runner"];
  label.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
  label.translatesAutoresizingMaskIntoConstraints = NO;

  NSView *contentView = [[NSView alloc] initWithFrame:frame];
  [contentView addSubview:label];
  self.window.contentView = contentView;

  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:contentView.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:contentView.centerYAnchor],
  ]];

  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    AgentDeviceRunnerAppDelegate *delegate = [[AgentDeviceRunnerAppDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }

  return 0;
}

#else
#import <UIKit/UIKit.h>
#if TARGET_OS_IOS
#import <UserNotifications/UserNotifications.h>
#endif

@interface AgentDeviceRunnerViewController : UIViewController
@property(nonatomic, strong) UILabel *alertActionStatus;
@property(nonatomic, strong) UILabel *alertActivationBusyAnswer;
@property(nonatomic, assign) NSUInteger firstAlertActions;
@property(nonatomic, assign) NSUInteger replacementAlertActions;
@property(nonatomic, assign) BOOL alertFixtureStarted;
@property(nonatomic, strong) NSTimer *alertActivationBusyBackstop;
@property(nonatomic, strong) NSTimer *alertBannerRepost;
@end

#if TARGET_OS_IOS
@interface AgentDeviceRunnerViewController () <UNUserNotificationCenterDelegate>
@end
#endif

@implementation AgentDeviceRunnerViewController

#if TARGET_OS_IOS
// An animation that never ends is what "busy" looks like to XCTest while it decides whether the app
// may receive an event: the app keeps reporting work in flight, which is the state that cost an alert
// command its whole deadline in #2546. It stops the moment an alert button is answered, since that
// answer is the event the runner is trying to land, and the backstop stops it even when no answer
// arrives so a regressed run finishes rather than waiting out XCTest's own timeout. The test passes
// the backstop after `--agent-device-alert-activation-busy`, sized to outlast its whole resolution
// and activation budget, so a slow host cannot end the busy state before the answer lands. A layer
// animation on its own is not enough; only a UIView animation counts as in-flight work here.
static NSTimeInterval AgentDeviceAlertActivationBusyWindow(void) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger flag = [arguments indexOfObject:@"--agent-device-alert-activation-busy"];
  return flag + 1 < arguments.count ? arguments[flag + 1].doubleValue : 0;
}

- (void)startAlertActivationBusy {
  if (self.alertActivationBusyBackstop != nil) {
    return;
  }
  self.alertActivationBusyBackstop = [NSTimer scheduledTimerWithTimeInterval:AgentDeviceAlertActivationBusyWindow()
                                                                      target:self
                                                                    selector:@selector(stopAlertActivationBusy)
                                                                    userInfo:nil
                                                                     repeats:NO];
  [UIView animateWithDuration:0.4
                          delay:0
                        options:(UIViewAnimationOptionRepeat | UIViewAnimationOptionAutoreverse)
                     animations:^{
                       self.alertActionStatus.transform = CGAffineTransformMakeTranslation(0, 8);
                     }
                     completion:nil];
}

- (void)stopAlertActivationBusy {
  [self.alertActionStatus.layer removeAllAnimations];
  self.alertActionStatus.transform = CGAffineTransformIdentity;
  [self.alertActivationBusyBackstop invalidate];
  self.alertActivationBusyBackstop = nil;
}

// A banner from this app, shown over its own alert and re-posted before the previous one expires so
// one is on screen for as long as the first alert is unanswered. XCTest treats such a banner as an
// interruption of every event aimed at the app (#2546's late tap, from the banner side).
- (void)startAlertBannerThen:(dispatch_block_t)presentAlert {
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  center.delegate = self;
  [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                        completionHandler:^(BOOL granted, NSError *error) {
                          (void)error;
                          if (!granted) {
                            return;
                          }
                          dispatch_async(dispatch_get_main_queue(), ^{
                            presentAlert();
                            [self postAlertBanner];
                            self.alertBannerRepost = [NSTimer scheduledTimerWithTimeInterval:2.0
                                                                                      target:self
                                                                                    selector:@selector(postAlertBanner)
                                                                                    userInfo:nil
                                                                                     repeats:YES];
                          });
                        }];
}

- (void)postAlertBanner {
  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = @"Agent Device banner";
  content.body = @"Shown over the alert fixture";
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString
                                                                        content:content
                                                                        trigger:nil];
  [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:nil];
}

- (void)stopAlertBanner {
  if (self.alertBannerRepost == nil) {
    return;
  }
  [self.alertBannerRepost invalidate];
  self.alertBannerRepost = nil;
  [UNUserNotificationCenter.currentNotificationCenter removeAllDeliveredNotifications];
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
  (void)center;
  (void)notification;
  completionHandler(UNNotificationPresentationOptionBanner);
}


- (void)updateAlertActionStatus {
  self.alertActionStatus.text = [NSString stringWithFormat:@"First actions: %lu; replacement actions: %lu",
                                                         (unsigned long)self.firstAlertActions,
                                                         (unsigned long)self.replacementAlertActions];
}

- (void)presentAlertFixtureReplacement:(BOOL)replacement {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  BOOL sameTitle = [arguments containsObject:@"--agent-device-alert-same-title"];
  BOOL sameBody = [arguments containsObject:@"--agent-device-alert-same-body"];
  NSString *title = replacement && !sameTitle ? @"Next confirmation" : @"First confirmation";
  NSString *body = replacement && !sameBody ? @"Second request" : @"First request";
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:title
                                                               message:body
                                                        preferredStyle:UIAlertControllerStyleAlert];
  __weak UIAlertController *weakAlert = alert;
  for (NSString *buttonTitle in @[@"Cancel", @"OK"]) {
    UIAlertActionStyle style = [buttonTitle isEqualToString:@"Cancel"]
        ? UIAlertActionStyleCancel : UIAlertActionStyleDefault;
    [alert addAction:[UIAlertAction actionWithTitle:buttonTitle style:style handler:^(UIAlertAction *action) {
      (void)action;
      if (!replacement) {
        self.alertActivationBusyAnswer.text = self.alertActivationBusyBackstop != nil
            ? @"Answered while busy" : @"Answered after the app went idle";
      }
      [self stopAlertActivationBusy];
      [self stopAlertBanner];
      if (replacement) {
        self.replacementAlertActions += 1;
      } else {
        self.firstAlertActions += 1;
      }
      [self updateAlertActionStatus];
      if (!replacement) {
        [weakAlert dismissViewControllerAnimated:NO completion:^{
          [self presentAlertFixtureReplacement:YES];
        }];
      }
    }]];
  }
  [self presentViewController:alert animated:NO completion:nil];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if (!self.alertFixtureStarted &&
      [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-replacement-regression"]) {
    self.alertFixtureStarted = YES;
    dispatch_block_t presentAlert = ^{
      [self presentAlertFixtureReplacement:NO];
      if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-activation-busy"]) {
        [self startAlertActivationBusy];
      }
    };
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-banner"]) {
      [self startAlertBannerThen:presentAlert];
    } else {
      presentAlert();
    }
  }
}
#endif

- (void)agentDeviceTextEntryDidChange:(UITextField *)textField {
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-disappear-after-input"] &&
      textField.text.length > 0) {
    [textField removeFromSuperview];
  }
}

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = UIColor.whiteColor;

  UILabel *label = [[UILabel alloc] init];
  label.text = @"Agent Device Runner";
  label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  label.textAlignment = NSTextAlignmentCenter;
  label.translatesAutoresizingMaskIntoConstraints = NO;

  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];

  // Keep the fixture behind a launch argument so normal runner snapshots remain unchanged.
#if TARGET_OS_IOS
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-replacement-regression"]) {
    self.alertActionStatus = label;
    label.accessibilityIdentifier = @"agent-device-alert-actions";
    [self updateAlertActionStatus];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-activation-busy"]) {
    UILabel *busyAnswer = [[UILabel alloc] init];
    busyAnswer.text = @"Unanswered";
    busyAnswer.accessibilityIdentifier = @"agent-device-alert-busy-answer";
    busyAnswer.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:busyAnswer];
    [NSLayoutConstraint activateConstraints:@[
      [busyAnswer.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [busyAnswer.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
    ]];
    self.alertActivationBusyAnswer = busyAnswer;
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-regression"]) {
    UITextField *textField = [[UITextField alloc] init];
    textField.accessibilityIdentifier = @"agent-device-hardware-keyboard-input";
    textField.borderStyle = UITextBorderStyleRoundedRect;
    textField.inputView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
    [textField addTarget:self
                  action:@selector(agentDeviceTextEntryDidChange:)
        forControlEvents:UIControlEventEditingChanged];
    textField.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:textField];
    [NSLayoutConstraint activateConstraints:@[
      [textField.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [textField.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
      [textField.widthAnchor constraintEqualToConstant:240],
      [textField.heightAnchor constraintEqualToConstant:44],
    ]];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-selector-read-regression"]) {
    NSString *const duplicateIdentifier = @"agent-device-selector-read-duplicate";

    UIButton *visibleButton = [UIButton buttonWithType:UIButtonTypeSystem];
    visibleButton.accessibilityIdentifier = duplicateIdentifier;
    [visibleButton setTitle:@"Readable target" forState:UIControlStateNormal];
    visibleButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:visibleButton];

    UILabel *offscreenLabel = [[UILabel alloc] initWithFrame:CGRectMake(-200, -200, 100, 40)];
    offscreenLabel.accessibilityIdentifier = duplicateIdentifier;
    offscreenLabel.text = @"Decorative duplicate";
    [self.view addSubview:offscreenLabel];

    [NSLayoutConstraint activateConstraints:@[
      [visibleButton.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [visibleButton.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
    ]];
  }
#endif
}

@end

// UIApplicationSceneManifest in Info.plist names this class; a rename must update the manifest.
@interface AgentDeviceRunnerSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AgentDeviceRunnerSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  (void)session;
  (void)connectionOptions;

  if (![scene isKindOfClass:UIWindowScene.class]) {
    return;
  }

  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[AgentDeviceRunnerViewController alloc] init];
  [self.window makeKeyAndVisible];
}

@end

@interface AgentDeviceRunnerAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AgentDeviceRunnerAppDelegate
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AgentDeviceRunnerAppDelegate.class));
  }
}

#endif
