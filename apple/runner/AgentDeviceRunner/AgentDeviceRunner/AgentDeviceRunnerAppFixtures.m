// The fixture host for the runner's unit-test build. Compiled only under
// AGENT_DEVICE_RUNNER_UNIT_TESTS (the -D flag AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS
// adds) and dropped from the npm package by scripts/package-apple-runner-source.mjs,
// so the host app a user builds carries no `--agent-device-*` fixture screen. The
// UnitTests/ suites reach this class through the host's
// +agentDeviceRootViewControllerClass lookup in AgentDeviceRunnerApp.m; a rename here
// must update that lookup.
#import <TargetConditionals.h>

#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
#import "AgentDeviceRunnerApp.h"
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import "UnitTests/AgentDeviceTextEntryFields.h"

// Mirrors the App Tracking Transparency prompt's real button order: the affirmative button is
// last (#3627). The answer label records which button the app actually took, so a test asserts
// the app's answer instead of the command's own report. `--agent-device-alert-affirmative-only`
// shows the same alert with no decline button at all.
static UIAlertController *RunnerAlertDeclineChoiceFixture(BOOL affirmativeOnly, UILabel *answer) {
  UIAlertController *alert = [UIAlertController
    alertControllerWithTitle:@"“Runner” Would Like to Track Your Activity"
                     message:@"Track your activity across other companies' apps and websites."
              preferredStyle:UIAlertControllerStyleAlert];
  NSArray<NSArray *> *buttons = affirmativeOnly
      ? @[ @[@"Allow", @"Authorized"], @[@"OK", @"Authorized"] ]
      : @[ @[@"Ask App Not to Track", @"Declined"], @[@"Allow", @"Authorized"] ];
  for (NSArray *button in buttons) {
    [alert addAction:[UIAlertAction actionWithTitle:button[0]
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
                                              (void)action;
                                              answer.text = button[1];
                                            }]];
  }
  return alert;
}

@interface AgentDeviceRunnerFixtureViewController : AgentDeviceRunnerViewController
@end

// A real navigation stack for `back`. `--agent-device-back-navigation-bar` pushes a detail screen,
// so the bar shows UIKit's system back button; the interactive pop is off, so only that button can
// pop it. `--blocked-back` keeps that button but replaces its action, so pressing it navigates
// nowhere. `--shifting-back` makes that press move the bar down instead, so the back button moves
// without any navigation. `--ticking-title` counts the detail screen's title down every 0.2 s, as a timer does,
// so its bar changes without any navigation. `--custom-back-item` instead puts a bar button titled
// "Back" on the root, which is not the system back button and must never be pressed. The root's
// label reports what happened.
@interface AgentDeviceBackNavigationFixture : UINavigationController <UINavigationControllerDelegate>
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) NSTimer *titleTimer;
@end

@implementation AgentDeviceBackNavigationFixture
- (instancetype)initWithCustomBackItem:(BOOL)customBackItem blockedBack:(BOOL)blockedBack {
  UIViewController *root = [UIViewController new];
  root.title = @"Root";
  root.view.backgroundColor = UIColor.systemBackgroundColor;
  self = [super initWithRootViewController:root];
  if (!self) return nil;
  UILabel *status = [UILabel new];
  status.text = @"Navigation root";
  status.accessibilityIdentifier = @"agent-device-back-navigation-status";
  status.translatesAutoresizingMaskIntoConstraints = NO;
  [root.view addSubview:status];
  [NSLayoutConstraint activateConstraints:@[
    [status.centerXAnchor constraintEqualToAnchor:root.view.centerXAnchor],
    [status.centerYAnchor constraintEqualToAnchor:root.view.centerYAnchor],
  ]];
  self.status = status;
  self.modalPresentationStyle = UIModalPresentationFullScreen;
  if (customBackItem) {
    root.navigationItem.leftBarButtonItem =
        [[UIBarButtonItem alloc] initWithTitle:@"Back" style:UIBarButtonItemStylePlain target:self
                                        action:@selector(customBackPressed)];
  } else {
    UIViewController *detail = [UIViewController new];
    detail.title = @"Detail";
    detail.view.backgroundColor = UIColor.systemTealColor;
    if (blockedBack) {
      if (@available(iOS 16.0, *)) {
        BOOL shifting = [NSProcessInfo.processInfo.arguments containsObject:@"--shifting-back"];
        __weak UINavigationController *weakSelf = self;
        detail.navigationItem.backAction = [UIAction actionWithHandler:^(__kindof UIAction *action) {
          if (shifting) weakSelf.additionalSafeAreaInsets = UIEdgeInsetsMake(30, 0, 0, 0);
        }];
      }
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--ticking-title"]) {
      __block NSInteger remaining = 59;
      __weak UIViewController *weakDetail = detail;
      self.titleTimer = [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
        remaining = remaining > 0 ? remaining - 1 : 59;
        weakDetail.title = [NSString stringWithFormat:@"0:%02ld", (long)remaining];
      }];
    }
    [self pushViewController:detail animated:NO];
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.interactivePopGestureRecognizer.enabled = NO;
  self.delegate = self;
}

- (void)customBackPressed {
  self.status.text = @"Custom back pressed";
}

- (void)navigationController:(UINavigationController *)navigationController
       didShowViewController:(UIViewController *)viewController
                    animated:(BOOL)animated {
  // Only the pushed stack ever shows its root again, and only by popping the detail screen.
  if (viewController == self.viewControllers.firstObject && viewController.navigationItem.leftBarButtonItem == nil) {
    self.status.text = @"Back pressed";
  }
}
@end

// `--two-stacks` shows two pushed navigation stacks, one above the other, so two hittable system
// back buttons are on screen at once and neither is the one `back` should press.
@interface AgentDeviceTwoStacksBackFixture : UIViewController
@end

@implementation AgentDeviceTwoStacksBackFixture
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  UIStackView *stack = [UIStackView new];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.distribution = UIStackViewDistributionFillEqually;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
    [stack.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
  ]];
  for (NSInteger index = 0; index < 2; index++) {
    AgentDeviceBackNavigationFixture *child = [[AgentDeviceBackNavigationFixture alloc] initWithCustomBackItem:NO
                                                                                                  blockedBack:NO];
    [self addChildViewController:child];
    [stack addArrangedSubview:child.view];
    [child didMoveToParentViewController:self];
  }
}
@end

