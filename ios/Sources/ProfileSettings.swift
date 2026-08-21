import SwiftUI
import PhotosUI

// MARK: - Username editing

/// Pushed from Settings. Live availability check (debounced), preview of the
/// public URL, and save. Calls `onSaved` with the updated profile and pops.
struct UsernameEditView: View {
    let current: String?
    let onSaved: (API.Me) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var username: String
    @State private var status: Status = .idle
    @State private var saving = false
    @State private var saveError: String?
    @State private var checkTask: Task<Void, Never>?

    private enum Status: Equatable { case idle, unchanged, checking, available, taken, reserved, invalid }

    init(current: String?, onSaved: @escaping (API.Me) -> Void) {
        self.current = current
        self.onSaved = onSaved
        _username = State(initialValue: current ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextField("username", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                statusLine.font(.footnote)
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if !username.isEmpty && status != .invalid {
                        Text("oto.audio/\(username)").foregroundStyle(Theme.ink2)
                    }
                    Text("Changing your username breaks links you've already shared.")
                }
            }
            .listRowBackground(Theme.surface)

            if let saveError {
                Section {
                    Text(saveError).font(.footnote).foregroundStyle(Theme.danger)
                }
                .listRowBackground(Theme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Username")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .disabled(status != .available)   // .available implies changed
                }
            }
        }
        .onChange(of: username) { _, raw in
            let v = raw.lowercased()
            if v != raw { username = v; return }   // re-triggers onChange with the lowered value
            scheduleCheck(v)
        }
        .onDisappear { checkTask?.cancel() }
    }

    @ViewBuilder private var statusLine: some View {
        switch status {
        case .checking:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking…").foregroundStyle(Theme.ink2)
            }
        case .available:
            Label("Available", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .taken:
            Label("Taken", systemImage: "xmark.circle").foregroundStyle(Theme.danger)
        case .reserved:
            Label("Reserved", systemImage: "xmark.circle").foregroundStyle(Theme.danger)
        case .invalid:
            Label("Only a-z, 0-9 and dashes, 3–24 chars", systemImage: "exclamationmark.circle")
                .foregroundStyle(Theme.danger)
        case .idle, .unchanged:
            EmptyView()
        }
    }

    private func scheduleCheck(_ v: String) {
        checkTask?.cancel()
        saveError = nil
        if v.isEmpty { status = .idle; return }
        if v == current { status = .unchanged; return }
        guard v.range(of: "^[a-z0-9-]{3,24}$", options: .regularExpression) != nil else {
            status = .invalid
            return
        }
        status = .checking
        checkTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            do {
                let (available, reason) = try await API.usernameAvailable(v)
                guard !Task.isCancelled, username == v else { return }
                status = available ? .available : (reason == "reserved" ? .reserved : .taken)
            } catch {
                if !Task.isCancelled { status = .idle }   // network hiccup: no verdict
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let me = try await API.updateUsername(username)
            Haptics.success()
            onSaved(me)
            dismiss()
        } catch {
            Haptics.warning() // taken/reserved/invalid/network error surfacing
            if case let APIError.server(m) = error {
                switch m {
                case "taken":    saveError = "That username is taken."
                case "reserved": saveError = "That username is reserved."
                case "invalid":  saveError = "Only a-z, 0-9 and dashes, 3–24 chars."
                default:         saveError = m
                }
            } else {
                saveError = "Couldn't save. Try again."
            }
        }
    }
}

// MARK: - Avatar

/// Tappable avatar: current photo (or an initials circle) that opens the photo
/// picker; picks are center-cropped square, downscaled to 512, and uploaded.
struct AvatarPickerView: View {
    let avatarUrl: String?
    /// Username or email — the initial letter and deterministic color come from it.
    let fallbackText: String
    /// Stable AvatarCache key (the username); nil falls back to "me".
    var cacheKey: String? = nil
    var size: CGFloat = 56
    let onUploaded: (String) -> Void

    @State private var selection: PhotosPickerItem?
    @State private var uploading = false
    @State private var failed = false

    var body: some View {
        PhotosPicker(selection: $selection, matching: .images) {
            avatar
                .overlay {
                    if uploading {
                        Circle().fill(.black.opacity(0.4))
                        ProgressView().tint(.white)
                    }
                }
        }
        .buttonStyle(.plain)
        .onChange(of: selection) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
        .alert("Couldn't update your photo.", isPresented: $failed) {
            Button("OK") {}
        }
    }

    private var avatar: some View {
        AvatarImageView(username: cacheKey, avatarUrl: avatarUrl, size: size, fallbackText: fallbackText)
    }

    private func upload(_ item: PhotosPickerItem) async {
        uploading = true
        defer { uploading = false; selection = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data),
              let jpeg = squareJPEG(image) else {
            failed = true
            return
        }
        do {
            let url = try await API.uploadAvatar(jpeg: jpeg)
            // Seed the cache with the just-uploaded bytes so the new avatar
            // shows instantly everywhere, without re-downloading it.
            AvatarCache.store(data: jpeg, for: cacheKey ?? "me")
            onUploaded(url)
            Haptics.success()
        } catch {
            failed = true
        }
    }

    /// Center-crop to a square, downscale to at most `side`, encode JPEG 0.85.
    private func squareJPEG(_ image: UIImage, side: CGFloat = 512) -> Data? {
        let s = min(image.size.width, image.size.height)
        guard s > 0 else { return nil }
        let out = min(side, s)
        let scale = out / s
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: out, height: out), format: format)
            .image { _ in
                // Draw the full image offset so its center square fills the canvas.
                image.draw(in: CGRect(
                    x: -(image.size.width - s) / 2 * scale,
                    y: -(image.size.height - s) / 2 * scale,
                    width: image.size.width * scale,
                    height: image.size.height * scale
                ))
            }
        return rendered.jpegData(compressionQuality: 0.85)
    }
}
