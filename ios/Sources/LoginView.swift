import SwiftUI

struct LoginView: View {
    @Environment(AuthManager.self) private var auth
    @State private var email = ""
    @State private var sending = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Text("◉ oto").font(.system(.largeTitle, design: .monospaced)).bold()
            Text("Your generated audios, on your phone.")
                .font(.subheadline).foregroundStyle(.secondary)

            switch auth.phase {
            case .awaitingLink(let sentTo):
                VStack(spacing: 10) {
                    Image(systemName: "envelope.badge").font(.largeTitle)
                    Text("Check your email").font(.headline)
                    Text("We sent a sign-in link to \(sentTo). Tap it to open oto.")
                        .font(.footnote).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }.padding(.top, 8)
            default:
                VStack(spacing: 12) {
                    TextField("you@email.com", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(12)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    Button {
                        sending = true
                        Task { await auth.sendMagicLink(email: email.trimmingCharacters(in: .whitespaces)); sending = false }
                    } label: {
                        Text(sending ? "Sending…" : "Email me a sign-in link")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(sending || !email.contains("@"))
                }.padding(.top, 8)
            }

            if let err = auth.errorMessage {
                Text(err).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(24)
    }
}