@interface AgentDeviceRunnerFixtureViewController () <UNUserNotificationCenterDelegate>
// Held for the app's lifetime: a window nobody retained would be gone before the test queried it.
@property(nonatomic, strong) UIWindow *secondWindow;
@property(nonatomic, strong) UILabel *navigationBackStatus;
@property(nonatomic, strong) NSTimer *animationTimer;
@property(nonatomic, strong) UILabel *maskedToggleStatus;
@property(nonatomic, strong) UILabel *maskedDeliveryStatus;
@property(nonatomic, strong) UILabel *maskedTextLengthStatus;
@property(nonatomic, assign) NSUInteger maskedTogglePresses;
@property(nonatomic, strong) UILabel *alertActionStatus;
@property(nonatomic, strong) UILabel *alertActivationBusyAnswer;
@property(nonatomic, strong) UILabel *alertDeclineAnswer;
@property(nonatomic, assign) NSUInteger firstAlertActions;
@property(nonatomic, assign) NSUInteger replacementAlertActions;
@property(nonatomic, strong) UILabel *textEntryWriteBackStatus;
@property(nonatomic, strong) UILabel *textEntryDigitSlots;
// Counts presses a gesture landed on a control that is not a text input, so a test can tell a
// refusal that ran nothing from one that dispatched its gesture first and refused afterwards.
@property(nonatomic, strong) UILabel *tapWitnessStatus;
@property(nonatomic, assign) NSUInteger tapWitnessPresses;
// Filled from the fixture field's own delegate callbacks so a test can tell that a gesture really
// took focus from an input that has stopped answering the accessibility query that found it.
@property(nonatomic, strong) UILabel *textEntryFocusWitness;
@property(nonatomic, assign) NSUInteger textEntryWriteBacks;
@property(nonatomic, assign) NSUInteger textEntryTotalEdits;
@property(nonatomic, copy, nullable) NSString *textEntryRenderedValue;
@property(nonatomic, assign) NSTimeInterval textEntryLastEditTime;
@property(nonatomic, assign) NSTimeInterval textEntryBurstStartTime;
@property(nonatomic, assign) NSUInteger textEntryBurstEdits;
@property(nonatomic, assign) NSTimeInterval textEntryBurstMinGap;
@property(nonatomic, assign) NSTimeInterval textEntryAcknowledgeWindowSeconds;
@property(nonatomic, strong) NSLayoutConstraint *textEntryFieldTop;
@property(nonatomic, weak) UITextField *textEntryField;
@property(nonatomic, assign) BOOL alertFixtureStarted;
@property(nonatomic, strong) NSTimer *alertActivationBusyBackstop;
@property(nonatomic, strong) NSTimer *alertBannerRepost;
@property(nonatomic, weak) UITextField *keyboardBusyField;
@property(nonatomic, strong) UILabel *keyboardBusyAnswer;
@property(nonatomic, strong) NSTimer *keyboardBusyBackstop;
@end

// A one-time-code field that announces how many digits it holds instead of the digits, the way
// React Native OTP inputs set `accessibilityValue` on their hidden text input.
@interface AgentDeviceDigitCountTextField : UITextField
@end

@implementation AgentDeviceDigitCountTextField
- (NSString *)accessibilityValue {
  return [NSString stringWithFormat:@"%lu of 6 digits", (unsigned long)self.text.length];
}
@end

// A field that reformats its own text on every edit into `## ### ## ##` digit groups, the way a
// digit-grouping formatter in a Flutter or React Native input does. The accessibility value is
// what the user sees — the formatted string — so it never equals the digits a `fill` sent (#2634).
// The field owns the delegate it installs, keeping the formatter out of the view controller's
// own delegate callbacks.
@interface AgentDeviceDigitGroupingTextField : UITextField <UITextFieldDelegate>
@end

@interface AgentDeviceCurrencyTextField : UITextField <UITextFieldDelegate>
@property(nonatomic, strong) UILabel *entryStatus;
@property(nonatomic, assign) NSUInteger insertedDigits;
@end

@interface AgentDeviceSubmitClearingTextField : UITextField <UITextFieldDelegate>
@property(nonatomic, strong) UILabel *entryStatus;
@property(nonatomic, assign) NSUInteger submits;
@end

static NSString *AgentDeviceFormatGroupedDigits(NSString *raw) {
  NSMutableString *digits = [NSMutableString string];
  NSCharacterSet *nonDigits = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
  for (NSString *chunk in [raw componentsSeparatedByCharactersInSet:nonDigits]) {
    [digits appendString:chunk];
  }
  NSMutableArray<NSNumber *> *groupWidths = [NSMutableArray arrayWithArray:@[@2, @3, @2, @2]];
  NSMutableString *formatted = [NSMutableString string];
  NSUInteger cursor = 0;
  for (NSNumber *width in groupWidths) {
    if (cursor >= digits.length) {
      break;
    }
    if (formatted.length > 0) {
      [formatted appendString:@" "];
    }
    NSUInteger end = MIN(cursor + width.unsignedIntegerValue, digits.length);
    [formatted appendString:[digits substringWithRange:NSMakeRange(cursor, end - cursor)]];
    cursor = end;
  }
  // Digits past the last group keep grouping by threes rather than vanishing from the field.
  while (cursor < digits.length) {
    NSUInteger end = MIN(cursor + 3, digits.length);
    [formatted appendString:[NSString stringWithFormat:@" %@", [digits substringWithRange:NSMakeRange(cursor, end - cursor)]]];
    cursor = end;
  }
  return formatted;
}

static NSUInteger AgentDeviceDigitCount(NSString *text, NSUInteger limit) {
  NSUInteger count = 0;
  for (NSUInteger index = 0; index < limit && index < text.length; index++) {
    if ([NSCharacterSet.decimalDigitCharacterSet characterIsMember:[text characterAtIndex:index]]) {
      count += 1;
    }
  }
  return count;
}

