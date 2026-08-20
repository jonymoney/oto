import SwiftUI

/// Compact bottom bar for the shared player — visible whenever an audio is
/// loaded (playing or paused) and the full player screen isn't. Tapping the
/// bar opens the full player as a sheet; playback itself never stops here.
struct MiniPlayer: View {
    @Environment(PlayerModel.self) private var model
    @State private var showingFull = false
    @State private var dragOffset: CGFloat = 0 // <= 0; bar follows an upward drag

    var body: some View {
        Group {
            if let item = model.item, !model.fullPlayerVisible {
                bar(item)
            }
        }
        // Attached outside the `if` so the sheet survives the bar hiding
        // (fullPlayerVisible flips true as the sheet's PlayerView appears).
        .sheet(isPresented: $showingFull) {
            if let item = model.item {
                NavigationStack { PlayerView(item: item) }
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func bar(_ item: AudioItem) -> some View {
        Button { showingFull = true } label: {
            HStack(spacing: 12) {
                CoverView(id: item.id, mood: model.detail?.mood ?? item.mood, size: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(item.title)
                    .lineLimit(1)
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Button { model.toggle() } label: {
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
        .background(Theme.surface)
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
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
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
                        showingFull = true
                    }
                    dragOffset = 0 // bar sits in place under/after the sheet
                }
        )
        .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.8), value: dragOffset)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}
