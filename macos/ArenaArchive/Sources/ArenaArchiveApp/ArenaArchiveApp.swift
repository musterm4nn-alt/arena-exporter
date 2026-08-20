import SwiftUI
import ArchiveKit

@main
struct ArenaArchiveApp: App {
    @StateObject private var model = ArchiveViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .font(.custom("Departure Mono", size: 13, relativeTo: .body))
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

final class ArchiveViewModel: ObservableObject {
    @Published var chats: [ChatIndexEntry] = []
    @Published var keys: [String] = []
    @Published var selectedKey: String?
    @Published var markdown: String = "Select a chat."
    @Published var rootPath: String = ""
    let store = ArchiveStore()

    init() {
        reload()
    }

    func reload() {
        rootPath = store.root.path
        let index = store.loadIndex()
        keys = index.chats.keys.sorted()
        chats = keys.compactMap { index.chats[$0] }
        if let key = selectedKey, let entry = index.chats[key] {
            loadMarkdown(rel: entry.rel)
        }
    }

    func select(key: String) {
        selectedKey = key
        if let entry = store.resolve(key) {
            loadMarkdown(rel: entry.rel)
        }
    }

    func loadMarkdown(rel: String) {
        let url = store.root.appendingPathComponent(rel).appendingPathComponent("conversation.md")
        if let text = try? String(contentsOf: url, encoding: .utf8) {
            markdown = text
        } else {
            markdown = "(no conversation.md yet)\n\(rel)"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: ArchiveViewModel

    var body: some View {
        NavigationSplitView {
            List(model.keys, id: \.self, selection: Binding(
                get: { model.selectedKey },
                set: { if let k = $0 { model.select(key: k) } }
            )) { key in
                if let chat = model.store.resolve(key) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(chat.title.isEmpty ? key : chat.title)
                            .foregroundStyle(.primary)
                        Text("\(chat.mode)  \(chat.subtype ?? "")")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Arena Archive")
            .listStyle(.sidebar)
        } detail: {
            ScrollView {
                Text(model.markdown)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
            }
            .background(.ultraThinMaterial)
        }
        .background {
            LinearGradient(
                colors: [Color.black, Color(red: 0.08, green: 0.10, blue: 0.16)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button("Reload") { model.reload() }
            }
        }
        .onAppear { model.reload() }
    }
}
