import SwiftUI

/// On-device avatar cache. Avatar URLs from the API are S3 presigned URLs whose
/// signature changes on every request, so URL-keyed caches (AsyncImage/URLCache)
/// never hit. This cache keys on the stable identity — the username — with an
/// NSCache memory layer over files in Caches/avatars/{key}.jpg (same location
/// scheme as the voice-preview cache in API.swift).
@MainActor
enum AvatarCache {
    private static let memory = NSCache<NSString, UIImage>()

    /// Keys already revalidated this app session — one quiet background
    /// re-download per user per launch, not one per row appearance.
    private static var refreshed: Set<String> = []

    private static var dir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("avatars", isDirectory: true)
    }

    private static func fileURL(_ key: String) -> URL {
        // Usernames are already ^[a-z0-9-]{3,24}$; sanitize defensively anyway.
        let safe = key.replacingOccurrences(of: "[^A-Za-z0-9-]", with: "_", options: .regularExpression)
        return dir.appendingPathComponent("\(safe).jpg")
    }

    /// Memory first, then disk (populating memory on a disk hit).
    static func image(for key: String) -> UIImage? {
        if let img = memory.object(forKey: key as NSString) { return img }
        guard let img = UIImage(contentsOfFile: fileURL(key).path) else { return nil }
        memory.setObject(img, forKey: key as NSString)
        return img
    }

    /// Seed the cache with an in-hand image (e.g. the just-uploaded avatar),
    /// so it displays instantly without re-downloading.
    static func store(image: UIImage, for key: String) {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        store(data: data, for: key)
    }

    /// Store raw downloaded bytes; returns the decoded image (nil if undecodable).
    @discardableResult
    static func store(data: Data, for key: String) -> UIImage? {
        guard let img = UIImage(data: data) else { return nil }
        memory.setObject(img, forKey: key as NSString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL(key), options: .atomic)
        return img
    }

    /// True once per key per session (check-and-mark).
    @MainActor static func needsRefresh(_ key: String) -> Bool {
        refreshed.insert(key).inserted
    }
}

/// Username's first letter on a deterministic color (same FNV-1a palette as the
/// cover art, so a user keeps their color everywhere). The single shared
/// implementation of the initials look.
struct InitialsCircle: View {
    let text: String
    let size: CGFloat

    var body: some View {
        Circle()
            .fill(CoverArt.palette(id: text, mood: nil)[0])
            .overlay {
                Text(text.first.map { String($0).uppercased() } ?? "?")
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }
}

/// Circle avatar backed by AvatarCache: shows the cached image immediately if
/// present, quietly revalidates from `avatarUrl` (stale-while-revalidate),
/// and falls back to the initials circle when there is no image.
struct AvatarImageView: View {
    let avatarUrl: String?
    let size: CGFloat
    let fallbackText: String
    private let key: String
    @State private var image: UIImage?

    init(username: String?, avatarUrl: String?, size: CGFloat = 40, fallbackText: String? = nil) {
        self.avatarUrl = avatarUrl
        self.size = size
        self.fallbackText = fallbackText ?? username ?? "?"
        self.key = username ?? "me"
        _image = State(initialValue: AvatarCache.image(for: key))
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                InitialsCircle(text: fallbackText, size: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: avatarUrl) { await refresh() }
    }

    private func refresh() async {
        // Pick up entries seeded after this view's identity was created
        // (e.g. the upload path calling AvatarCache.store).
        if let cached = AvatarCache.image(for: key), cached !== image { image = cached }
        guard let s = avatarUrl, let url = URL(string: s),
              AvatarCache.needsRefresh(key) else { return }
        // ponytail: unconditional overwrite on revalidate — no byte compare,
        // no TTL. Add a hash header/ETag from the API if avatar bandwidth
        // ever matters.
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let fresh = AvatarCache.store(data: data, for: key) else { return }
        image = fresh
    }
}
