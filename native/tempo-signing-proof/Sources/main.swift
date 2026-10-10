import AppKit
import Foundation
import JavaScriptCore
import LocalAuthentication
import Security

struct ProofError: Error { let code: String }
func fail(_ code: String) -> ProofError { ProofError(code: code) }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
func hex(_ data: Data) -> String { "0x" + data.map { String(format: "%02x", $0) }.joined() }
func bytes(_ value: String) throws -> Data {
    let chars = Array(value.dropFirst(2))
    guard value.hasPrefix("0x"), chars.count == 64 else { throw fail("INVALID_DIGEST") }
    var data = Data()
    for i in stride(from: 0, to: chars.count, by: 2) {
        guard let byte = UInt8(String(chars[i...i+1]), radix: 16) else { throw fail("INVALID_DIGEST") }
        data.append(byte)
    }
    return data
}

// SDK code comes only from this app's build, never from IPC or a caller path.
final class TransactionBuilder {
    let context: JSContext
    init() throws {
        guard let context = JSContext(),
              let url = Bundle.main.url(forResource: "transaction", withExtension: "js") else {
            throw fail("MISSING_BUNDLED_SDK")
        }
        self.context = context
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        guard context.exception == nil else {
            // Bundle-load diagnostics contain no request or key material.
            FileHandle.standardError.write(Data("SDK load: \(context.exception?.toString() ?? "unknown")\n".utf8))
            throw fail("SDK_LOAD_FAILED")
        }
    }
    func call(_ name: String, _ arguments: [Any]) throws -> String {
        context.exception = nil
        let function = context.objectForKeyedSubscript("AlgoriaProof")?.objectForKeyedSubscript(name)
        let called = function?.call(withArguments: arguments)
        if CommandLine.arguments.contains("--self-test-request"), let exception = context.exception {
            // Offline fixture diagnostics only; never enabled for live approval.
            FileHandle.standardError.write(Data("Offline SDK: \(exception.toString() ?? "unknown")\n".utf8))
        }
        guard let result = called, context.exception == nil,
              let value = result.toString(), value != "undefined" else { throw fail("INVALID_REQUEST_OR_SIGNATURE") }
        return value
    }
    func prepare(_ request: String, _ publicKey: String) throws -> [String: Any] {
        let result = try call("prepareJSON", [request, publicKey, Int(Date().timeIntervalSince1970)])
        guard let object = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any] else {
            throw fail("INVALID_SDK_RESULT")
        }
        return object
    }
}

func makeKey(softwareTestOnly: Bool) throws -> SecKey {
    var attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
    ]
    if !softwareTestOnly {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet], &error) else { throw fail("KEY_ACCESS_CONTROL_FAILED") }
        attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        attributes[kSecPrivateKeyAttrs as String] = [
            kSecAttrIsPermanent as String: false,
            kSecAttrAccessControl as String: access,
        ]
    }
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        throw fail(softwareTestOnly ? "TEST_KEY_FAILED" : "SECURE_ENCLAVE_KEY_FAILED")
    }
    return key
}
func publicHex(_ key: SecKey) throws -> String {
    guard let publicKey = SecKeyCopyPublicKey(key),
          let value = SecKeyCopyExternalRepresentation(publicKey, nil) else { throw fail("PUBLIC_KEY_FAILED") }
    return hex(value as Data)
}
func sign(_ key: SecKey, digest: String) throws -> String {
    // Digest variant: signs the SDK's keccak digest directly, with no extra SHA256.
    // Corresponding Tempo P256 envelope uses prehash:false.
    let algorithm = SecKeyAlgorithm.ecdsaSignatureDigestX962SHA256
    guard SecKeyIsAlgorithmSupported(key, .sign, algorithm) else { throw fail("UNSUPPORTED_SIGNING_ALGORITHM") }
    var error: Unmanaged<CFError>?
    guard let value = SecKeyCreateSignature(key, algorithm, try bytes(digest) as CFData, &error) else {
        // Cancellation/lockout/ACL failure all fail closed; no password/key fallback.
        throw fail("SIGNING_CANCELLED_OR_DENIED")
    }
    return hex(value as Data)
}
func readRequest() throws -> String {
    var data = Data()
    while let byte = try FileHandle.standardInput.read(upToCount: 1), !byte.isEmpty {
        if byte[0] == 10 { break }
        data.append(byte)
        if data.count > 32768 { throw fail("REQUEST_TOO_LARGE") }
    }
    guard let result = String(data: data, encoding: .utf8), !result.isEmpty else { throw fail("MISSING_REQUEST") }
    return result
}
func biometricStatus() -> Bool {
    let context = LAContext()
    context.localizedFallbackTitle = ""
    var error: NSError?
    return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) && context.biometryType == .touchID
}

