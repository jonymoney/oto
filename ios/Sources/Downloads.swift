import Foundation

/// Offline downloads. Stores each audio's mp3 in Application Support (not Caches,
/// which the OS can purge) plus a JSON index of the AudioItems so the library
/// renders fully offline. Foreground async downloads only.
/// ponytail: no background URLSession config — v1 downloads while the app is
/// foregrounded; add a background session if large files or lock-screen matter.
@MainActor
@Observable
final class Downloads {
    static let shared = Downloads()

    private(set) var items: [AudioItem] = []      // downloaded, newest first
    private(set) var inProgress: Set<String> = [] // currently downloading

    private let dir: URL
    private var indexURL: URL { dir.appendingPathComponent("index.json") }

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        loadIndex()
    }

    // MARK: Queries

    func isDownloaded(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(id).path)
    }

    func localURL(_ id: String) -> URL? {
        isDownloaded(id) ? fileURL(id) : nil
    }

    // MARK: Mutations

    func download(_ item: AudioItem) async {
        guard !isDownloaded(item.id), !inProgress.contains(item.id) else { return }
        inProgress.insert(item.id)
        defer { inProgress.remove(item.id) }
        do {
            let detail = try await API.audioDetail(id: item.id)
            guard let urlStr = detail.audioUrl, let url = URL(string: urlStr) else { return }
            // Presigned bucket URL is self-authenticating — plain session, no bearer/Origin.
            let (temp, _) = try await URLSession.shared.download(from: url)
            let dest = fileURL(item.id)
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: temp, to: dest)
            items.removeAll { $0.id == item.id }
            items.insert(item, at: 0)
            saveIndex()
        } catch {
            // Best-effort: leave it not-downloaded.
        }
    }

    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: fileURL(id))
        items.removeAll { $0.id == id }
        saveIndex()
    }

    // MARK: Storage

    private func fileURL(_ id: String) -> URL {
        dir.appendingPathComponent("\(id).mp3")
    }

    private func loadIndex() {
        guard let data = try? Data(contentsOf: indexURL),
              let decoded = try? JSONDecoder().decode([AudioItem].self, from: data) else { return }
        items = decoded.filter { isDownloaded($0.id) }
    }

    private func saveIndex() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: indexURL)
    }
}
