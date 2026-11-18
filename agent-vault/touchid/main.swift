// vault-touchid: keep the Vaultwarden master password in the login Keychain,
// readable only by this binary (Keychain ACL) and only after Touch ID
// (or the Mac password as fallback).
//   vault-touchid store    < password on stdin
//   vault-touchid get      -> prints password to stdout after Touch ID
//   vault-touchid delete
//   vault-touchid exists   -> exit 0 if stored
import Foundation
import LocalAuthentication
import Security

let service = "agent-vault-master-password"
let account = NSUserName()
func fail(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(code)
}
func baseQuery() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: account]
}
func authenticate(_ reason: String) {
    let ctx = LAContext()
    var err: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
        fail("Touch ID / password auth unavailable: \(err?.localizedDescription ?? "unknown")")
    }
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, e in
        ok = success
        if !success { FileHandle.standardError.write("Authentication failed: \(e?.localizedDescription ?? "")\n".data(using: .utf8)!) }
        sem.signal()
    }
    sem.wait()
    if !ok { exit(2) }
}

let cmd = CommandLine.arguments.dropFirst().first ?? ""
switch cmd {
case "store":
    guard let data = try? FileHandle.standardInput.readToEnd(),
          var pw = String(data: data, encoding: .utf8) else { fail("no input") }
    if pw.hasSuffix("\n") { pw.removeLast() }
    if pw.isEmpty { fail("empty password") }
    SecItemDelete(baseQuery() as CFDictionary)
    var q = baseQuery()
    q[kSecValueData as String] = pw.data(using: .utf8)!
    q[kSecAttrLabel as String] = "Vaultwarden master password (agent-vault, Touch ID)"
    // Default ACL on the login keychain trusts only the creating app (this binary);
    // any other process reading it triggers a macOS permission prompt.
    let st = SecItemAdd(q as CFDictionary, nil)
    if st != errSecSuccess { fail("SecItemAdd failed: \(st)") }
    print("stored")
case "get":
    var q = baseQuery()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    // Check presence first so we don't prompt for nothing.
    var probe = baseQuery(); probe[kSecMatchLimit as String] = kSecMatchLimitOne
    if SecItemCopyMatching(probe as CFDictionary, nil) == errSecItemNotFound { fail("not stored", 3) }
    authenticate("unlock your password vault for AI agents")
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    guard st == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) else { fail("read failed: \(st)") }
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
case "delete":
    let st = SecItemDelete(baseQuery() as CFDictionary)
    print(st == errSecSuccess ? "deleted" : "nothing to delete")
case "exists":
    var probe = baseQuery(); probe[kSecMatchLimit as String] = kSecMatchLimitOne
    exit(SecItemCopyMatching(probe as CFDictionary, nil) == errSecItemNotFound ? 1 : 0)
default:
    fail("usage: vault-touchid store|get|delete|exists", 64)
}