@implementation AgentDeviceDigitGroupingTextField
- (BOOL)textField:(UITextField *)textField
      shouldChangeCharactersInRange:(NSRange)range
               replacementString:(NSString *)string {
  NSString *combined = [textField.text stringByReplacingCharactersInRange:range withString:string];
  NSString *formatted = AgentDeviceFormatGroupedDigits(combined);
  textField.text = formatted;
  // Assigning `text` drops the caret at the end, which a real grouping formatter does not do:
  // a mid-string edit must keep editing where the user put the caret. The digits before the
  // caret survive the reformat unchanged, so the caret belongs before the digit that follows
  // them — past the separators the grouping inserted behind them — and at the end when it
  // followed all of them. Typed digits count as before the caret; a delete does not move it.
  NSUInteger digitsBeforeCaret =
      AgentDeviceDigitCount(textField.text, range.location) + AgentDeviceDigitCount(string, string.length);
  NSUInteger caretOffset = formatted.length;
  NSUInteger seen = 0;
  for (NSUInteger index = 0; index < formatted.length; index++) {
    if (![NSCharacterSet.decimalDigitCharacterSet characterIsMember:[formatted characterAtIndex:index]]) {
      continue;
    }
    seen += 1;
    if (seen == digitsBeforeCaret + 1) {
      caretOffset = index;
      break;
    }
  }
  textField.selectedTextRange = [textField textRangeFromPosition:[textField positionFromPosition:textField.beginningOfDocument offset:caretOffset]
                                                      toPosition:[textField positionFromPosition:textField.beginningOfDocument offset:caretOffset]];
  return NO;
}
@end

@implementation AgentDeviceCurrencyTextField
- (BOOL)textField:(UITextField *)textField
      shouldChangeCharactersInRange:(NSRange)range
               replacementString:(NSString *)string {
  NSString *combined = [textField.text stringByReplacingCharactersInRange:range withString:string];
  NSMutableString *digits = [NSMutableString string];
  for (NSString *part in [combined componentsSeparatedByCharactersInSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet]) {
    [digits appendString:part];
  }
  unsigned long long cents = digits.longLongValue;
  textField.text = [NSString stringWithFormat:@"$%llu.%02llu", cents / 100, cents % 100];
  self.insertedDigits += AgentDeviceDigitCount(string, string.length);
  self.entryStatus.text = [NSString stringWithFormat:@"%lu", (unsigned long)self.insertedDigits];
  textField.selectedTextRange = [textField textRangeFromPosition:textField.endOfDocument toPosition:textField.endOfDocument];
  return NO;
}
@end

@implementation AgentDeviceSubmitClearingTextField
- (BOOL)textFieldShouldReturn:(UITextField *)textField {
  self.submits += 1;
  self.entryStatus.text = [NSString stringWithFormat:@"%lu", (unsigned long)self.submits];
  textField.text = @"";
  return YES;
}
@end

@implementation AgentDeviceRunnerFixtureViewController

// `--hide-status-bar` stands in for a landscape iPhone, full-screen video, or an RN screen that hides
// its status bar.
- (BOOL)prefersStatusBarHidden {
  return [NSProcessInfo.processInfo.arguments containsObject:@"--hide-status-bar"];
}

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

// The keyboard counterpart of the busy alert: the field starts the same never-ending UIView animation
// when it takes focus, so XCTest sees work in flight for as long as the keyboard is up. Its Done
// accessory and its return key record whether they landed while the app was still busy. The backstop
// passed after `--agent-device-keyboard-busy` ends the busy state, so a command that waits for the app
// to idle before it taps still finishes, and records "after busy" instead of outlasting the test.
static NSTimeInterval AgentDeviceKeyboardBusyWindow(void) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger flag = [arguments indexOfObject:@"--agent-device-keyboard-busy"];
  return flag + 1 < arguments.count ? arguments[flag + 1].doubleValue : 0;
}

- (void)startKeyboardBusy {
  if (self.keyboardBusyBackstop != nil) {
    return;
  }
  self.keyboardBusyBackstop = [NSTimer scheduledTimerWithTimeInterval:AgentDeviceKeyboardBusyWindow()
                                                               target:self
                                                             selector:@selector(stopKeyboardBusy)
                                                             userInfo:nil
                                                              repeats:NO];
  [UIView animateWithDuration:0.4
                          delay:0
                        options:(UIViewAnimationOptionRepeat | UIViewAnimationOptionAutoreverse)
                     animations:^{
                       self.keyboardBusyAnswer.transform = CGAffineTransformMakeTranslation(0, 8);
                     }
                     completion:nil];
}

- (void)stopKeyboardBusy {
  [self.keyboardBusyAnswer.layer removeAllAnimations];
  self.keyboardBusyAnswer.transform = CGAffineTransformIdentity;
  [self.keyboardBusyBackstop invalidate];
  self.keyboardBusyBackstop = nil;
}

- (void)recordKeyboardBusyAnswer:(NSString *)control {
  self.keyboardBusyAnswer.text = [NSString
      stringWithFormat:@"%@ %@", control, self.keyboardBusyBackstop != nil ? @"while busy" : @"after busy"];
  [self stopKeyboardBusy];
  [self.keyboardBusyField resignFirstResponder];
}

- (void)keyboardBusyDonePressed {
  [self recordKeyboardBusyAnswer:@"Done"];
}

- (void)keyboardBusyReturnPressed {
  [self recordKeyboardBusyAnswer:@"Return"];
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

- (void)updateTextEntryWriteBackStatus {
  NSTimeInterval burstSpan = self.textEntryLastEditTime - self.textEntryBurstStartTime;
  self.textEntryWriteBackStatus.text = [NSString
    stringWithFormat:@"write-backs=%lu burst-edits=%lu burst-ms=%lu min-gap-ms=%lu total-edits=%lu",
                     (unsigned long)self.textEntryWriteBacks,
                     (unsigned long)self.textEntryBurstEdits,
                     (unsigned long)llround(burstSpan * 1000),
                     (unsigned long)llround(self.textEntryBurstMinGap * 1000),
                     (unsigned long)self.textEntryTotalEdits];
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
    UIAlertAction *button = [UIAlertAction actionWithTitle:buttonTitle style:style handler:^(UIAlertAction *action) {
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
    }];
    button.enabled = ![arguments containsObject:@"--agent-device-alert-replacement-disabled-buttons"];
    [alert addAction:button];
  }
  [self presentViewController:alert animated:NO completion:nil];
}

