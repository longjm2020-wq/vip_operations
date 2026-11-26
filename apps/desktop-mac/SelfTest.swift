import AppKit

@MainActor func finderSelfTest() async throws {
    let fm = FileManager.default
    let base = fm.homeDirectoryForCurrentUser.appendingPathComponent("XutiFinderSelfTest-" + UUID().uuidString)
    try fm.createDirectory(at: base, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: base) }
    let source = base.appendingPathComponent("src")
    let target = base.appendingPathComponent("dest")
    for directory in [source, target, source.appendingPathComponent("nested")] {
        try fm.createDirectory(at: directory, withIntermediateDirectories: false)
    }
    let file = source.appendingPathComponent("报价 文档.txt")
    let contents = Data("Finder 测试\n".utf8)
    try contents.write(to: file)
    try contents.write(to: source.appendingPathComponent(".hidden"))
    try fm.createSymbolicLink(at: source.appendingPathComponent("alias"), withDestinationURL: file)
    func check(_ ok: Bool, _ message: String) throws {
        if !ok { throw FinderFailure("自测失败：" + message) }
    }
    func reject(_ name: String, _ action: () throws -> Void) throws {
        do { try action() } catch { return }
        throw FinderFailure("自测未拒绝：" + name)
    }
    let select = CopyInstruction(source: source.path, destination: target.path, selection: "files")
    let plan = try CopyPlan(select, roots: [base])
    try check(plan.files.count == 1 && plan.files[0].url.path == file.path, "仅选择当前目录普通文件")
    let instruction = CopyInstruction(source: file.path, destination: target.path, selection: "file")
    _ = try CopyPlan(instruction, roots: [source, target])
    try reject("工作目录越界") { _ = try CopyPlan(instruction, roots: [source]) }
    try reject("同一目录") {
        _ = try CopyPlan(CopyInstruction(source: file.path, destination: source.path, selection: "file"), roots: [base])
    }
    let alias = base.appendingPathComponent("redirect")
    try fm.createSymbolicLink(at: alias, withDestinationURL: target)
    try reject("目标目录符号链接") {
        _ = try CopyPlan(CopyInstruction(source: file.path, destination: alias.path, selection: "file"), roots: [base])
    }
    let output = target.appendingPathComponent(file.lastPathComponent)
    try fm.createSymbolicLink(at: output, withDestinationURL: base.appendingPathComponent("missing"))
    try reject("目标存在悬空链接") { try plan.checkBeforeInput() }
    try fm.removeItem(at: output)
    // Exercise only a private scratch pasteboard. Never read, replace or type into a user's session.
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let item = NSPasteboardItem()
    item.setString(file.absoluteString, forType: .fileURL)
    _ = board.writeObjects([item])
    let sequence = board.changeCount
    try check(FinderInput.checkClipboard(board, plan: plan, count: sequence), "文件剪贴板")
    board.clearContents()
    board.setString("无关内容", forType: .string)
    try check(!FinderInput.checkClipboard(board, plan: plan, count: sequence), "剪贴板已替换")
    try fm.copyItem(at: file, to: output)
    try reject("目标同名") { try plan.checkBeforeInput() }
    try await plan.verifyOutput()
    try Data(repeating: 0, count: contents.count).write(to: output)
    do { try await plan.verifyOutput(); throw TestExpectedFailure() }
    catch is FinderFailure {}
    // Compile the fixed Finder dictionary handlers. No Apple event or keyboard shortcut is sent.
    _ = try FinderInput()
}
private struct TestExpectedFailure: Error {}
