import AppKit

if CommandLine.arguments.dropFirst().elementsEqual(["--self-test"]) {
    Task { @MainActor in
        do {
            try await finderSelfTest()
            print("Finder client self-test passed")
            exit(EXIT_SUCCESS)
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(EXIT_FAILURE)
        }
    }
    RunLoop.main.run()
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = MacWorkspace()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
