import SwiftUI

/// Compact bottom bar for the shared player — mounted whenever an audio is
/// loaded (playing or paused) and never unmounted while listening: the full
/// player sheet simply covers it and reveals it again on dismiss. Tapping or
/// swiping up asks the root to present the full player.
struct MiniPlayer: View {
    /// true inside iOS 26's `.tabViewBottomAccessory`, where the system supplies
    /// the capsule container — skip our own background/border/shadow/padding.
    var inAccessory: Bool = false
    @Environment(PlayerModel.self) private var model
    @State private var dragOffset: CGFloat = 0 // <= 0; bar follows an upward drag

    var body: some View {
        Group {
            if model.showsMiniPlayer, let item = model.item {
                bar(item)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        // Animates only the initial mount (and removal on stop) — the bar
        // stays mounted across sheet present/dismiss, so no re-entrance.
        .animation(.snappy(duration: 0.3), value: model.showsMiniPlayer ? model.item?.id : nil)
    }

    private func present(_ item: AudioItem) {
        dragOffset = 0
        model.requestedItem = item
    }

    private func bar(_ item: AudioItem) -> some View {
        Group {
            if inAccessory {
                barCore(item) // system capsule provides background + shape
            } else {
                barCore(item)
                    .background(Theme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
                    .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            }
        }
        .scaleEffect(1 + min(-dragOffset, 30) / 600, anchor: .bottom)
        .offset(y: dragOffset)
        // Swipe up to expand into the full player. minimumDistance keeps taps
        // (bar + play/pause button) untouched; a moving drag cancels the Button.
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { v in
                    // Follow upward drags at half speed (rubber-band); ignore downward.
                    dragOffset = min(v.translation.height, 0) / 2
                }
                .onEnded { v in
                    if v.translation.height < -50 || v.predictedEndTranslation.height < -150 {
                        // Expand impact fires in RootView's requestedItem onChange —
                        // the single presentation path — so no double-buzz here.
                        present(item)
                    } else {
                        dragOffset = 0
                    }
                }
        )
        .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.8), value: dragOffset)
        .padding(.horizontal, inAccessory ? 0 : 12)
        .padding(.bottom, inAccessory ? 0 : 4)
    }

    private func barCore(_ item: AudioItem) -> some View {
        Button { present(item) } label: {
            HStack(spacing: 12) {
                CoverView(id: item.id, mood: model.detail?.mood ?? item.mood, size: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(item.title)
                    .lineLimit(1)
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Button { Haptics.tap(); model.toggle() } label: {
                    Image(systemName: model.playing ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.accent)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, 10)
            .padding(.trailing, 4)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            // Thin progress line along the bar's top edge.
            GeometryReader { geo in
                let frac = model.duration > 0 ? min(model.position / model.duration, 1) : 0
                Rectangle().fill(Theme.line)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Theme.accent)
                            .frame(width: geo.size.width * frac)
                    }
            }
            .frame(height: 2)
        }
    }
}
