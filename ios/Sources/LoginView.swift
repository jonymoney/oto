import SwiftUI

struct LoginView: View {
    @Environment(AuthManager.self) private var auth
    @State private var email = ""
    @State private var phone = ""
    @State private var code = ""
    @FocusState private var codeFocused: Bool
    @State private var resendIn = 0
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        @Bindable var auth = auth
        VStack(spacing: 20) {
            Spacer()
            (Text("◉").foregroundStyle(Theme.accent) + Text(" oto").foregroundStyle(Theme.ink))
                .font(.system(.largeTitle, design: .monospaced)).bold()
            Text("Your generated audios, on your phone.")
                .font(.subheadline).foregroundStyle(Theme.ink2)

            if auth.phase == .codeSent {
                codeEntry
            } else {
                methodForm
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .alert("Something went wrong", isPresented: Binding(
            get: { auth.errorMessage != nil },
            set: { if !$0 { auth.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(auth.errorMessage ?? "")
        }
    }

    // MARK: idle / loading — pick a method and enter the destination

    private var methodForm: some View {
        @Bindable var auth = auth
        return VStack(spacing: 14) {
            Text("Sign in").font(.title2).bold().foregroundStyle(Theme.ink)

            Picker("Method", selection: $auth.method) {
                Text("Email").tag(AuthManager.Method.email)
                Text("Phone").tag(AuthManager.Method.phone)
            }
            .pickerStyle(.segmented)
            .disabled(auth.isWorking)

            Text(auth.method == .email
                 ? "Enter your email to receive a code"
                 : "Enter your phone number to receive a code")
                .font(.footnote).foregroundStyle(Theme.ink2)
                .multilineTextAlignment(.center)

            if auth.method == .email {
                field("you@email.com", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { Task { await auth.sendCode(email: email) } }
                    .disabled(auth.isWorking)
            } else {
                field("+1 555 123 4567", text: $phone)
                    .keyboardType(.phonePad)
                    .disabled(true)
                Text("Phone sign-in is coming soon.")
                    .font(.caption).foregroundStyle(Theme.ink3)
            }

            if auth.isWorking {
                ProgressView().padding(.top, 4)
            } else {
                Button {
                    Task { await auth.sendCode(email: email) }
                } label: {
                    Text("Continue").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(auth.method == .phone)
            }
        }
        .padding(.top, 8)
    }

    // MARK: codeSent — enter the 6-digit code

    private var codeEntry: some View {
        VStack(spacing: 14) {
            Text("Enter the code").font(.title2).bold().foregroundStyle(Theme.ink)
            Text("We sent a 6-digit code to \(auth.destination).")
                .font(.footnote).foregroundStyle(Theme.ink2)
                .multilineTextAlignment(.center)

            field("123456", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .multilineTextAlignment(.center)
                .font(.system(.title2, design: .monospaced))
                .focused($codeFocused)
                .disabled(auth.isWorking)

            if auth.isWorking {
                ProgressView().padding(.top, 4)
            } else {
                Button {
                    Task { await auth.verifyCode(code) }
                } label: {
                    Text("Verify").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(code.count < 6)
            }

            HStack {
                Button(resendIn > 0 ? "Resend in \(resendIn)s" : "Resend code") {
                    Task { await auth.resendCode() }
                    resendIn = 60
                }
                .disabled(resendIn > 0 || auth.isWorking)
                Spacer()
                Button(auth.method == .email ? "Change email" : "Change phone") {
                    auth.changeDestination()
                    code = ""
                }
                .disabled(auth.isWorking)
            }
            .font(.footnote)
            .padding(.top, 4)
        }
        .padding(.top, 8)
        .onAppear { codeFocused = true; resendIn = 60 }
        .onReceive(ticker) { _ in if resendIn > 0 { resendIn -= 1 } }
    }

    // Shared brand-styled text field.
    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .foregroundStyle(Theme.ink)
            .padding(12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
    }
}
