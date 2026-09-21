"""Apply the small bridge overlay to an exact upstream checkout (no renderer fork)."""
import pathlib
import shutil
import subprocess
import sys

REVISION = 'c39da13b5db11bc8678ec04a7a748e1e0a589244'
root = pathlib.Path(sys.argv[1]).resolve()
actual = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if actual != REVISION:
    raise SystemExit(f'Expected Compositor {REVISION}; found {actual}')

def replace(path, before, after):
    file = root / path
    text = file.read_text()
    if text.count(before) != 1:
        raise SystemExit(f'Upstream boundary changed: {path}')
    file.write_text(text.replace(before, after))

replace('Compositor/Document/EditorSession.swift', '    var document: CanvasDocument?',
        '    var mangaRevision: UInt64 = 0\n    var document: CanvasDocument? { didSet { mangaRevision &+= 1 } }')
# The pinned upstream's project snapshot omits effects. Preserve them in both directions.
replace('Compositor/Document/EditorSession+Projects.swift',
        'shape: layer.liveShape?.style, text: layer.liveText?.style)',
        'shape: layer.liveShape?.style, effects: layer.effects, text: layer.liveText?.style)')
replace('Compositor/Document/EditorSession+Projects.swift',
        'text: LayerText.loaded($0.text, image: snapshot.images[$0.id]?.image))',
        'effects: $0.effects, text: LayerText.loaded($0.text, image: snapshot.images[$0.id]?.image))')
replace('Compositor/IO/CompositorApplicationDelegate.swift',
        '    let workspace = ProjectWorkspace()',
        '    var mangaBridge: MangaBridge?\n    let workspace = ProjectWorkspace()')
replace('Compositor/IO/CompositorApplicationDelegate.swift',
        '        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [updater] in updater.startUpdater() }',
        '''        if let index = CommandLine.arguments.firstIndex(of: "--manga-session"), index + 1 < CommandLine.arguments.count {
            do {
                mangaBridge = try MangaBridge(directory: URL(fileURLWithPath: CommandLine.arguments[index + 1]),
                    session: session, isCurrent: { [weak self] in self?.session === self?.mangaBridge?.session })
                mangaBridge?.start()
            } catch { NSLog("Manga bridge refused: %@", String(describing: error)) }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [updater] in updater.startUpdater() }
        }''')
shutil.copyfile(pathlib.Path(__file__).with_name('MangaBridge.swift'), root / 'Compositor/IO/MangaBridge.swift')
# Keep Xcode's type checker out of the long SwiftUI modifier chain.
replace('Compositor/ContentView.swift',
        """            switch result {
            case .success(let urls): Task { await session.importImages(urls) }
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError { session.importError = error.localizedDescription }
            }""",
        "            handleMangaImport(result)")
replace('Compositor/ContentView.swift',
        '    private func requestNewCanvas() {',
        """    private func handleMangaImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls): Task<Void, Never> { @MainActor in await session.importImages(urls) }
        case .failure(let error):
            if (error as NSError).code != NSUserCancelledError { session.importError = error.localizedDescription }
        }
    }
    private func requestNewCanvas() {""")
