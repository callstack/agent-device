import ExpoModulesCore
import PassKit

// Presents the system Apple Pay sheet, which iOS hosts out of process in
// com.apple.PassbookUIService. The billing address and contact forms inside that sheet are the
// fixture for typing into a focused field that the app's own accessibility tree cannot resolve.
public final class ApplePayLabModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ApplePayLab")

    Function("canMakePayments") { () -> Bool in
      PKPaymentAuthorizationController.canMakePayments()
    }

    AsyncFunction("presentPaymentSheetAsync") { (promise: Promise) in
      ApplePayLabController.shared.present(promise: promise)
    }.runOnQueue(.main)
  }
}

private final class ApplePayLabController: NSObject, PKPaymentAuthorizationControllerDelegate {
  static let shared = ApplePayLabController()

  // Must match com.apple.developer.in-app-payments in app.config.js. The simulator accepts any
  // merchant id declared there and offers its built-in test cards.
  private static let merchantIdentifier = "merchant.com.callstack.agentdevicelab"

  // One presented sheet at a time. Holding the controller keeps it alive until PassKit reports
  // that it finished; the promise resolves with the outcome then.
  private struct Session {
    let controller: PKPaymentAuthorizationController
    let promise: Promise
    var authorized = false
  }

  private var session: Session?

  func present(promise: Promise) {
    guard session == nil else {
      promise.reject(
        Exception(
          name: "PaymentSheetAlreadyPresented",
          description: "The Apple Pay sheet is already presented."
        )
      )
      return
    }

    let request = PKPaymentRequest()
    request.merchantIdentifier = Self.merchantIdentifier
    request.countryCode = "US"
    request.currencyCode = "USD"
    request.supportedNetworks = [.visa, .masterCard, .amex]
    request.merchantCapabilities = .threeDSecure
    request.requiredBillingContactFields = [.postalAddress]
    request.requiredShippingContactFields = [.emailAddress, .phoneNumber]
    request.paymentSummaryItems = [
      PKPaymentSummaryItem(label: "Agent Device Tester", amount: NSDecimalNumber(string: "1.00")),
    ]

    let controller = PKPaymentAuthorizationController(paymentRequest: request)
    controller.delegate = self
    session = Session(controller: controller, promise: promise)
    controller.present { presented in
      guard !presented else { return }
      self.session = nil
      promise.reject(
        Exception(
          name: "PaymentSheetNotPresented",
          description: "iOS refused to present the Apple Pay sheet."
        )
      )
    }
  }

  func paymentAuthorizationController(
    _ controller: PKPaymentAuthorizationController,
    didAuthorizePayment payment: PKPayment,
    handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
  ) {
    session?.authorized = true
    completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
  }

  func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
    controller.dismiss {
      guard let session = self.session else { return }
      self.session = nil
      session.promise.resolve(session.authorized ? "authorized" : "dismissed")
    }
  }
}