- (void)presentAlertDeclineChoiceFixture {
  BOOL affirmativeOnly =
      [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-affirmative-only"];
  UIAlertController *alert = RunnerAlertDeclineChoiceFixture(affirmativeOnly, self.alertDeclineAnswer);
  [self presentViewController:alert animated:NO completion:nil];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if (!self.alertFixtureStarted &&
      [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-back-navigation-bar"]) {
    self.alertFixtureStarted = YES;
    BOOL customBackItem = [NSProcessInfo.processInfo.arguments containsObject:@"--custom-back-item"];
    BOOL blockedBack = [NSProcessInfo.processInfo.arguments containsObject:@"--blocked-back"];
    UIViewController *fixture = [NSProcessInfo.processInfo.arguments containsObject:@"--two-stacks"]
        ? [AgentDeviceTwoStacksBackFixture new]
        : [[AgentDeviceBackNavigationFixture alloc] initWithCustomBackItem:customBackItem blockedBack:blockedBack];
    fixture.modalPresentationStyle = UIModalPresentationFullScreen;
    [self presentViewController:fixture animated:NO completion:nil];
  }
  if (!self.alertFixtureStarted &&
      ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-decline-choice"] ||
       [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-affirmative-only"])) {
    self.alertFixtureStarted = YES;
    [self presentAlertDeclineChoiceFixture];
  }
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

// How fast an app that owns this field's value can acknowledge edits: one render per window, passed
// by the test as `--agent-device-text-entry-acknowledge-window <seconds>`. An edit that arrives
// inside that window overtook the render still in flight, so the value that render commits predates
// it and writing it erases the characters that got ahead of the app. The app then reads its own
// erasure back into its model, which is why the field stays wrong instead of healing when the burst
// finishes. The window is decided at the edit rather than scheduled, so a loaded host, which
// stretches the gaps between characters, can only make this app keep up better.
static NSTimeInterval AgentDeviceTextEntryAcknowledgeWindow(void) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger index = [arguments indexOfObject:@"--agent-device-text-entry-acknowledge-window"];
  return index == NSNotFound || index + 1 >= arguments.count ? 0 : [arguments[index + 1] doubleValue];
}

// Edits further apart than this belong to different bursts: one runner command's characters arrive
// well inside it, and two commands are separated by at least a commit-wait poll and a status read.
static const NSTimeInterval AgentDeviceTextEntryBurstBreakSeconds = 1.0;
static const NSUInteger AgentDeviceTextEntryAutoSubmitLength = 6;

static const CGFloat AgentDeviceTextEntryFieldTopInset = 24;
static const CGFloat AgentDeviceTextEntryFieldHeight = 44;
static const CGFloat AgentDeviceTextEntryNeighbourGap = 16;

- (void)agentDeviceTextEntryDidChange:(UITextField *)textField {
  if (self.maskedDeliveryStatus != nil) {
    self.maskedDeliveryStatus.text = [textField.text hasSuffix:@"not-a-secret-123"] ? @"delivered" : @"pending";
  }
  if (self.maskedTextLengthStatus != nil) {
    self.maskedTextLengthStatus.text = [NSString stringWithFormat:@"length=%lu", (unsigned long)textField.text.length];
  }
  // A field whose app owns its value, the way a controlled React Native `TextInput` does. A burst
  // typed faster than the app renders loses the characters that arrived while a render was in
  // flight, and the field settles stable short of the request.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-app-owned-value"]) {
    self.textEntryTotalEdits += 1;
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    NSTimeInterval gap = now - self.textEntryLastEditTime;
    BOOL overtookARender = self.textEntryRenderedValue != nil && gap < self.textEntryAcknowledgeWindowSeconds;
    if (self.textEntryBurstEdits == 0 || gap > AgentDeviceTextEntryBurstBreakSeconds) {
      self.textEntryBurstStartTime = now;
      self.textEntryBurstEdits = 0;
      self.textEntryBurstMinGap = 0;
    } else if (self.textEntryBurstEdits == 1 || gap < self.textEntryBurstMinGap) {
      self.textEntryBurstMinGap = gap;
    }
    self.textEntryBurstEdits += 1;
    self.textEntryLastEditTime = now;
    if (overtookARender) {
      if (![textField.text isEqualToString:self.textEntryRenderedValue]) {
        textField.text = self.textEntryRenderedValue;
        self.textEntryWriteBacks += 1;
      }
    } else {
      self.textEntryRenderedValue = [textField.text copy];
    }
    [self updateTextEntryWriteBackStatus];
  }
  self.textEntryDigitSlots.text = textField.text;
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-disappear-after-input"] &&
      textField.text.length > 0) {
    [textField removeFromSuperview];
  }
  // An auto-submitting one-time-code field: the last digit navigates away, to a screen whose own
  // input takes the code field's place or to one without an input. `replace-after-input` is the
  // same navigation landing before the code is complete, and `populated-successor` the same on any
  // edit, clearing included, to a screen whose input already holds a value.
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  BOOL codeComplete = textField.text.length >= AgentDeviceTextEntryAutoSubmitLength;
  if (textField.superview == nil) {
    return;
  }
  if ((codeComplete && [arguments containsObject:@"--agent-device-text-entry-auto-submit"]) ||
      (textField.text.length > 0 && [arguments containsObject:@"--agent-device-text-entry-replace-after-input"]) ||
      [arguments containsObject:@"--agent-device-text-entry-populated-successor"]) {
    [self replaceTextEntryFieldWithNextScreenInput:textField];
  } else if (codeComplete &&
             [arguments containsObject:@"--agent-device-text-entry-auto-submit-without-successor"]) {
    [textField removeFromSuperview];
  }
}

- (void)replaceTextEntryFieldWithNextScreenInput:(UITextField *)textField {
  UITextField *nextScreenField = [[UITextField alloc] initWithFrame:textField.frame];
  if (![NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-unnamed-input"]) {
    nextScreenField.accessibilityIdentifier = @"agent-device-auto-submit-next-screen-input";
  }
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-populated-successor"]) {
    nextScreenField.text = @"next screen value";
  }
  nextScreenField.borderStyle = UITextBorderStyleRoundedRect;
  [textField.superview addSubview:nextScreenField];
  [textField removeFromSuperview];
  [nextScreenField becomeFirstResponder];
}

// The same navigation as `replace-after-input`, landing when a test presses the button instead of on
// an edit, so the test decides which runner step it lands between.
- (void)agentDeviceTextEntryReplaceDidPress:(UIButton *)sender {
  (void)sender;
  if (self.textEntryField.superview != nil) {
    [self replaceTextEntryFieldWithNextScreenInput:self.textEntryField];
  }
}

// Stops answering the element-type query that found it, the moment it takes focus, under
// `--agent-device-text-entry-unqueryable-on-focus`. #3060's Flutter password field reaches this shape
// because its two accessibility channels disagree once focused — `TextField` through the legacy
// attributes, `Other` through the modern ones — and what either channel leaves behind is the same:
// the tap's element answers the query that resolved it up to the gesture and refuses it after, so a
// read of it after dispatching records an XCTest failure instead of describing the tap that already
// landed. The field keeps first-responder, so a test still needs a witness that is not the
// accessibility tree to tell the gesture landed: `agent-device-text-entry-focus` is a label this
// method fills in from the field's own delegate callback.
- (void)agentDeviceTextEntryBecomesUnqueryable:(UITextField *)textField {
  self.textEntryFocusWitness.text = @"focus";
  textField.hidden = YES;
}

// Moves the field up by its own height plus the gap below it when it gains focus, the way keyboard
// avoidance or a bottom sheet extending above the keyboard does, so the neighbouring field slides
// into the point the focus tap hit.
- (void)agentDeviceTextEntryDidBeginEditing:(UITextField *)textField {
  [self moveTextEntryFieldUp];
}

// Moves the field once text arrives, the way an iOS 26 bottom search bar rises above the keyboard
// on the first character: the focus tap and the pre-entry read both find it where it started.
- (void)agentDeviceTextEntryMovesOnInput:(UITextField *)textField {
  if (textField.text.length > 0) {
    [self moveTextEntryFieldUp];
  }
}

- (void)moveTextEntryFieldUp {
  self.textEntryFieldTop.constant =
      AgentDeviceTextEntryFieldTopInset - AgentDeviceTextEntryFieldHeight - AgentDeviceTextEntryNeighbourGap;
  [self.view layoutIfNeeded];
}

- (void)agentDeviceMaskedToggleDidPress:(UIButton *)sender {
  (void)sender;
  self.maskedTogglePresses += 1;
  [self updateMaskedToggleStatus];
}

- (void)agentDeviceTapWitnessDidPress:(UIButton *)sender {
  (void)sender;
  self.tapWitnessPresses += 1;
  [self updateTapWitnessStatus];
}

- (void)updateTapWitnessStatus {
  self.tapWitnessStatus.text =
      [NSString stringWithFormat:@"presses=%lu", (unsigned long)self.tapWitnessPresses];
}

- (void)updateMaskedToggleStatus {
  self.maskedToggleStatus.text =
      [NSString stringWithFormat:@"presses=%lu", (unsigned long)self.maskedTogglePresses];
}

- (void)navigationBackSwiped:(UIScreenEdgePanGestureRecognizer *)recognizer {
  if (recognizer.state == UIGestureRecognizerStateEnded) {
    // A back navigation redraws most of the screen, so the fixture repaints all of it too.
    self.view.backgroundColor = UIColor.systemTealColor;
    self.navigationBackStatus.text = @"Back performed";
  }
}

- (void)agentDeviceWillAttachToWindow:(UIWindow *)window {
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-dismiss-popup-window"]) {
    window.accessibilityIdentifier = @"Dismiss popup";
  }
  // A second window the app keeps visible, so `app.windows` reports the main window and this one.
  // Window order is what the resolver walks, and a candidate behind the answer must never be read.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-second-window"]) {
    UIWindow *second = [[UIWindow alloc] initWithWindowScene:window.windowScene];
    second.frame = window.windowScene.coordinateSpace.bounds;
    second.accessibilityIdentifier = @"agent-device-second-window";
    second.rootViewController = [UIViewController new];
    self.secondWindow = second;
    [second makeKeyAndVisible];
  }
}

