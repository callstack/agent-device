import AuthenticationServices
import ExpoModulesCore
import UIKit

// Presents a real sign-in sheet through ASWebAuthenticationSession. iOS hosts that sheet out of
// process in com.apple.SafariViewService, which makes this the #2449 fixture: the sheet is read and
// driven in place (#2438), the app stays the accessibility primaryApp while the sheet is up, and no
// step may activate or relaunch anything.
//
// The page itself is served by the fixture identity provider, not by the app: see
// `src/auth-idp-fixture.ts` for its content and `scripts/serve-auth-idp.mjs`, in this app's folder,
// for the server a lane starts. It holds fixture values only, so this flow needs no credentials.
// `startSignInAsync` resolves with the callback URL the sheet ended on, which is the observable end
// of the flow.
public final class AuthSessionLabModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AuthSessionLab")

    AsyncFunction("startSignInAsync") { (url: String, callbackScheme: String, promise: Promise) in
      AuthSessionLabController.shared.start(url: url, callbackScheme: callbackScheme, promise: promise)
    }.runOnQueue(.main)
  }
}

private final class AuthSessionLabController: NSObject {
  static let shared = AuthSessionLabController()

  private struct Session {
    let controller: ASWebAuthenticationSession
    let promise: Promise
  }

  // One sheet at a time: two concurrent sessions would make which sheet answered ambiguous.
  private var session: Session?

  func start(url: String, callbackScheme: String, promise: Promise) {
    guard session == nil else {
      promise.reject(
        Exception(
          name: "AuthSessionAlreadyPresented",
          description: "A sign-in sheet is already presented."
        )
      )
      return
    }

    guard let url = URL(string: url), url.scheme != nil else {
      promise.reject(
        Exception(name: "InvalidAuthURL", description: "The sign-in URL is not a valid URL.")
      )
      return
    }

    let controller = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
      callbackURL, error in
      guard let session = self.session else { return }
      self.session = nil
      if let callbackURL {
        session.promise.resolve(callbackURL.absoluteString)
        return
      }
      let sessionError = error as? ASWebAuthenticationSessionError
      session.promise.reject(
        Exception(
          name: sessionError?.code == .canceledLogin ? "AuthSessionCanceled" : "AuthSessionFailed",
          description: error?.localizedDescription ?? "The sign-in session failed."
        )
      )
    }

    // Ephemeral so the sheet shares no cookies or website data with anything else on the device.
    controller.prefersEphemeralWebBrowserSession = true
    controller.presentationContextProvider = self
    session = Session(controller: controller, promise: promise)
    controller.start()
  }
}

extension AuthSessionLabController: ASWebAuthenticationPresentationContextProviding {
  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    return windows.first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}