// Read IPC off the UI thread so cancellation and painting work during RPC waits.
private final class WalletInput {
    let lock = NSLock()
    var result: Result<String, Error>?
}
func readJourneyRequest(_ journey: WalletJourneyController?) throws -> String {
    guard let journey else { return try readRequest() }
    let input = WalletInput()
    DispatchQueue.global(qos: .userInitiated).async {
        let result = Result { try readRequest() }
        input.lock.lock(); input.result = result; input.lock.unlock()
    }
    let deadline = Date().addingTimeInterval(600)
    while !journey.closed && Date() < deadline {
        input.lock.lock(); let result = input.result; input.lock.unlock()
        if let result { return try result.get() }
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    }
    throw fail(journey.signed ? "STATUS_WINDOW_CLOSED" : "USER_CANCELLED")
}

var journey: WalletJourneyController?
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    // Standalone design fixtures: no SDK, private key, funding or RPC access.
    if arguments == ["--ui-self-test"] {
        NSApplication.shared.setActivationPolicy(.prohibited)
        try WalletFundingController.selfTest()
        try WalletJourneyController.selfTest()
        emit(try WalletReviewController.selfTest())
        exit(0)
    }
    if arguments == ["--self-test-journey-input"] || arguments == ["--self-test-journey-cancel"] {
        // UI/IPC fixtures only: this branch never loads the SDK or creates keys.
        NSApplication.shared.setActivationPolicy(.prohibited)
        let fixture = WalletJourneyController(preview: true)
        let cancellation = arguments == ["--self-test-journey-cancel"]
        var uiTicked = false
        let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: false) { _ in
            uiTicked = true
            if cancellation { _ = fixture.windowShouldClose(fixture.window!) }
        }
        emit(["status": "journey-input-ready", "keyCreated": false])
        do {
            let line = try readJourneyRequest(fixture)
            guard uiTicked, let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw fail("JOURNEY_UI_BLOCKED") }
            try fixture.update(object)
            emit(["status": "journey-input-passed", "stage": fixture.stage, "keyCreated": false, "signed": false])
        } catch let error as ProofError where cancellation && error.code == "USER_CANCELLED" {
            emit(["status": "journey-cancel-passed", "keyCreated": false, "signed": false])
        }
        timer.invalidate(); fixture.window?.close()
        exit(0)
    }
    if arguments == ["--preview", "funding"] {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        _ = WalletFundingController(summary: WalletFundingController.fixture(), preview: true).runReview()
        emit(["status": "preview-closed", "keyCreated": false, "signed": false])
        exit(0)
    }
    if arguments.count == 2, arguments[0] == "--render-ui" {
        NSApplication.shared.setActivationPolicy(.prohibited)
        emit(["status": "ui-rendered", "paths": try WalletReviewController.renderPreviews(to: arguments[1]), "keyCreated": false])
        exit(0)
    }
    if arguments.count == 2, arguments[0] == "--preview", ["purchase", "budget", "phone"].contains(arguments[1]) {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let kind: WalletReviewKind = arguments[1] == "budget" ? .permission : .purchase
        let preview = WalletReviewController(summary: WalletReviewController.fixture(kind, phone: arguments[1] == "phone"), kind: kind, preview: true)
        _ = preview.runReview()
        emit(["status": "preview-closed", "keyCreated": false, "signed": false])
        exit(0)
    }
    if arguments == ["--status"] {
        emit(["status": "readiness", "touchIDAvailable": biometricStatus(), "keyCreated": false, "permissionVersion": 1, "fundingVersion": 1, "journeyVersion": 1])
        exit(0)
    }
    if arguments == ["--approve-permission"] || arguments == ["--self-test-permission"] {
        let permissionTest = arguments == ["--self-test-permission"]
        guard permissionTest || biometricStatus() else { throw fail("TOUCH_ID_UNAVAILABLE") }
        let builder = try TransactionBuilder()
        let request = try readRequest()
        let preparedJSON = try builder.call("preparePermissionJSON", [request, Int(Date().timeIntervalSince1970)])
        guard let prepared = try JSONSerialization.jsonObject(with: Data(preparedJSON.utf8)) as? [String: Any],
              let digest = prepared["digest"] as? String,
              let summary = prepared["summary"] as? [String: Any] else { throw fail("INVALID_PERMISSION") }
        if !permissionTest {
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        if !permissionTest {
            let review = WalletReviewController(summary: summary, kind: .permission)
            guard review.runReview() else { throw fail("USER_CANCELLED") }
        }
        let key = try makeKey(softwareTestOnly: permissionTest)
        let signature = try sign(key, digest: digest)
        let rechecked = try builder.call("preparePermissionJSON", [request, Int(Date().timeIntervalSince1970)])
        guard rechecked == preparedJSON else { throw fail("PERMISSION_CHANGED") }
        let policy = try JSONSerialization.jsonObject(with: Data(request.utf8))
        emit(["status": permissionTest ? "self-test-permission" : "permission-approved", "provesTouchID": !permissionTest, "receipt": ["policy": policy, "digest": digest,
            "publicKey": try publicHex(key), "signature": signature]])
        exit(0)
    }
    let selfTestRequest = arguments == ["--self-test-request"]
    let selfTestFunding = arguments == ["--self-test-funding-request"]
    let selfTest = arguments == ["--self-test"] || selfTestRequest || selfTestFunding
    let unifiedJourney = arguments == ["--journey"]
    guard selfTest || arguments.isEmpty || unifiedJourney else { throw fail("UNKNOWN_ARGUMENT") }
    if !selfTest && !biometricStatus() { throw fail("TOUCH_ID_UNAVAILABLE") }
    let builder = try TransactionBuilder()
    if !selfTest {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        // Creating an ephemeral key conveys no signing authority. Disclose its
        // lifetime in the single purchase review rather than a second alert.
        if unifiedJourney { journey = WalletJourneyController() }
    }
    let key = try makeKey(softwareTestOnly: selfTest)
    let publicKey = try publicHex(key)
    if selfTestFunding {
        let result = try builder.call("prepareFundingJSON", [try readRequest(), publicKey, Int(Date().timeIntervalSince1970)])
        let summary = try JSONSerialization.jsonObject(with: Data(result.utf8))
        emit(["status": "funding-self-test-passed", "softwareTestKey": true, "provesTouchID": false, "signed": false, "summary": summary])
        exit(0)
    }
    var request: String
    if selfTestRequest {
        request = try readRequest()
    } else if selfTest {
        request = "{\"version\":1,\"chainId\":42431,\"nonce\":\"0\",\"maxFeePerGas\":\"20000000000\",\"validBefore\":\(Int(Date().timeIntervalSince1970) + 120)}"
    } else {
        emit(["status": "ready", "publicKey": publicKey, "disposable": true, "fundingVersion": 1, "journeyVersion": 1])
        request = try readJourneyRequest(journey)
    }
    // The parent retains this process/key while the person supplies TEST tokens.
    // A funding check is never a purchase approval and never calls sign().
    while !selfTest {
        let object = try JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any]
        if let object, object["type"] as? String == "wallet-progress", let journey {
            try journey.update(object)
            request = try readJourneyRequest(journey)
            continue
        }
        guard object?["type"] as? String == "funding-required" else { break }
        let json = try builder.call("prepareFundingJSON", [request, publicKey, Int(Date().timeIntervalSince1970)])
        guard let summary = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw fail("INVALID_FUNDING_REVIEW") }
        guard WalletFundingController(summary: summary, journeyWindow: journey?.window).runReview() else { throw fail("FUNDING_CANCELLED_OR_EXPIRED") }
        journey?.show("preparing")
        emit(["status": "funding-checked", "signed": false])
        request = try readJourneyRequest(journey)
    }
    let prepared = try builder.prepare(request, publicKey)
    if !selfTest, let object = try JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any],
       object["version"] as? Int == 2, object["permission"] == nil { throw fail("PERMISSION_REQUIRED") }
    guard let digest = prepared["digest"] as? String,
          let summary = prepared["summary"] as? [String: Any] else { throw fail("INVALID_SDK_RESULT") }
    if !selfTest {
        journey?.attach(summary)
        let review = WalletReviewController(summary: summary, kind: .purchase, journeyWindow: journey?.window)
        guard review.runReview() else { throw fail("USER_CANCELLED") }
        journey?.show("authenticating")
    }
    // Revalidate expiry before key access and again after the biometric prompt.
    guard try builder.prepare(request, publicKey)["digest"] as? String == digest else { throw fail("REQUEST_CHANGED") }
    guard journey?.closed != true else { throw fail("USER_CANCELLED") }
    let der = try sign(key, digest: digest)
    // If a close event was processed during system authentication, never return
    // the signature. Once "signed" is emitted, closing is presentation-only.
    guard journey?.closed != true else { throw fail("USER_CANCELLED") }
    let result = try builder.call("completeJSON", [request, publicKey, der, Int(Date().timeIntervalSince1970)])
    if selfTest {
        emit(["status": "self-test-passed", "softwareTestKey": true,
              "provesTouchID": false, "provesTestnetSettlement": false])
    } else {
        guard let output = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any] else { throw fail("INVALID_SDK_RESULT") }
        journey?.markSigned()
        emit(["status": "signed", "result": output])
        // The signing phase is over. Only bounded presentation messages are
        // accepted now; no path in this loop can call sign() a second time.
        if let journey {
            while !journey.closed {
                do {
                    let line = try readJourneyRequest(journey)
                    guard let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw fail("INVALID_WALLET_PROGRESS") }
                    if object.count == 1, object["type"] as? String == "wallet-finish" { break }
                    try journey.update(object)
                } catch {
                    if !journey.closed { journey.show("needs-attention") }
                    break
                }
            }
            journey.finish()
        }
    }
} catch {
    journey?.window?.orderOut(nil)
    emit(["status": "error", "code": (error as? ProofError)?.code ?? "PROOF_FAILED"])
    exit(1)
}
