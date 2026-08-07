import SwiftUI

struct LoginView: View {
    @Environment(AuthManager.self) private var auth
    @State private var email = ""
    @State private var code = ""
    @State private var working = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            (Text("◉").foregroundStyle(Theme.accent) + Text(" oto").foregroundStyle(Theme.ink))
                .font(.system(.largeTitle, design: .monospaced)).bold()
            Text("Your generated audios, on your phone.")
                .font(.subheadline).foregroundStyle(Theme.ink2)

            switch auth.phase {
            case .enteringCode(let sentTo):
                VStack(spacing: 12) {
                    Text("Enter the 6-digit code we emailed to \(sentTo).")
                        .font(.footnote).foregroundStyle(Theme.ink2)
                        .multilineTextAlignment(.center)
                    TextField("123456", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .multilineTextAlignment(.center)
                        .font(.system(.title2, design: .monospaced))
                        .foregroundStyle(Theme.ink)
                        .padding(12)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                    Button {
                        working = true
                        Task { await auth.verifyCode(code); working = false }
                    } label: {
                        Text(working ? "Verifying…" : "Sign in").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(working || code.count < 6)
                    Button("Use a different email") { auth.restart(); code = "" }
                        .font(.footnote)
                }.padding(.top, 8)
            default:
                VStack(spacing: 12) {
                    TextField("you@email.com", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .foregroundStyle(Theme.ink)
                        .padding(12)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                    Button {
                        working = true
                        Task { await auth.sendCode(email: email.trimmingCharacters(in: .whitespaces)); working = false }
                    } label: {
                        Text(working ? "Sending…" : "Email me a code").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(working || !email.contains("@"))
                }.padding(.top, 8)
            }

            if let err = auth.errorMessage {
                Text(err).font(.footnote).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}
