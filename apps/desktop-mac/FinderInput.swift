import AppKit
import ApplicationServices

// This script has only fixed Finder commands. Paths are typed Apple event parameters.
private let finderScript = """
on destinationWindow(folderPath)
    set folderAlias to (POSIX file folderPath) as alias
    tell application id "com.apple.finder"
        set w to make new Finder window to folderAlias
        activate
        return (id of w) as text
    end tell
end destinationWindow

on currentWindow()
    tell application id "com.apple.finder"
        if not frontmost or (count of Finder windows) = 0 then return {}
        set w to front Finder window
        set dirAlias to (target of w) as alias
        set selectedPaths to {}
        repeat with chosen in (get selection)
            set end of selectedPaths to POSIX path of (chosen as alias)
        end repeat
        return {(id of w) as text, POSIX path of dirAlias, selectedPaths}
    end tell
end currentWindow
"""

private struct FinderWindow {
    let id: String
    let directory: String
    let selected: [String]
}

@MainActor final class FinderInput {
    private let script: NSAppleScript
    init() throws {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: finderScript), script.compileAndReturnError(&error) else {
            throw FinderFailure("无法加载 Finder 操作，请检查 macOS 版本。")
        }
        self.script = script
    }

    static func requestPermissions() throws {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        guard AXIsProcessTrustedWithOptions(options) else {
            throw FinderFailure("请在系统设置的「隐私与安全性 → 辅助功能」允许小序 Finder 助手，再点击开始接单。")
        }
        var error: NSDictionary?
        _ = NSAppleScript(source: "tell application id \"com.apple.finder\" to get version")?.executeAndReturnError(&error)
        guard error == nil else {
            throw FinderFailure("请在系统设置的「隐私与安全性 → 自动化」允许此助手控制 Finder，再点击开始接单。")
        }
    }

    private func call(_ handler: String, argument: String? = nil) throws -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(eventClass: 0x61736372, eventID: 0x70736272,
            targetDescriptor: nil, returnID: -1, transactionID: 0)
        event.setParam(NSAppleEventDescriptor(string: handler), forKeyword: 0x736e616d)
        let arguments = NSAppleEventDescriptor.list()
        if let argument = argument { arguments.insert(NSAppleEventDescriptor(string: argument), at: 1) }
        event.setParam(arguments, forKeyword: 0x2d2d2d2d)
        var error: NSDictionary?
        let result = script.executeAppleEvent(event, error: &error)
        guard error == nil else { throw FinderFailure("无法核对 Finder 窗口，请检查 Finder 的自动化权限。") }
        return result
    }

    private func snapshot() throws -> FinderWindow? {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.finder" else { return nil }
        let descriptor = try call("currentwindow")
        guard descriptor.numberOfItems == 3, let id = descriptor.atIndex(1)?.stringValue, !id.isEmpty,
              let path = descriptor.atIndex(2)?.stringValue,
              let selection = descriptor.atIndex(3) else { return nil }
        var files = [String]()
        for i in 0..<selection.numberOfItems {
            guard let file = selection.atIndex(i + 1)?.stringValue else { return nil }
            files.append(URL(fileURLWithPath: file).standardizedFileURL.path)
        }
        return FinderWindow(id: id, directory: URL(fileURLWithPath: path).standardizedFileURL.path, selected: files)
    }

    private func matches(_ window: FinderWindow, plan: CopyPlan, source: Bool) -> Bool {
        if !source { return window.directory == plan.destination.path && window.selected.isEmpty }
        return window.directory == plan.sourceFolder.path && window.selected.count == plan.files.count
            && Set(window.selected) == Set(plan.files.map { $0.url.path })
    }

    func open(_ plan: CopyPlan, source: Bool) async throws -> String {
        try Task.checkCancellation()
        try plan.checkBeforeInput()
        var wanted: String?
        if source {
            NSWorkspace.shared.activateFileViewerSelecting(plan.files.map { $0.url })
        } else {
            wanted = try call("destinationwindow", argument: plan.destination.path).stringValue
            guard let id = wanted, !id.isEmpty else { throw FinderFailure("无法识别目标 Finder 窗口。") }
        }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            try Task.checkCancellation()
            if let window = try snapshot(), wanted == nil || window.id == wanted, matches(window, plan: plan, source: source) {
                return window.id
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        throw FinderFailure("Finder 窗口或所选项目未匹配，请核对后继续。")
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func element(_ object: CFTypeRef?) -> AXUIElement? {
        guard let object = object, CFGetTypeID(object) == AXUIElementGetTypeID() else { return nil }
        return (object as! AXUIElement)
    }
    private func ordinaryFocus(_ pid: pid_t) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        guard let window = element(attribute(app, "AXFocusedWindow")),
              attribute(window, "AXSubrole") as? String == "AXStandardWindow",
              (attribute(window, "AXSheets") as? [Any] ?? []).isEmpty,
              let focus = element(attribute(app, "AXFocusedUIElement")) else { return false }
        var current = focus
        let blocked: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSheet", "AXDialog", "AXMenu", "AXToolbar"]
        for _ in 0..<32 {
            if CFEqual(current, window) { return true }
            guard let role = attribute(current, "AXRole") as? String, !blocked.contains(role),
                  let next = element(attribute(current, "AXParent")) else { return false }
            current = next
        }
        return false
    }

    static func checkClipboard(_ board: NSPasteboard, plan: CopyPlan, count: Int) -> Bool {
        guard board.changeCount == count, let items = board.pasteboardItems, items.count == plan.files.count else { return false }
        let paths = items.compactMap { item -> String? in
            guard let raw = item.string(forType: .fileURL), let url = URL(string: raw), url.isFileURL,
                  url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
            return url.standardizedFileURL.path
        }
        return paths.count == items.count && Set(paths) == Set(plan.files.map { $0.url.path }) && board.changeCount == count
    }

    // Each call follows one server permit. Never retry a keyboard event or send it globally.
    func shortcut(plan: CopyPlan, windowId: String, clipboard: Int? = nil) throws -> Int {
        try Task.checkCancellation()
        try plan.checkBeforeInput()
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == "com.apple.finder",
              let window = try snapshot(), window.id == windowId, matches(window, plan: plan, source: clipboard == nil),
              ordinaryFocus(app.processIdentifier) else {
            throw FinderFailure("Finder 前台窗口、焦点或所选文件已改变。")
        }
        let board = NSPasteboard.general
        if let sequence = clipboard, !Self.checkClipboard(board, plan: plan, count: sequence) {
            throw FinderFailure("剪贴板已变化，请重新核对。")
        }
        let baseline = board.changeCount
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let down = CGEvent(keyboardEventSource: nil, virtualKey: clipboard == nil ? 8 : 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: clipboard == nil ? 8 : 9, keyDown: false) else {
            throw FinderFailure("Finder 已失去焦点，快捷键未发送。")
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(app.processIdentifier)
        up.postToPid(app.processIdentifier)
        return baseline
    }

    func copiedSequence(plan: CopyPlan, after baseline: Int) async throws -> Int {
        let board = NSPasteboard.general, deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            try Task.checkCancellation()
            let sequence = board.changeCount
            if sequence != baseline && Self.checkClipboard(board, plan: plan, count: sequence) { return sequence }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw FinderFailure("未在剪贴板中核验到本任务选中的文件，请检查 Finder。")
    }
}
