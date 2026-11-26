import AppKit

@MainActor final class MacWorkspace: NSObject, NSApplicationDelegate {
    private let service = MacService()
    private var pair: MacPair?
    private var grant: UUID?
    private var roots = [URL]()
    private var poller: Task<Void, Never>?
    private var worker: Task<Void, Never>?
    private var workingID: UUID?
    private var changing = false
    private var quitting = false
    private var window: NSWindow!
    private let code = NSSecureTextField()
    private let name = NSTextField()
    private let account = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let folders = NSTextField(wrappingLabelWithString: "")
    private let pairButton = NSButton()
    private let forgetButton = NSButton()
    private let toggle = NSButton()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出小序 Finder 助手", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; menu.addItem(appItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(); editItem.submenu = editMenu; menu.addItem(editItem); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 365),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "小序 Finder 助手"
        code.placeholderString = "工作台「我的电脑」生成的配对码"
        name.placeholderString = "工作台中显示的设备名"
        name.stringValue = String((Host.current().localizedName ?? "我的 Mac").prefix(80))
        configure(pairButton, title: "连接工作台", action: #selector(connect))
        configure(forgetButton, title: "移除本机配对", action: #selector(forget))
        configure(toggle, title: "开始接单", action: #selector(toggleWork))
        let connectRow = NSStackView(views: [pairButton, forgetButton])
        let help = NSTextField(wrappingLabelWithString: "连接后点击「开始接单」选择工作目录，再在小序聊天中说明要复制的文件和目标目录。复制会使用 Finder 和系统剪贴板。")
        let stack = NSStackView(views: [account, name, code, connectRow, help, folders, toggle, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        let holder = NSView()
        window.contentView = holder
        stack.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: holder.topAnchor, constant: 22),
            name.widthAnchor.constraint(equalTo: stack.widthAnchor), code.widthAnchor.constraint(equalTo: stack.widthAnchor),
            help.widthAnchor.constraint(equalTo: stack.widthAnchor), folders.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor)])
        detail.stringValue = "等待连接。"
        do {
            pair = try PairStore.load()
            if pair != nil { detail.stringValue = "已读取配对。点击「开始接单」启用本次操作。" }
        } catch { detail.stringValue = error.localizedDescription }
        refresh()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func configure(_ button: NSButton, title: String, action: Selector) {
        button.title = title; button.target = self; button.action = action; button.bezelStyle = .rounded
    }

    private func refresh() {
        account.stringValue = pair.map { "工作台账号 · " + $0.owner } ?? "连接我的工作台"
        code.isHidden = pair != nil; name.isHidden = pair != nil; pairButton.isHidden = pair != nil
        forgetButton.isHidden = pair == nil
        pairButton.isEnabled = !changing; forgetButton.isEnabled = !changing && grant == nil
        toggle.title = grant == nil ? "开始接单" : "停止接单"
        toggle.isEnabled = pair != nil && !changing
        folders.stringValue = roots.isEmpty ? "" : "已允许的目录 · " + roots.map { $0.path }.joined(separator: "、")
        folders.maximumNumberOfLines = 2
    }

    @objc private func connect() {
        let value = code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let deviceName = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              !deviceName.isEmpty, deviceName.count <= 80 else {
            detail.stringValue = "请填写设备名和完整的工作台配对码。"; return
        }
        changing = true; refresh()
        Task {
            defer { changing = false; refresh() }
            do {
                let connection = try await service.pair(code: value, name: deviceName)
                try PairStore.save(connection)
                pair = connection; code.stringValue = ""
                detail.stringValue = "已连接。点击「开始接单」选择工作目录。"
            } catch { detail.stringValue = error.localizedDescription }
        }
    }

    @objc private func forget() {
        guard !changing, grant == nil else { return }
        do {
            try PairStore.forget()
            pair = nil; detail.stringValue = "本机已移除配对。可在工作台移除此设备。"; refresh()
        } catch { detail.stringValue = error.localizedDescription }
    }

    @objc private func toggleWork() {
        guard let pair = pair, !changing else { return }
        if grant != nil { stopSession(pair); return }
        let picker = NSOpenPanel()
        picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.canCreateDirectories = false
        picker.allowsMultipleSelection = true; picker.resolvesAliases = false
        picker.message = "选择本次允许读取和复制文件的本机工作目录（可多选）"
        picker.prompt = "允许这些目录"
        guard picker.runModal() == .OK else { return }
        let chosen = picker.urls.map { $0.standardizedFileURL }
        let home = FileManager.default.homeDirectoryForCurrentUser.pathComponents
        guard !chosen.isEmpty, chosen.allSatisfy({ url in
            url.pathComponents.starts(with: home) && url.resolvingSymlinksInPath().path == url.path
        }) else { detail.stringValue = "请选择当前用户目录中的本地文件夹。"; return }
        do { try FinderInput.requestPermissions() }
        catch { detail.stringValue = error.localizedDescription; return }
        changing = true; refresh()
        Task {
            defer { changing = false; refresh() }
            do {
                let reply = try await service.authorize(pair, enabled: true)
                guard let authorization = reply.authorizationId else { throw FinderFailure("工作台未确认操作授权。") }
                roots = chosen; grant = authorization
                detail.stringValue = "正在接单。可在小序聊天中选择这台 Mac。"
                poller = Task { await self.pollLoop(pair: pair, grant: authorization, roots: chosen) }
            } catch { detail.stringValue = error.localizedDescription }
        }
    }

    private func disarm() {
        grant = nil; roots = []
        poller?.cancel(); poller = nil; worker?.cancel(); worker = nil; workingID = nil
        refresh()
    }

    private func stopSession(_ connection: MacPair) {
        changing = true; disarm()
        detail.stringValue = "已在本机停止接单。"
        Task {
            defer { changing = false; refresh() }
            do { _ = try await service.authorize(connection, enabled: false) }
            catch { detail.stringValue = "本机已停止。工作台撤销授权待确认，请查看设备状态。" }
        }
    }

    private func pollLoop(pair: MacPair, grant expected: UUID, roots: [URL]) async {
        while grant == expected && !Task.isCancelled {
            let prior = workingID
            do {
                let poll = try await service.poll(pair)
                try Task.checkCancellation()
                guard grant == expected else { return }
                guard poll.authorizationId == expected else {
                    disarm(); detail.stringValue = "工作台已撤销授权。"; return
                }
                if let current = prior, current == workingID {
                    if poll.task?.id != current || !["WAITING", "RUNNING"].contains(poll.task?.status ?? "") {
                        worker?.cancel()
                    }
                } else if prior == nil, workingID == nil, let task = poll.task {
                    if task.status == "WAITING", task.nativeAction == "copy_finder_files", let instruction = task.fileCopy {
                        workingID = task.id
                        worker = Task { await self.execute(task.id, instruction, pair: pair, grant: expected, roots: roots) }
                    } else if task.status == "RUNNING" {
                        try await service.pause(task.id, pair: pair)
                        detail.stringValue = "旧任务已暂停，请核对目标目录后在工作台继续。"
                    }
                }
            } catch {
                if Task.isCancelled || grant != expected { return }
                if let failure = error as? MacServiceError, [401, 403].contains(failure.status) {
                    disarm(); detail.stringValue = failure.localizedDescription; return
                }
                detail.stringValue = "连接暂时中断，正在重新查询任务状态。"
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    private func execute(_ id: UUID, _ instruction: CopyInstruction, pair: MacPair, grant expected: UUID, roots: [URL]) async {
        let attempt = UUID()
        func gate(_ action: MacService.Action) async throws {
            try Task.checkCancellation()
            guard grant == expected, workingID == id else { throw CancellationError() }
            try await service.progress(action, task: id, attempt: attempt, grant: expected, pair: pair)
            try Task.checkCancellation()
        }
        defer { if grant == expected && workingID == id { workingID = nil; worker = nil } }
        do {
            try await gate(.start)
            let plan = try CopyPlan(instruction, roots: roots)
            let finder = try FinderInput()
            detail.stringValue = "正在核对 Finder 中的源文件。"
            let source = try await finder.open(plan, source: true)
            try await gate(.permitCopy)
            let baseline = try finder.shortcut(plan: plan, windowId: source)
            let sequence = try await finder.copiedSequence(plan: plan, after: baseline)
            try await gate(.copied)
            let destination = try await finder.open(plan, source: false)
            try await gate(.permitPaste)
            _ = try finder.shortcut(plan: plan, windowId: destination, clipboard: sequence)
            detail.stringValue = "已发送 ⌘V，正在核验目标目录中的文件。"
            try await plan.verifyOutput()
            try await gate(.complete)
            detail.stringValue = "复制已完成，已核验 \(plan.files.count) 个文件。"
        } catch {
            if grant != expected || Task.isCancelled { return }
            let note = (error as? FinderFailure)?.message ?? "未确认任务完成，请检查 Finder 和目标目录后继续。"
            detail.stringValue = note
            try? await service.progress(.handoff, task: id, attempt: attempt, grant: expected, pair: pair, note: note)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting, let connection = pair, grant != nil else { return .terminateNow }
        quitting = true
        disarm()
        Task {
            _ = try? await service.authorize(connection, enabled: false)
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
