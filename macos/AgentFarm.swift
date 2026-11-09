// Agent Farm for macOS: starts the bundled farm server (its own copy of Node) and shows the farm
// in a window, with a menu-bar and Dock count of agents waiting for you and native notifications.
// Built by macos/build.sh; no Xcode project needed.
import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let zh = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
func L(_ en: String, _ zhText: String) -> String { zh ? zhText : en }

/// WKUserContentController keeps its handlers alive; this breaks the retain cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ t: any WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {

    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var countItem: NSMenuItem!
    var loginItem: NSMenuItem!
    var server: Process?
    var port = 5180
    var ready = false
    var quitting = false
    var waiting = 0
    var working = 0

    var farmURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    let dataDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Agent Farm", isDirectory: true)
    let logURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/Agent Farm/server.log")

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMainMenu()
        buildStatusItem()
        buildWindow()
        checkLocation()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        Task { await startFarm() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showFarm()
        return true
    }

    func applicationWillTerminate(_ n: Notification) {
        quitting = true
        guard let p = server, p.isRunning else { return }
        p.terminate()
        for _ in 0..<30 where p.isRunning { usleep(100_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    /// Running from the DMG or a translocated copy: the hook paths shown in the help would break.
    func checkLocation() {
        let path = Bundle.main.bundlePath
        let readOnly = (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeIsReadOnlyKey]))?
            .volumeIsReadOnly ?? false
        guard path.contains("/AppTranslocation/") || readOnly else { return }
        let a = NSAlert()
        a.messageText = L("Move Agent Farm to Applications first", "請先把 Agent Farm 拖到「應用程式」")
        a.informativeText = L(
            "It is running from the disk image or a temporary location, so the Claude Code hook path it gives you would stop working later. Drag Agent Farm into the Applications folder and open it from there.",
            "現在是從安裝映像檔或暫存位置執行，說明裡給的 Claude Code 掛鉤路徑之後會失效。請把 Agent Farm 拖進「應用程式」資料夾，再從那裡打開。")
        a.addButton(withTitle: L("Quit", "結束"))
        a.addButton(withTitle: L("Open Anyway", "仍然打開"))
        if a.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
    }

    // MARK: server

    /// What answers on a port: nil = nothing, true = an Agent Farm, false = something else.
    nonisolated static func probe(_ port: Int) async -> Bool? {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        req.timeoutInterval = 1.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            return j["ok"] as? Bool == true
        } catch let e as URLError where e.code == .cannotConnectToHost {
            return nil
        } catch {
            return false
        }
    }

    func startFarm() async {
        ready = false
        for p in 5180...5199 {
            switch await Self.probe(p) {
            case .some(true):  // a farm is already running here (e.g. `npm start`): just show it
                port = p
                loadFarm()
                return
            case .none:
                port = p
                guard launchServer() else { return }
                for _ in 0..<80 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    if server?.isRunning != true { return }  // serverExited shows the error
                    if await Self.probe(p) == true {
                        loadFarm()
                        return
                    }
                }
                showError(L("The farm server didn't start in time.", "農場伺服器沒有在時間內啟動。"))
                return
            default:
                continue
            }
        }
        showError(L("No free port between 5180 and 5199.", "5180 到 5199 之間沒有可用的連接埠。"))
    }

    func launchServer() -> Bool {
        guard let node = Bundle.main.url(forAuxiliaryExecutable: "node"),
              let res = Bundle.main.resourceURL else {
            showError(L("The app is missing its Node runtime.", "App 裡缺少 Node 執行檔。"))
            return false
        }
        let app = res.appendingPathComponent("app", isDirectory: true)
        let p = Process()
        p.executableURL = node
        p.arguments = [app.appendingPathComponent("server/server.mjs").path, "--port", String(port)]
        p.currentDirectoryURL = app
        var env = ProcessInfo.processInfo.environment
        env["FARM_APP"] = "1"
        env["FARM_DATA_DIR"] = dataDir.path
        env["HOST"] = "127.0.0.1"
        for k in ["PORT", "FARM_TOKEN", "NODE_OPTIONS"] { env.removeValue(forKey: k) }
        p.environment = env
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = fh
            p.standardError = fh
        }
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            Task { @MainActor in self?.serverExited(code) }
        }
        do {
            try p.run()
        } catch {
            showError(error.localizedDescription)
            return false
        }
        server = p
        return true
    }

    func serverExited(_ code: Int32) {
        server = nil
        if quitting { return }
        ready = false
        showError(L("The farm server stopped (exit code \(code)).", "農場伺服器停止了（結束代碼 \(code)）。"))
    }

    @objc func restartFarm() {
        if let p = server, p.isRunning {
            quitting = true
            p.terminate()
            p.waitUntilExit()
            quitting = false
            server = nil
        }
        webView.loadHTMLString(page(L("Starting the farm…", "農場啟動中…")), baseURL: nil)
        Task { await startFarm() }
    }

    // MARK: window

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(WeakHandler(self), name: "farm")
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(red: 0.61, green: 0.83, blue: 0.95, alpha: 1)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Farm"
        window.minSize = NSSize(width: 720, height: 520)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.center()
        window.setFrameAutosaveName("AgentFarmWindow")
        webView.loadHTMLString(page(L("Starting the farm…", "農場啟動中…")), baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // closing the window keeps the farm running (menu bar, Dock badge, notifications)
    func windowShouldClose(_ w: NSWindow) -> Bool {
        w.orderOut(nil)
        return false
    }

    @objc func showFarm() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openInBrowser() { NSWorkspace.shared.open(farmURL) }

    @objc func reloadFarm() {
        if ready { loadFarm() } else { restartFarm() }
    }

    func loadFarm() {
        ready = true
        webView.load(URLRequest(url: farmURL))
    }

    func showError(_ msg: String) {
        ready = false
        let log = logURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        webView.loadHTMLString(page(msg, detail: L("Log: \(log)", "紀錄檔：\(log)"),
                                    button: L("Restart the farm", "重新啟動農場")), baseURL: nil)
        showFarm()
    }

    func page(_ title: String, detail: String = "", button: String = "") -> String {
        let esc = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        let btn = button.isEmpty ? "" :
            "<button onclick=\"webkit.messageHandlers.farm.postMessage({type:'restart'})\">\(esc(button))</button>"
        return """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:light dark}
        body{margin:0;height:100vh;display:grid;place-items:center;font:600 17px -apple-system,system-ui;
          background:linear-gradient(#9BD3F2,#DDF1E6);color:#2b3a2e;text-align:center}
        @media(prefers-color-scheme:dark){body{background:linear-gradient(#182452,#2a3a5e);color:#e8eefc}}
        .s{font-size:46px;margin-bottom:12px}small{display:block;margin-top:10px;opacity:.7;font-weight:500;font-size:13px}
        button{margin-top:18px;font:700 14px -apple-system;padding:9px 18px;border-radius:999px;border:0;
          background:#5E9C3E;color:#fff;cursor:pointer}
        </style><div><div class="s">🌱</div>\(esc(title))<small>\(esc(detail))</small>\(btn)</div>
        """
    }

    // MARK: web view

    func isFarm(_ u: URL?) -> Bool { u?.host == "127.0.0.1" && u?.port == port }

    // links to anything outside the farm open in the default browser
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let u = a.request.url, ["http", "https"].contains(u.scheme ?? ""), !isFarm(u) else { return .allow }
        if a.targetFrame?.isMainFrame ?? true {
            NSWorkspace.shared.open(u)
            return .cancel
        }
        return .allow
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
                 windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        if ready { showError(e.localizedDescription) }
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        if ready { loadFarm() }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, let d = m.body as? [String: Any], let type = d["type"] as? String else { return }
        let fromFarm = isFarm(m.frameInfo.request.url)
        switch type {
        case "status" where fromFarm:
            waiting = (d["waiting"] as? NSNumber)?.intValue ?? 0
            working = (d["working"] as? NSNumber)?.intValue ?? 0
            updateStatusItem()
        case "notify" where fromFarm:
            notify(id: d["id"] as? String ?? "", body: d["body"] as? String ?? "")
        case "restart" where !fromFarm:
            restartFarm()
        default:
            break
        }
    }

    // MARK: notifications

    func notify(id: String, body: String) {
        // the page already shows a toast when you're looking at it
        if NSApp.isActive && window.isVisible && !window.isMiniaturized { return }
        let c = UNMutableNotificationContent()
        c.title = "Agent Farm"
        c.body = body
        c.sound = .default
        c.userInfo = ["id": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "farm-\(id)", content: c, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let id = r.notification.request.content.userInfo["id"] as? String ?? ""
        Task { @MainActor in
            self.showFarm()
            if let j = try? JSONSerialization.data(withJSONObject: [id]), let arr = String(data: j, encoding: .utf8) {
                _ = try? await self.webView.evaluateJavaScript("window.farmSelect && window.farmSelect(\(arr)[0])")
            }
        }
        done()
    }

    // MARK: menu bar

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let m = NSMenu()
        m.delegate = self
        m.addItem(withTitle: L("Open Farm", "打開農場"), action: #selector(showFarm), keyEquivalent: "")
        m.addItem(withTitle: L("Open in Browser", "在瀏覽器打開"), action: #selector(openInBrowser), keyEquivalent: "")
        m.addItem(.separator())
        countItem = m.addItem(withTitle: "", action: nil, keyEquivalent: "")
        countItem.isEnabled = false
        m.addItem(.separator())
        loginItem = m.addItem(withTitle: L("Open at Login", "登入時自動開啟"), action: #selector(toggleLogin), keyEquivalent: "")
        m.addItem(withTitle: L("Quit Agent Farm", "結束 Agent Farm"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        for i in m.items where i.action != #selector(NSApplication.terminate(_:)) { i.target = self }
        statusItem.menu = m
        updateStatusItem()
    }

    func menuNeedsUpdate(_ m: NSMenu) {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    func updateStatusItem() {
        if let b = statusItem.button {
            b.image = NSImage(systemSymbolName: waiting > 0 ? "exclamationmark.bubble.fill" : "leaf.fill",
                              accessibilityDescription: "Agent Farm")
            b.image?.isTemplate = true
            b.imagePosition = .imageLeading
            b.title = waiting > 0 ? " \(waiting)" : ""
            b.toolTip = countItem.title
        }
        countItem.title = L("\(working) working · \(waiting) waiting for you", "\(working) 個工作中 · \(waiting) 個等你回覆")
        NSApp.dockTile.badgeLabel = waiting > 0 ? String(waiting) : nil
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    // MARK: main menu (Edit is needed for copy/paste in the web view)

    func buildMainMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            item.submenu = m
            main.addItem(item)
            return m
        }
        func it(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command,
                target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        _ = sub("Agent Farm", [
            it(L("About Agent Farm", "關於 Agent Farm"), #selector(about), target: self),
            .separator(),
            it(L("Hide Agent Farm", "隱藏 Agent Farm"), #selector(NSApplication.hide(_:)), "h"),
            it(L("Hide Others", "隱藏其他"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            it(L("Show All", "顯示全部"), #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            it(L("Quit Agent Farm", "結束 Agent Farm"), #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = sub(L("Edit", "編輯"), [
            it(L("Undo", "還原"), Selector(("undo:")), "z"),
            it(L("Redo", "重做"), Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            it(L("Cut", "剪下"), #selector(NSText.cut(_:)), "x"),
            it(L("Copy", "拷貝"), #selector(NSText.copy(_:)), "c"),
            it(L("Paste", "貼上"), #selector(NSText.paste(_:)), "v"),
            it(L("Select All", "全選"), #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = sub(L("View", "顯示方式"), [
            it(L("Reload", "重新載入"), #selector(reloadFarm), "r", target: self),
            it(L("Open in Browser", "在瀏覽器打開"), #selector(openInBrowser), "o", [.command, .shift], target: self),
            .separator(),
            it(L("Enter Full Screen", "進入全螢幕"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let win = sub(L("Window", "視窗"), [
            it(L("Minimize", "縮到最小"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            it(L("Zoom", "縮放"), #selector(NSWindow.performZoom(_:))),
            it(L("Close", "關閉"), #selector(NSWindow.performClose(_:)), "w"),
            .separator(),
            it(L("Agent Farm", "Agent Farm"), #selector(showFarm), "0", target: self),
        ])
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc func about() {
        let link = "https://github.com/irons163/agent-farm"
        let credits = NSMutableAttributedString(string: link, attributes: [
            .link: URL(string: link)!, .font: NSFont.systemFont(ofSize: 11)])
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
        NSApp.activate(ignoringOtherApps: true)
    }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