- (void)viewDidLoad {
  [super viewDidLoad];

  UILabel *label = self.label;

  // Keep the fixture behind a launch argument so normal runner snapshots remain unchanged. A
  // left-edge pan stands in for UIKit's interactive pop: it begins only for an edge-masked touch.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-back-regression"]) {
    self.navigationBackStatus = label;
    label.accessibilityIdentifier = @"agent-device-back-status";
    UIScreenEdgePanGestureRecognizer *edgePan =
        [[UIScreenEdgePanGestureRecognizer alloc] initWithTarget:self action:@selector(navigationBackSwiped:)];
    edgePan.edges = UIRectEdgeLeft;
    [self.view addGestureRecognizer:edgePan];
    // `--animating` keeps the whole screen changing on its own, as a launch that is still rendering:
    // 16 bands take independent random shades, so no two samples of the screen match.
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--animating"]) {
      NSMutableArray<UIView *> *bands = [NSMutableArray array];
      CGRect bounds = self.view.bounds;
      for (NSUInteger index = 0; index < 16; index++) {
        UIView *band = [[UIView alloc] initWithFrame:CGRectMake(
            0, bounds.size.height * index / 16, bounds.size.width, bounds.size.height / 16)];
        band.autoresizingMask = UIViewAutoresizingFlexibleWidth;
        [self.view insertSubview:band atIndex:0];
        [bands addObject:band];
      }
      [self.animationTimer invalidate];
      self.animationTimer = [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {
        for (UIView *band in bands) {
          band.backgroundColor = [UIColor colorWithWhite:arc4random_uniform(256) / 255.0 alpha:1];
        }
      }];
    }
  }
  // `--slow-toggle` repaints the whole screen every 0.5 s, as a carousel does: a run of quiet samples
  // shorter than the back swipe's still span must not pass it for settled. Without
  // `--agent-device-back-regression` nothing answers the swipe, so only the repaint changes the screen.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--slow-toggle"]) {
    __weak UIView *view = self.view;
    [self.animationTimer invalidate];
    self.animationTimer = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
      view.backgroundColor = [view.backgroundColor isEqual:UIColor.blackColor] ? UIColor.whiteColor : UIColor.blackColor;
    }];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-replacement-regression"]) {
    self.alertActionStatus = label;
    label.accessibilityIdentifier = @"agent-device-alert-actions";
    [self updateAlertActionStatus];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-decline-choice"] ||
      [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-affirmative-only"]) {
    UILabel *declineAnswer = [[UILabel alloc] init];
    declineAnswer.text = @"Unanswered";
    declineAnswer.accessibilityIdentifier = @"agent-device-alert-decline-answer";
    declineAnswer.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:declineAnswer];
    [NSLayoutConstraint activateConstraints:@[
      [declineAnswer.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [declineAnswer.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
    ]];
    self.alertDeclineAnswer = declineAnswer;
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

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-keyboard-busy"]) {
    UITextField *field = [[UITextField alloc] init];
    field.accessibilityIdentifier = @"agent-device-keyboard-busy-input";
    field.placeholder = @"Busy while editing";
    field.borderStyle = UITextBorderStyleRoundedRect;
    UIToolbar *accessory = [[UIToolbar alloc] initWithFrame:CGRectMake(0, 0, 320, 44)];
    accessory.items = @[
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemFlexibleSpace target:nil action:nil],
      [[UIBarButtonItem alloc] initWithTitle:@"Done"
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(keyboardBusyDonePressed)],
    ];
    field.inputAccessoryView = accessory;
    [field addTarget:self action:@selector(startKeyboardBusy) forControlEvents:UIControlEventEditingDidBegin];
    [field addTarget:self
                  action:@selector(keyboardBusyReturnPressed)
        forControlEvents:UIControlEventEditingDidEndOnExit];
    field.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:field];
    UILabel *answer = [[UILabel alloc] init];
    answer.text = @"Unanswered";
    answer.accessibilityIdentifier = @"agent-device-keyboard-busy-answer";
    answer.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:answer];
    [NSLayoutConstraint activateConstraints:@[
      [field.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [field.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
      [field.widthAnchor constraintEqualToConstant:240],
      [field.heightAnchor constraintEqualToConstant:44],
      [answer.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [answer.topAnchor constraintEqualToAnchor:field.bottomAnchor constant:12],
    ]];
    self.keyboardBusyField = field;
    self.keyboardBusyAnswer = answer;
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-native-states"]) {
    for (NSUInteger index = 0; index < 3; index++) {
      UITextField *field = [[UITextField alloc] initWithFrame:CGRectMake(40, 120 + index * 60, 260, 44)];
      field.accessibilityIdentifier = @[@"native-field", @"native-secure", @"native-disabled"][index];
      field.placeholder = @"Native input";
      field.secureTextEntry = index == 1;
      field.enabled = index != 2;
      field.borderStyle = UITextBorderStyleRoundedRect;
      [self.view addSubview:field];
    }
    for (NSUInteger index = 0; index < 2; index++) {
      UISwitch *toggle = [[UISwitch alloc] initWithFrame:CGRectMake(40, 340 + index * 60, 60, 40)];
      toggle.accessibilityIdentifier = index == 0 ? @"native-off" : @"native-on";
      toggle.on = index == 1;
      [self.view addSubview:toggle];
    }
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-regression"]) {
    BOOL digitCountValue =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-digit-count-value"];
    BOOL digitGroupingValue =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-digit-grouping-value"];
    BOOL currencyValue =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-currency-value"];
    BOOL submitClears =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-submit-clears"];
    BOOL maskedValue =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-masked-value"];
    // A native secure field, which iOS clears on the first delete after it takes focus.
    BOOL secureEntry =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-secure-entry"];
    BOOL bulletPlaceholder =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-bullet-placeholder"];
    BOOL refusesFirstFocus =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-refuses-first-focus"];
    BOOL countsValueReads =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-counts-value-reads"];
    BOOL witnessesReplacement =
        [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-witness"];
    UITextField *textField;
    AgentDeviceSecureEntryField *secureField = nil;
    if (digitCountValue) {
      textField = [[AgentDeviceDigitCountTextField alloc] init];
    } else if (digitGroupingValue) {
      textField = [[AgentDeviceDigitGroupingTextField alloc] init];
    } else if (currencyValue) {
      textField = [[AgentDeviceCurrencyTextField alloc] init];
      textField.text = @"$0.00";
    } else if (submitClears) {
      textField = [[AgentDeviceSubmitClearingTextField alloc] init];
    } else if (maskedValue) {
      textField = [[AgentDeviceMaskedTextField alloc] init];
    } else if (secureEntry) {
      secureField = [[AgentDeviceSecureEntryField alloc] init];
      secureField.secureTextEntry = YES;
      secureField.reportsPlaceholderAsValue = bulletPlaceholder;
      secureField.refusesFirstFocus = refusesFirstFocus;
      textField = secureField;
    } else if (witnessesReplacement) {
      textField = [[AgentDeviceTextEntryWitnessField alloc] init];
    } else if (countsValueReads) {
      textField = [[AgentDeviceValueReadCountingTextField alloc] init];
    } else {
      textField = [[UITextField alloc] init];
    }
    if (digitGroupingValue || currencyValue || submitClears) {
      textField.delegate = (id<UITextFieldDelegate>)textField;
    }
    if (![NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-unnamed-input"]) {
      textField.accessibilityIdentifier = @"agent-device-hardware-keyboard-input";
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-long-prefill"]) {
      // Longer than one clear burst and far wider than the field, so its end is scrolled out of view.
      textField.text = [@"" stringByPaddingToLength:300 withString:@"stale long value " startingAtIndex:0];
    }
    textField.borderStyle = UITextBorderStyleRoundedRect;
    // An empty input view keeps the software keyboard down, which is the hardware-keyboard responder
    // these routes are addressed to. `--agent-device-text-entry-soft-keyboard` leaves the real input
    // view in place, so a lane test can reach the branch that requires a visible keyboard.
    if (![NSProcessInfo.processInfo.arguments
           containsObject:@"--agent-device-text-entry-soft-keyboard"]) {
      textField.inputView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
    }
    [textField addTarget:self
                  action:@selector(agentDeviceTextEntryDidChange:)
        forControlEvents:UIControlEventEditingChanged];
    textField.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:textField];
    self.textEntryField = textField;
    self.textEntryFieldTop = [textField.topAnchor constraintEqualToAnchor:label.bottomAnchor
                                                                 constant:AgentDeviceTextEntryFieldTopInset];
    [NSLayoutConstraint activateConstraints:@[
      [textField.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      self.textEntryFieldTop,
      [textField.widthAnchor constraintEqualToConstant:240],
      [textField.heightAnchor constraintEqualToConstant:AgentDeviceTextEntryFieldHeight],
    ]];
    if (countsValueReads || witnessesReplacement) {
      AgentDeviceValueReadCountLabel *valueReads = [[AgentDeviceValueReadCountLabel alloc] init];
      valueReads.countedField = textField;
      valueReads.accessibilityIdentifier = @"agent-device-text-entry-value-reads";
      valueReads.text = @"value reads";
      valueReads.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:valueReads];
      [NSLayoutConstraint activateConstraints:@[
        [valueReads.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [valueReads.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:12],
      ]];
    }
    if (currencyValue || submitClears) {
      UILabel *entryStatus = [[UILabel alloc] init];
      entryStatus.accessibilityIdentifier = @"agent-device-text-entry-events";
      entryStatus.text = @"0";
      entryStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:entryStatus];
      [NSLayoutConstraint activateConstraints:@[
        [entryStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [entryStatus.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:12],
      ]];
      if (currencyValue) {
        ((AgentDeviceCurrencyTextField *)textField).entryStatus = entryStatus;
      } else {
        ((AgentDeviceSubmitClearingTextField *)textField).entryStatus = entryStatus;
      }
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-tap-witness"]) {
      // A control that is not a text input, sitting below the field. Its press count is the only
      // witness a test has that a coordinate gesture reached this screen: a refusal that dispatched
      // its focus tap here would move the counter, and one that refused first would not.
      UIButton *witness = [UIButton buttonWithType:UIButtonTypeSystem];
      witness.accessibilityIdentifier = @"agent-device-tap-witness";
      [witness setTitle:@"Tap witness" forState:UIControlStateNormal];
      witness.translatesAutoresizingMaskIntoConstraints = NO;
      [witness addTarget:self
                  action:@selector(agentDeviceTapWitnessDidPress:)
        forControlEvents:UIControlEventTouchUpInside];
      [self.view addSubview:witness];
      self.tapWitnessStatus = [[UILabel alloc] init];
      self.tapWitnessStatus.accessibilityIdentifier = @"agent-device-tap-witness-presses";
      self.tapWitnessStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.tapWitnessStatus];
      [NSLayoutConstraint activateConstraints:@[
        [witness.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [witness.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:24],
        [witness.widthAnchor constraintEqualToConstant:200],
        [witness.heightAnchor constraintEqualToConstant:AgentDeviceTextEntryFieldHeight],
        [self.tapWitnessStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.tapWitnessStatus.topAnchor constraintEqualToAnchor:witness.bottomAnchor constant:12],
      ]];
      [self updateTapWitnessStatus];
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-replace-on-request"]) {
      // Above the title, so the software keyboard never covers it.
      UIButton *replace = [UIButton buttonWithType:UIButtonTypeSystem];
      replace.accessibilityIdentifier = @"agent-device-text-entry-replace";
      [replace setTitle:@"Replace input" forState:UIControlStateNormal];
      replace.translatesAutoresizingMaskIntoConstraints = NO;
      [replace addTarget:self
                  action:@selector(agentDeviceTextEntryReplaceDidPress:)
        forControlEvents:UIControlEventTouchUpInside];
      [self.view addSubview:replace];
      [NSLayoutConstraint activateConstraints:@[
        [replace.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [replace.bottomAnchor constraintEqualToAnchor:label.topAnchor constant:-24],
      ]];
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-unqueryable-on-focus"]) {
      self.textEntryFocusWitness = [[UILabel alloc] init];
      self.textEntryFocusWitness.accessibilityIdentifier = @"agent-device-text-entry-focus";
      self.textEntryFocusWitness.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.textEntryFocusWitness];
      [NSLayoutConstraint activateConstraints:@[
        [self.textEntryFocusWitness.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.textEntryFocusWitness.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:24],
      ]];
      [textField addTarget:self
                    action:@selector(agentDeviceTextEntryBecomesUnqueryable:)
          forControlEvents:UIControlEventEditingDidBegin];
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-moves-on-input"]) {
      [textField addTarget:self
                    action:@selector(agentDeviceTextEntryMovesOnInput:)
          forControlEvents:UIControlEventEditingChanged];
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-moves-on-focus"]) {
      textField.text = @"stale";
      [textField addTarget:self
                    action:@selector(agentDeviceTextEntryDidBeginEditing:)
          forControlEvents:UIControlEventEditingDidBegin];
      UITextField *neighbour = [[UITextField alloc] init];
      neighbour.accessibilityIdentifier = @"agent-device-text-entry-neighbour";
      neighbour.borderStyle = UITextBorderStyleRoundedRect;
      neighbour.text = @"neighbour";
      neighbour.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:neighbour];
      [NSLayoutConstraint activateConstraints:@[
        [neighbour.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [neighbour.topAnchor constraintEqualToAnchor:textField.bottomAnchor
                                            constant:AgentDeviceTextEntryNeighbourGap],
        [neighbour.widthAnchor constraintEqualToConstant:240],
        [neighbour.heightAnchor constraintEqualToConstant:AgentDeviceTextEntryFieldHeight],
      ]];
    }
    if (maskedValue || secureEntry) {
      if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-prefilled"]) {
        textField.text = @"stale-secret";
      }
      // While empty, the field then reads the same as one holding eight characters.
      if (bulletPlaceholder) {
        textField.placeholder = @"\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
      }
      // The show/hide toggle sits over the field's right edge, where the runner's caret edge-tap
      // lands. Counting its presses tells the test whether a repair reached for the field again.
      UIButton *toggle = [UIButton buttonWithType:UIButtonTypeSystem];
      toggle.accessibilityLabel = @"Show password";
      toggle.translatesAutoresizingMaskIntoConstraints = NO;
      [toggle addTarget:self
                 action:@selector(agentDeviceMaskedToggleDidPress:)
       forControlEvents:UIControlEventTouchUpInside];
      [self.view addSubview:toggle];
      self.maskedToggleStatus = [[UILabel alloc] init];
      self.maskedToggleStatus.accessibilityIdentifier = @"agent-device-masked-toggle-presses";
      self.maskedToggleStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.maskedToggleStatus];
      [NSLayoutConstraint activateConstraints:@[
        [toggle.trailingAnchor constraintEqualToAnchor:textField.trailingAnchor],
        [toggle.topAnchor constraintEqualToAnchor:textField.topAnchor],
        [toggle.bottomAnchor constraintEqualToAnchor:textField.bottomAnchor],
        [toggle.widthAnchor constraintEqualToConstant:48],
        [self.maskedToggleStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.maskedToggleStatus.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:12],
      ]];
      self.maskedDeliveryStatus = [[UILabel alloc] init];
      self.maskedDeliveryStatus.accessibilityIdentifier = @"agent-device-masked-delivery";
      self.maskedDeliveryStatus.text = @"pending";
      self.maskedDeliveryStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.maskedDeliveryStatus];
      [NSLayoutConstraint activateConstraints:@[
        [self.maskedDeliveryStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.maskedDeliveryStatus.topAnchor constraintEqualToAnchor:self.maskedToggleStatus.bottomAnchor constant:8],
      ]];
      // The text's length, which a mask hides: an empty field can show as many bullets as a full one.
      self.maskedTextLengthStatus = [[UILabel alloc] init];
      self.maskedTextLengthStatus.accessibilityIdentifier = @"agent-device-masked-text-length";
      self.maskedTextLengthStatus.text = [NSString stringWithFormat:@"length=%lu", (unsigned long)textField.text.length];
      self.maskedTextLengthStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.maskedTextLengthStatus];
      [NSLayoutConstraint activateConstraints:@[
        [self.maskedTextLengthStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.maskedTextLengthStatus.topAnchor constraintEqualToAnchor:self.maskedDeliveryStatus.bottomAnchor constant:8],
      ]];
      if (secureField) {
        UILabel *counts = [[UILabel alloc] init];
        counts.accessibilityIdentifier = @"agent-device-secure-entry-counts";
        counts.text = @"deletes=0 taps=0";
        counts.translatesAutoresizingMaskIntoConstraints = NO;
        [self.view addSubview:counts];
        [NSLayoutConstraint activateConstraints:@[
          [counts.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
          [counts.topAnchor constraintEqualToAnchor:self.maskedTextLengthStatus.bottomAnchor constant:8],
        ]];
        secureField.countLabel = counts;
      }
      [self updateMaskedToggleStatus];
    }
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-app-owned-value"]) {
      self.textEntryAcknowledgeWindowSeconds = AgentDeviceTextEntryAcknowledgeWindow();
      // Reports how many edits this app rendered and how many writes it had to make because a
      // character overtook one, so a lane test can tell a burst the app kept up with from an inert
      // fixture. Counts only: no field content crosses into the test.
      self.textEntryWriteBackStatus = [[UILabel alloc] init];
      self.textEntryWriteBackStatus.accessibilityIdentifier = @"agent-device-text-entry-write-backs";
      self.textEntryWriteBackStatus.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.textEntryWriteBackStatus];
      [NSLayoutConstraint activateConstraints:@[
        [self.textEntryWriteBackStatus.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.textEntryWriteBackStatus.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:12],
      ]];
      [self updateTextEntryWriteBackStatus];
    }
    if (digitCountValue) {
      // The slots an OTP screen renders next to its input: the digits the field really holds.
      self.textEntryDigitSlots = [[UILabel alloc] init];
      self.textEntryDigitSlots.accessibilityIdentifier = @"agent-device-text-entry-digit-slots";
      self.textEntryDigitSlots.translatesAutoresizingMaskIntoConstraints = NO;
      [self.view addSubview:self.textEntryDigitSlots];
      [NSLayoutConstraint activateConstraints:@[
        [self.textEntryDigitSlots.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.textEntryDigitSlots.topAnchor constraintEqualToAnchor:textField.bottomAnchor constant:12],
      ]];
    }
  }

  // The shape a SpringBoard confirmation root carries on an older iOS: the window's own title
  // text plus host chrome whose accessibility label is not copy (the Home Screen page readout),
  // placed first so a walk over every descendant reads it before the title.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-alert-title-page-chrome"]) {
    label.isAccessibilityElement = NO;
    UIView *pageChrome = [[UIView alloc] initWithFrame:CGRectMake(140, 300, 100, 20)];
    pageChrome.isAccessibilityElement = YES;
    pageChrome.accessibilityLabel = @"0 pages";
    [self.view addSubview:pageChrome];
    UILabel *popupTitle = [[UILabel alloc] initWithFrame:CGRectMake(80, 340, 240, 24)];
    popupTitle.text = @"Relaunch to continue";
    popupTitle.accessibilityIdentifier = @"agent-device-alert-title";
    [self.view addSubview:popupTitle];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-crowded-screen"]) {
    for (NSUInteger row = 0; row < 500; row++) {
      UILabel *rowLabel = [[UILabel alloc] initWithFrame:CGRectMake(0, 60 + (row % 30) * 24, 400, 16)];
      rowLabel.text = [NSString stringWithFormat:@"Crowded row %lu", (unsigned long)row];
      rowLabel.accessibilityIdentifier = [NSString stringWithFormat:@"agent-device-crowded-row-%lu", (unsigned long)row];
      [self.view addSubview:rowLabel];
    }
  }

  // Overlapping sibling buttons must not become children of an ordinary slider.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-wide-slider"]) {
    UISlider *slider = [[UISlider alloc] initWithFrame:CGRectMake(20, 20, 360, 31)];
    slider.accessibilityLabel = @"Volume";
    [self.view addSubview:slider];
    NSArray<NSString *> *titles = @[ @"Left", @"Right" ];
    for (NSUInteger i = 0; i < titles.count; i++) {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
      [button setTitle:titles[i] forState:UIControlStateNormal];
      button.frame = CGRectMake(30 + i * 170, 20, 100, 30);
      [self.view addSubview:button];
    }
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-collapsed-tab-bar"]) {
    UITabBar *tabBar = [[UITabBar alloc] initWithFrame:CGRectMake(20, 20, 360, 60)];
    tabBar.items = @[
      [[UITabBarItem alloc] initWithTitle:@"First tab" image:nil tag:0],
      [[UITabBarItem alloc] initWithTitle:@"Second tab" image:nil tag:1],
    ];
    tabBar.isAccessibilityElement = YES;
    tabBar.accessibilityLabel = @"Collapsed tabs";
    [self.view addSubview:tabBar];
  }

  BOOL markedButton = [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-dismiss-popup"];
  if (markedButton || [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-dismiss-popup-window"]) {
    UIButton *dismissRegion = [UIButton buttonWithType:UIButtonTypeSystem];
    dismissRegion.accessibilityIdentifier = markedButton ? @" Dismiss Popup " : @"agent-device-close-popover";
    [dismissRegion setTitle:@"Close popover" forState:UIControlStateNormal];
    dismissRegion.frame = CGRectMake(40, 40, 200, 44);
    [self.view addSubview:dismissRegion];
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
}

@end

#endif
