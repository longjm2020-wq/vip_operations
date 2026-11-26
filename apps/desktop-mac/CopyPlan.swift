import Foundation
import Darwin

struct FinderFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct CopyInstruction: Codable {
    let source: String
    let destination: String
    let selection: String
}

// lstat also sees a dangling link at a destination file name.
private func metadata(_ url: URL) throws -> stat? {
    var value = stat()
    if lstat(url.path, &value) == 0 { return value }
    if errno == ENOENT { return nil }
    throw FinderFailure("无法读取指定位置的文件属性，请检查访问权限。")
}

private struct Identity: Equatable {
    let volume: dev_t
    let inode: ino_t
    init(_ st: stat) { volume = st.st_dev; inode = st.st_ino }
}

private func strictDescendant(_ url: URL, of root: URL) -> Bool {
    let base = root.pathComponents, parts = url.pathComponents
    return parts.count >= base.count && Array(parts.prefix(base.count)) == base
}

private func directoryID(_ url: URL) throws -> Identity {
    guard let st = try metadata(url), st.st_mode & S_IFMT == S_IFDIR else {
        throw FinderFailure("指定目录不存在或已被替换。")
    }
    let facts = try url.resourceValues(forKeys: [.volumeIsLocalKey, .isPackageKey, .isAliasFileKey])
    guard facts.volumeIsLocal == true, facts.isPackage != true, facts.isAliasFile != true else {
        throw FinderFailure("请选择本地普通文件夹。")
    }
    return Identity(st)
}

private func checkedLocation(_ raw: String, roots: [URL]) throws -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    guard raw.hasPrefix("~/") || raw.hasPrefix("/Users/"),
          !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          !raw.split(separator: "/").contains(where: { $0.hasPrefix(".") }) else {
        throw FinderFailure("路径必须是用户目录中的明确位置。")
    }
    let url = raw.hasPrefix("~/")
        ? home.appendingPathComponent(String(raw.dropFirst(2))).standardizedFileURL
        : URL(fileURLWithPath: raw).standardizedFileURL
    guard strictDescendant(url, of: home), roots.contains(where: { strictDescendant(url, of: $0) }),
          url.resolvingSymlinksInPath().path == url.path else {
        throw FinderFailure("源和目标都须位于本机已选择的工作目录，路径中不能包含符号链接。")
    }
    var ancestor = url.deletingLastPathComponent()
    while strictDescendant(ancestor, of: home) {
        _ = try directoryID(ancestor)
        if ancestor.path == home.path { break }
        ancestor.deleteLastPathComponent()
    }
    return url
}

struct SourceFile {
    let url: URL
    fileprivate let id: Identity
    let size: off_t
    fileprivate let modified: timespec

    fileprivate init?(_ url: URL) throws {
        guard let st = try metadata(url), st.st_mode & S_IFMT == S_IFREG else { return nil }
        let facts = try url.resourceValues(forKeys: [.volumeIsLocalKey, .isHiddenKey, .isAliasFileKey, .isPackageKey])
        guard facts.volumeIsLocal == true, facts.isHidden != true, facts.isAliasFile != true,
              facts.isPackage != true, !url.lastPathComponent.hasPrefix(".") else { return nil }
        self.url = url; id = Identity(st); size = st.st_size; modified = st.st_mtimespec
    }
    func unchanged() throws -> Bool {
        guard let now = try metadata(url) else { return false }
        return now.st_mode & S_IFMT == S_IFREG && Identity(now) == id && now.st_size == size
            && now.st_mtimespec.tv_sec == modified.tv_sec && now.st_mtimespec.tv_nsec == modified.tv_nsec
    }
}

struct CopyPlan {
    let sourceFolder: URL
    let destination: URL
    let files: [SourceFile]
    private let sourceID: Identity
    private let destinationID: Identity

    init(_ instruction: CopyInstruction, roots: [URL]) throws {
        let source = try checkedLocation(instruction.source, roots: roots)
        destination = try checkedLocation(instruction.destination, roots: roots)
        destinationID = try directoryID(destination)
        switch instruction.selection {
        case "file":
            guard let item = try SourceFile(source) else { throw FinderFailure("源文件必须是普通的可见文件。") }
            sourceFolder = source.deletingLastPathComponent()
            files = [item]
        case "files":
            _ = try directoryID(source)
            sourceFolder = source
            files = try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]).compactMap { try SourceFile($0) }
        default: throw FinderFailure("无法识别复制范围。")
        }
        sourceID = try directoryID(sourceFolder)
        guard sourceID != destinationID, !files.isEmpty else {
            throw FinderFailure("请检查源文件和目标目录。源目录须包含普通文件，且与目标不同。")
        }
        try checkBeforeInput()
    }

    func checkBeforeInput() throws {
        guard sourceFolder.resolvingSymlinksInPath().path == sourceFolder.path,
              destination.resolvingSymlinksInPath().path == destination.path,
              try directoryID(sourceFolder) == sourceID, try directoryID(destination) == destinationID else {
            throw FinderFailure("操作目录已变化，请核对后继续。")
        }
        var names = Set<String>()
        for file in files {
            guard try file.unchanged() else { throw FinderFailure("源文件已变化，请重新核对。") }
            let name = file.url.lastPathComponent
            // Reject ambiguous names even across volumes with different case/normalization rules.
            guard names.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted,
                  try metadata(destination.appendingPathComponent(name)) == nil else {
                throw FinderFailure("存在同名文件，已停止复制，请先核对目标目录。")
            }
        }
    }

    func verifyOutput() async throws {
        let deadline = Date().addingTimeInterval(120)
        while true {
            try Task.checkCancellation()
            guard destination.resolvingSymlinksInPath().path == destination.path,
                  try directoryID(destination) == destinationID else {
                throw FinderFailure("目标目录已变化，请核对复制结果。")
            }
            var ready = true
            for file in files {
                guard try file.unchanged() else { throw FinderFailure("核验时源文件已变化。") }
                let target = destination.appendingPathComponent(file.url.lastPathComponent)
                guard let st = try metadata(target) else { ready = false; break }
                guard st.st_mode & S_IFMT == S_IFREG, Identity(st) != file.id else {
                    throw FinderFailure("目标位置出现不同类型的项目，请核对复制结果。")
                }
                if st.st_size != file.size { ready = false; break }
            }
            if ready {
                // Read only the explicitly authorized source files and their matching new copies.
                for file in files {
                    try Task.checkCancellation()
                    let target = destination.appendingPathComponent(file.url.lastPathComponent)
                    guard FileManager.default.contentsEqual(atPath: file.url.path, andPath: target.path),
                          try file.unchanged() else { throw FinderFailure("目标文件内容仍未核验，请检查 Finder 进度。") }
                }
                try Task.checkCancellation()
                return
            }
            guard Date() < deadline else { throw FinderFailure("尚未核验全部副本，请查看 Finder 进度。") }
            try await Task.sleep(nanoseconds: 350_000_000)
        }
    }
}
