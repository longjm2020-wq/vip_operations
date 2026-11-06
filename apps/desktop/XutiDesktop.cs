// .NET Framework 4.8 / C# 5. No listener, shell runner, clipboard reader or browser-profile access.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Linq;

namespace XutiDesktop {
static class Program {
    [STAThread] static int Main(string[] args) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (args.Length == 1 && args[0] == "--self-test") return Native.SelfTest() + ShellPolicy.SelfTest();
        if (args.Length == 1 && args[0] == "--runtime-check") return DesktopShell.CheckRuntime();
        bool first;
        using (var mutex = new System.Threading.Mutex(true, "Local\\XutiDesktopAssistant", out first)) {
            if (!first) { MessageBox.Show("小序已经运行，请切换至已打开的窗口。"); return 1; }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new DesktopShell());
        }
        return 0;
    }
}
sealed class ApiFailure : Exception {
    public readonly int Status;
    public ApiFailure(int status, string text) : base(text) { Status = status; }
}
sealed class WindowChoice {
    public string Id = Guid.NewGuid().ToString();
    public IntPtr Handle;
    public string Title, App;
    public int Pid;
    public long Started;
    public override string ToString() { return App + " · " + Title; }
}
sealed class Shot {
    public string Image, Controls;
    public int Width, Height;
    public Native.RECT Rect;
}
sealed class AssistantForm : Form {
    const string Origin = "https://vip-web-production.up.railway.app";
    const string Base = Origin + "/api/v1/my-workspace/assistant/desktop/client/";
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
    readonly HttpClient http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(110) };
    readonly string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XutiDesktopAssistant");
    readonly TextBox code = new TextBox { Width = 300, MaxLength = 32 };
    readonly Label connection = new Label { AutoSize = true, MaximumSize = new Size(580, 0) };
    readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(580, 0), Text = "连接后等待网站发送任务。" };
    readonly Label instruction = new Label { AutoSize = true, MaximumSize = new Size(580, 0), Font = new Font("Microsoft YaHei UI", 11, FontStyle.Bold) };
    readonly ComboBox windows = new ComboBox { Width = 565, DropDownStyle = ComboBoxStyle.DropDownList };
    readonly Button allow = new Button { Text = "允许本次任务", AutoSize = true, Enabled = false };
    readonly Button pause = new Button { Text = "暂停", AutoSize = true };
    readonly Button stop = new Button { Text = "停止 (Ctrl+Alt+X)", AutoSize = true };
    readonly Button authorization = new Button { Text = "授权跨窗口操作", AutoSize = true };
    readonly Label permission = new Label { AutoSize = true, MaximumSize = new Size(570, 0) };
    readonly Timer timer = new Timer { Interval = 2000 };
    string token = "", owner = "", deviceId = "", taskId = "", approvedId = "", state = "";
    string authorizationId = "", activeAuthorizationId = "", autoAttemptedId = "";
    bool changingAuthorization;
    long permissionEpoch;
    public event Action Changed;
    public bool Connected { get { return token.Length > 0; } }
    public string DeviceId { get { return deviceId; } }
    public string ConnectionText { get { return connection.Text; } }
    public string TaskText { get { return status.Text; } }
    bool started, pairing;
    WindowChoice selected;
    bool polling, working, armed, closing, captureBlocked, allowing;
    long epoch;
    Dictionary<string, object> task;
    readonly Dictionary<string, string> journal = new Dictionary<string, string>();
    Native.Hook inputHook;

    public AssistantForm() {
        Text = "电脑任务"; Width = 650; Height = 590; MinimumSize = new Size(620, 510);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(246, 247, 252);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(20) };
        Controls.Add(layout);
        layout.Controls.Add(new Label { Text = "电脑任务", AutoSize = true, Font = new Font(Font.FontFamily, 17, FontStyle.Bold), Margin = new Padding(0, 0, 0, 12) });
        layout.Controls.Add(new Label { Text = "在工作台的小序中点击「连接本机」；也可粘贴其他浏览器生成的配对码。", AutoSize = true, MaximumSize = new Size(570, 0) });
        var pairing = new FlowLayoutPanel { AutoSize = true };
        var pair = new Button { Text = "连接", AutoSize = true };
        var disconnect = new Button { Text = "断开本机", AutoSize = true };
        pairing.Controls.Add(code); pairing.Controls.Add(pair); pairing.Controls.Add(disconnect); layout.Controls.Add(pairing);
        layout.Controls.Add(connection);
        layout.Controls.Add(new Label { Text = "设备授权", AutoSize = true, Margin = new Padding(0, 18, 0, 5) });
        layout.Controls.Add(permission); layout.Controls.Add(authorization);
        layout.Controls.Add(new Label { Text = "当前任务", AutoSize = true, Margin = new Padding(0, 18, 0, 5) });
        layout.Controls.Add(instruction); layout.Controls.Add(status);
        layout.Controls.Add(new Label { Text = "起始窗口（跨窗口授权后可自动选择）", AutoSize = true, Margin = new Padding(0, 18, 0, 5) });
        layout.Controls.Add(windows);
        var buttons = new FlowLayoutPanel { AutoSize = true };
        var refresh = new Button { Text = "刷新窗口", AutoSize = true };
        buttons.Controls.Add(refresh); buttons.Controls.Add(allow); buttons.Controls.Add(pause); buttons.Controls.Add(stop); layout.Controls.Add(buttons);
        layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(570, 0), Margin = new Padding(0, 14, 0, 0), Text = "逐次允许时仅操作选定窗口。记住设备授权后，新任务自动开始，可切换已打开的普通应用和网页。授权在重启后保留，可随时在这里或网站撤销。\n\n操作窗口的画面、控件文字和跨窗口模式下的可用窗口标题会发送至智能服务，截图不保存。手动操作会暂停；登录、验证码、付款、发送和删除由你接手。不要以管理员身份运行助手。" });
        pair.Click += async (s, e) => await Safe(async () => {
            pair.Enabled = false;
            try {
                await PairCode(code.Text.Trim());
            } finally { pair.Enabled = true; }
        });
        disconnect.Click += async (s,e) => await Safe(Disconnect);
        refresh.Click += (s,e) => { if (!armed) RefreshWindows(); };
        allow.Click += async (s,e) => await Safe(AllowTask);
        authorization.Click += async (s,e) => await Safe(ChangeAuthorization);
        pause.Click += async (s,e) => await Safe(async () => { LocalPause(); await Control("pause", "你已暂停操作"); });
        stop.Click += async (s,e) => await StopTask();
        timer.Tick += async (s,e) => await Poll();
        Shown += (s,e) => StartEngine();
        FormClosing += (s,e) => Shutdown();
    }
    public void StartEngine() {
            if (started) return;
            started = true;
            try {
                LoadSaved(); ShowConnection(); RefreshWindows();
                if (!Native.RegisterHotKey(Handle, 1, 3, 0x58)) throw new Exception("无法注册停止快捷键，请关闭占用 Ctrl+Alt+X 的程序后重启助手。");
                inputHook = new Native.Hook(() => {
                    if ((!armed && !allowing) || closing) return;
                    LocalPause();
                    BeginInvoke(new Action(async () => await Safe(async () => await Control("pause", "检测到你的手动操作，已暂停"))));
                });
                timer.Start();
            } catch(Exception ex) { status.Text = ex.Message; allow.Enabled = false; }
    }
    public async Task PairCode(string value) {
        if (pairing) throw new Exception("正在连接，请稍候。");
        if (Connected) throw new Exception("本机已有连接。如需更换账号，请在电脑任务中先断开本机。");
        if (!Regex.IsMatch(value ?? "", "^[a-f0-9]{32}$")) throw new Exception("配对码格式不正确，请重新生成。");
        pairing = true;
        try {
            var data = await Request("pair", new { code = value, name = Environment.MachineName }, false);
            string nextToken = S(data,"token"), nextId = S(data,"deviceId"), nextOwner = S(data,"owner");
            Guid parsed;
            if (!Regex.IsMatch(nextToken,"^[a-f0-9]{64}$") || !Guid.TryParse(nextId,out parsed)) throw new Exception("连接返回无效。");
            SaveProtected("connection.bin",json.Serialize(new { token=nextToken, owner=nextOwner, deviceId=nextId, origin=Origin }));
        token=nextToken; owner=nextOwner; deviceId=nextId; authorizationId=""; permissionEpoch++;
            code.Clear(); ShowConnection();
        } finally { pairing=false; }
    }
    public async Task Disconnect() {
        bool hadGrant=authorizationId.Length>0;
        LocalPause(); permissionEpoch++; authorizationId="";
        try {
            if(hadGrant && token.Length>0) await Request("authorization",new {enabled=false});
            if (taskId.Length > 0 && token.Length > 0) await Control("stop", "本机连接已断开");
        }
        finally {
            token=""; owner=""; deviceId=""; taskId=""; task=null; approvedId="";
            if (File.Exists(Path.Combine(folder,"connection.bin"))) File.Delete(Path.Combine(folder,"connection.bin"));
            ShowConnection(); status.Text="本机已断开。网站可撤销设备授权。";
        }
    }
    public async Task EndSession() {
        LocalPause();
        await Safe(async () => await Control("pause", "小序桌面端已退出，请重新打开并核对窗口后继续"));
    }
    public void Shutdown() {
        if(closing) return;
        closing=true; LocalPause(); timer.Stop();
        if(inputHook!=null) { inputHook.Dispose(); inputHook=null; }
        if(IsHandleCreated) Native.UnregisterHotKey(Handle,1);
    }
    protected override void Dispose(bool disposing) {
        if(disposing) { Shutdown(); timer.Dispose(); http.Dispose(); }
        base.Dispose(disposing);
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x312) { LocalPause(); BeginInvoke(new Action(async () => await StopTask())); }
        base.WndProc(ref m);
    }
    void ShowConnection() {
        connection.Text = token.Length > 0 ? "已连接 · " + owner : "未连接本机";
        bool granted = authorizationId.Length > 0;
        permission.Text = granted ? "已记住这台设备的跨窗口授权，直到手动撤销。新任务自动执行；暂停后由你继续。" : "逐次允许：每次任务在本机选择一个窗口并允许。";
        authorization.Text = granted ? "撤销跨窗口授权" : "授权跨窗口操作";
        authorization.Enabled = Connected && !changingAuthorization;
        allow.Text = granted ? "继续当前任务" : "允许本次任务";
        if(Changed!=null) Changed();
    }
    void SaveConnection() {
        SaveProtected("connection.bin",json.Serialize(new { token, owner, deviceId, origin=Origin, authorizationId }));
    }
    async Task ChangeAuthorization() {
        if (!Connected || changingAuthorization) return;
        bool enable = authorizationId.Length == 0;
        if (enable && MessageBox.Show(this,
            "允许小序在这台电脑上切换已打开的普通应用和网页，并执行你发送的电脑任务。\n\n新任务会自动开始。操作窗口的画面、控件文字及可用窗口标题将交给网站配置的智能服务处理。\n\n授权绑定当前账号与本机连接，重启后保留，直到你在本机或网站撤销；断开或重新配对后需重新授权。手动操作会暂停，Ctrl+Alt+X 可停止。登录、付款、发送、删除等仍由你接手。\n\n记住这台设备的跨窗口授权？",
            "设备授权", MessageBoxButtons.YesNo, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        changingAuthorization=true; permissionEpoch++; LocalPause(); ShowConnection();
        string connectionToken=token;
        try {
            if (!enable) {
                authorizationId="";
                // Always revoke remotely even if the local encrypted file cannot be written.
                Exception storageFailure=null;
                try { SaveConnection(); } catch(Exception e) { storageFailure=e; }
                Exception remoteFailure=null;
                try { await Request("authorization",new {enabled=false}); } catch(Exception e) { remoteFailure=e; }
                if(remoteFailure!=null) throw new Exception(storageFailure==null
                    ? "已在本机撤销，云端同步失败；联网后会重试，也可从网站撤销。"
                    : "本机已暂停，但撤销未能保存或同步；请在网站撤销授权后再重启客户端。");
                if(storageFailure!=null) throw new Exception("服务端已撤销授权，本机保存失败，请检查磁盘后重试。");
                status.Text="跨窗口授权已撤销，当前任务已暂停。";
            } else {
                var result=await Request("authorization",new {enabled=true});
                if(token!=connectionToken || closing) return;
                string grant=S(result,"authorizationId"); Guid parsed;
                if(!Guid.TryParse(grant,out parsed)) throw new Exception("授权返回无效，请更新网站和桌面端。");
                authorizationId=grant;
                bool saved=true;
                try { SaveConnection(); } catch { authorizationId=""; saved=false; }
                if(!saved) {
                    await Request("authorization",new {enabled=false});
                    throw new Exception("未能保存设备授权，请检查磁盘后重试。");
                }
                status.Text="已记住设备授权。你发送的新任务将自动开始，暂停的任务请点击继续。";
            }
        } finally { changingAuthorization=false; ShowConnection(); }
    }
    void SaveProtected(string name, string value) {
        Directory.CreateDirectory(folder);
        byte[] bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser);
        string path = Path.Combine(folder, name), temp = path + ".tmp";
        File.WriteAllBytes(temp, bytes);
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    string ReadProtected(string name) { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(folder,name)), null, DataProtectionScope.CurrentUser)); }
    void LoadSaved() {
        try {
            var saved = D(json.DeserializeObject(ReadProtected("connection.bin")));
            if (S(saved,"origin") == Origin && Regex.IsMatch(S(saved,"token"),"^[a-f0-9]{64}$")) {
                token = S(saved,"token"); owner = S(saved,"owner"); deviceId=S(saved,"deviceId");
                Guid grant; if(Guid.TryParse(S(saved,"authorizationId"),out grant)) authorizationId=grant.ToString();
            }
        } catch { token = ""; }
        try { foreach(var pair in D(json.DeserializeObject(ReadProtected("commands.bin")))) journal[pair.Key] = Convert.ToString(pair.Value); } catch { }
    }
    void Record(string id, string outcome) {
        journal[id] = outcome;
        while(journal.Count > 256) journal.Remove(journal.Keys.First());
        SaveProtected("commands.bin", json.Serialize(journal));
    }
    async Task Safe(Func<Task> action) {
        try { await action(); } catch(Exception e) { status.Text = e.Message; }
    }
    async Task<Dictionary<string,object>> Request(string path, object payload, bool auth = true) {
        if (auth && token.Length == 0) throw new Exception("请先连接本机助手。");
        using(var req = new HttpRequestMessage(HttpMethod.Post, Base + path)) {
            if (auth) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Content = new StringContent(json.Serialize(payload ?? new {}), Encoding.UTF8, "application/json");
            using(var response = await http.SendAsync(req)) {
                var parsed = D(json.DeserializeObject(await response.Content.ReadAsStringAsync()));
                if (!response.IsSuccessStatusCode) {
                    var error = D(parsed.ContainsKey("error") ? parsed["error"] : null);
                    throw new ApiFailure((int)response.StatusCode, S(error,"message").Length>0 ? S(error,"message") : "连接失败，请检查网站和网络。");
                }
                return D(parsed.ContainsKey("data") ? parsed["data"] : null);
            }
        }
    }
    async Task Control(string action, string note) {
        if (taskId.Length == 0 || token.Length == 0) return;
        await Request("tasks/" + taskId + "/control", new { action, note });
    }
    void LocalPause() { armed = false; epoch++; }
    async Task StopTask() { LocalPause(); await Safe(async () => { await Control("stop", "你已停止操作"); status.Text = "已停止"; }); }
    void RefreshWindows() {
        windows.Items.Clear();
        foreach(var item in Native.Windows(Handle)) windows.Items.Add(item);
        if (windows.Items.Count>0) windows.SelectedIndex = 0;
    }
    async Task AllowTask() { await StartTask(false); }
    void CheckStart(string id,long version,string grant) {
        if(closing || version!=epoch || taskId!=id || authorizationId!=grant) throw new Exception("开始操作已取消，请核对任务后继续。");
    }
    async Task StartTask(bool automatic) {
        if (captureBlocked) throw new Exception("窗口截取未响应，请重启本机助手后重试。");
        if (working || (polling && !automatic) || changingAuthorization || allowing || task == null || !new[]{"WAITING","PAUSED","NEEDS_USER"}.Contains(state)) throw new Exception("请等待当前状态更新后再试。");
        allowing=true;
        LocalPause(); long version=epoch;
        string id=taskId, grant=authorizationId;
        Exception failure=null;
        bool serverAllowed=false;
        try {
        selected = automatic ? Native.InitialWindow(Native.Windows(Handle)) : windows.SelectedItem as WindowChoice;
        if (selected == null) throw new Exception("请先打开要操作的应用，再刷新并选择窗口。");
        Native.ValidateWindow(selected, false);
        Native.RefreshTitle(selected);
        if(automatic) { status.Text="已收到电脑任务，即将按设备授权开始；Ctrl+Alt+X 可停止。"; await Task.Delay(1500); }
        CheckStart(id,version,grant);
        var payload=new Dictionary<string,object>{{"action","allow"},{"window",selected.Title},{"application",selected.App},{"windowId",selected.Id}};
        if(grant.Length>0) payload["authorizationId"]=grant;
        var result=await Request("tasks/" + id + "/control",payload);
        serverAllowed=S(result,"status")=="RUNNING";
        CheckStart(id,version,grant);
        if(!serverAllowed) throw new Exception("任务已暂停或停止，请刷新后核对。");
        approvedId = id; activeAuthorizationId=grant;
        if(!Native.SetForegroundWindow(selected.Handle)) throw new Exception("无法激活操作窗口，请手动切换后继续。");
        await Task.Delay(700);
        CheckStart(id,version,grant);
        Native.ValidateWindow(selected, true);
        armed = true; epoch++; state="RUNNING"; allow.Enabled=false;
        status.Text = "已允许；请暂时不要移动鼠标或按键。";
        } catch(Exception ex) { LocalPause(); failure=ex; }
        finally { allowing=false; }
        if(failure!=null) {
            if(serverAllowed) await Request("tasks/"+id+"/control",new {action="handoff",note="本机操作未开始，请检查窗口后继续"});
            throw failure;
        }
    }
    async Task Poll() {
        if (polling || allowing || changingAuthorization || token.Length == 0 || closing) return;
        polling = true;
        string connectionToken=token; long permissionVersion=permissionEpoch;
        try {
            var result = await Request("poll", new {});
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            string remoteGrant=S(result,"authorizationId");
            if(authorizationId!=remoteGrant) {
                LocalPause(); authorizationId=""; SaveConnection(); ShowConnection();
                // A server grant alone never elevates the local client (including after rollback/re-pair).
                if(remoteGrant.Length>0) { await Request("authorization",new {enabled=false}); return; }
            }
            task = D(result.ContainsKey("task") ? result["task"] : null);
            if (task.Count == 0) { taskId = ""; state = ""; allow.Enabled = false; LocalPause(); if (!working) status.Text = "暂无进行中的电脑任务；结果可在网站查看。"; return; }
            string id = S(task,"id"); state = S(task,"status");
            if (taskId != id) { LocalPause(); approvedId = ""; autoAttemptedId=""; }
            taskId = id; instruction.Text = S(task,"instruction"); status.Text = S(task,"stage");
            allow.Enabled = !captureBlocked && !working && new[]{"WAITING","PAUSED","NEEDS_USER"}.Contains(state);
            if (state != "RUNNING") LocalPause();
            if (state=="PAUSED" || state=="NEEDS_USER") autoAttemptedId="";
            if (authorizationId.Length>0 && state=="WAITING" && autoAttemptedId!=id && !working && !captureBlocked) {
                autoAttemptedId=id;
                await StartTask(true);
                return;
            }
            if (state == "RUNNING" && !armed && !working) await Control("handoff", "本机输入已暂停，请核对任务和窗口后继续");
            if (state == "RUNNING" && armed && !working) { working = true; RunStep(taskId, epoch); }
        } catch(ApiFailure e) {
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            LocalPause(); status.Text = e.Message;
            if (e.Status == 401 || e.Status == 403) {
                token = ""; authorizationId="";
                try { SaveConnection(); } catch { status.Text+=" 本机连接记录未能清理，请检查磁盘。"; }
                ShowConnection();
            }
        }
        catch(Exception e) {
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            LocalPause(); status.Text = e is HttpRequestException || e is TaskCanceledException ? "网络连接中断，已停止本机输入。恢复后请核对任务并继续。" : e.Message;
        }
        finally { polling = false; if(!closing && Changed!=null) Changed(); }
    }
    void Check(string id, long version) {
        if (!armed || id != approvedId || id != taskId || version != epoch || closing) throw new Exception("操作已暂停");
        if(activeAuthorizationId.Length>0 && activeAuthorizationId!=authorizationId) throw new Exception("跨窗口授权已撤销");
        Native.ValidateWindow(selected, true);
    }
    async void RunStep(string id, long version) {
        string commandId = "";
        Exception failure = null;
        try {
            Check(id, version);
            Native.RefreshTitle(selected);
            var available = activeAuthorizationId.Length>0 ? Native.ObservationWindows(Handle,selected) : new List<WindowChoice>();
            // UI Automation and PrintWindow may wait on a hung application. Never capture another window as fallback.
            var capture = Task.Run(() => Native.Capture(selected));
            if (await Task.WhenAny(capture,Task.Delay(4000)) != capture) { captureBlocked=true; throw new Exception("应用窗口没有响应，请关闭本机助手后重试"); }
            Shot shot = await capture;
            Check(id, version);
            string requestId=Guid.NewGuid().ToString();
            var observation=new Dictionary<string,object>{{"requestId",requestId},{"image",shot.Image},{"width",shot.Width},{"height",shot.Height},{"window",selected.Title},{"application",selected.App},{"controls",shot.Controls},{"windowId",selected.Id}};
            if(activeAuthorizationId.Length>0) observation["windows"]=available.Select(w=>new {id=w.Id,title=w.Title,application=w.App}).ToArray();
            var plan = await Request("tasks/" + id + "/plan", observation);
            Check(id, version);
            var command = D(plan.ContainsKey("command") ? plan["command"] : null);
            if (command.Count == 0) { LocalPause(); return; }
            commandId = S(command,"id"); Guid parsed;
            if (!Guid.TryParse(commandId, out parsed)) throw new Exception("指令标识无效");
            string outcome;
            if (journal.TryGetValue(commandId, out outcome)) {
                // An uncertain input is handed back, never replayed, even after a restart or lost HTTP response.
                await Ack(id,commandId,outcome == "ok" ? "ok" : "uncertain", outcome == "ok" ? "该步骤已执行，已恢复反馈" : "上次执行结果不确定，请核对窗口后继续");
                if (outcome != "ok") LocalPause();
                return;
            }
            var action = D(command.ContainsKey("action") ? command["action"] : null);
            if(S(command,"requestId")!=requestId) throw new Exception("待执行步骤来自旧画面，请核对窗口后继续");
            Native.ValidateAction(action);
            WindowChoice target=null;
            if(S(action,"kind")=="switch_window") {
                if(activeAuthorizationId.Length==0) throw new Exception("尚未授权跨窗口操作");
                target=Native.ResolveTarget(available,S(action,"windowId"),selected);
                Native.ValidateWindow(target,false);
            }
            Check(id,version);
            var permit = await Request("tasks/" + id + "/permit",new {commandId});
            if (!permit.ContainsKey("allowed") || !Convert.ToBoolean(permit["allowed"])) throw new Exception("步骤已过期或已暂停，请核对后继续");
            Check(id, version);
            Record(commandId,"uncertain"); // Write-ahead record must succeed before any input.
            if(target!=null) {
                Check(id,version); Native.ValidateWindow(target,false);
                if(!Native.SetForegroundWindow(target.Handle)) throw new Exception("无法切换目标窗口，请手动切换后继续。");
                selected=target;
                await Task.Delay(500);
                Check(id,version);
            } else await Native.Execute(selected,shot,action,()=>Check(id,version));
            Record(commandId,"ok");
            await Ack(id,commandId,"ok",S(action,"description"));
            await Task.Delay(600);
        } catch(Exception e) {
            LocalPause(); status.Text = e.Message; failure=e;
        } finally { working = false; }
        if(failure!=null) {
            try { if(commandId.Length>0) await Ack(id,commandId,"uncertain","操作已中止，请核对窗口后继续"); else await Request("tasks/"+id+"/control",new {action="handoff",note=failure is ApiFailure ? "连接或智能服务异常，请检查网站任务状态" : failure.Message.Substring(0,Math.Min(300,failure.Message.Length))}); } catch { }
        }
    }
    async Task Ack(string id,string commandId,string outcome,string note) { await Request("tasks/"+id+"/ack",new {commandId,outcome,note}); }
    public static Dictionary<string,object> D(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    public static string S(Dictionary<string,object> value, string key) { object v; return value.TryGetValue(key,out v) ? Convert.ToString(v) : ""; }
}

static class Native {
    // Only dedicated, unprivileged browser windows can be selected from this process.
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<IntPtr,byte> BrowserWindows = new System.Collections.Concurrent.ConcurrentDictionary<IntPtr,byte>();
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int dx,dy; public uint mouseData,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public POINT point; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyHook { public uint vk,scan,flags,time; public UIntPtr extra; }
    delegate bool EnumProc(IntPtr h, IntPtr p);
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] inputs,int size);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h,int id);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,HookProc proc,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h,int code,IntPtr w,IntPtr l);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly HashSet<string> BlockedApps = new HashSet<string>(new[]{"cmd","powershell","pwsh","windowsterminal","conhost","openconsole","wsl","bash","mintty","regedit","mmc","taskmgr","credentialuibroker","consent","msiexec","mstsc","putty","keepass","keepassxc","1password","bitwarden","systemsettings","codex","codex-computer-use","chatgpt"},StringComparer.OrdinalIgnoreCase);
    static readonly Regex Sensitive = new Regex("密码|验证码|密钥|授权码|付款|支付|删除|发送|转账|下单|安装|登录|password|passcode|api.?key|secret|credential|sign.?in|log.?in|payment|purchase|delete|send|checkout|install",RegexOptions.IgnoreCase);
    static string Title(IntPtr h) { var b=new StringBuilder(1024); GetWindowText(h,b,b.Capacity); return b.ToString(); }
    static string Cut(string s,int n) { return s.Length>n?s.Substring(0,n):s; }
    public static IEnumerable<WindowChoice> Windows(IntPtr own) {
        var result=new List<WindowChoice>();
        EnumWindows((h,p)=>{
            try { if(h==own||!IsWindowVisible(h)||IsIconic(h))return true;
                string title=Title(h); if(String.IsNullOrWhiteSpace(title))return true;
                RECT rect; if(!GetWindowRect(h,out rect)||rect.Right-rect.Left<100||rect.Bottom-rect.Top<100)return true;
                uint pid; GetWindowThreadProcessId(h,out pid); var process=Process.GetProcessById((int)pid);
                if(BlockedApps.Contains(process.ProcessName)||(pid==Process.GetCurrentProcess().Id&&!BrowserWindows.ContainsKey(h)))return true;
                var choice=new WindowChoice{Handle=h,Title=Cut(title,200).Trim(),App=Cut(process.ProcessName,80).Trim(),Pid=(int)pid,Started=process.StartTime.ToUniversalTime().Ticks};
                ValidateWindow(choice,false); result.Add(choice);
            } catch { } return true;
        },IntPtr.Zero);
        return result;
    }
    public static void RefreshTitle(WindowChoice w) { w.Title=Cut(Title(w.Handle),200).Trim(); }
    public static WindowChoice InitialWindow(IEnumerable<WindowChoice> candidates) {
        var list=candidates.ToList();
        return list.FirstOrDefault(w=>w.Handle==GetForegroundWindow()) ?? list.FirstOrDefault();
    }
    public static List<WindowChoice> ObservationWindows(IntPtr own,WindowChoice current) {
        var list=new List<WindowChoice>{current};
        list.AddRange(Windows(own).Where(w=>w.Handle!=current.Handle).Take(39));
        return list;
    }
    public static WindowChoice ResolveTarget(IEnumerable<WindowChoice> observed,string id,WindowChoice current) {
        var matches=observed.Where(w=>w.Id==id && w.Id!=current.Id).ToList();
        if(matches.Count!=1) throw new Exception("切换目标不在本次可用窗口中，请核对后继续。");
        return matches[0];
    }
    public static void ValidateWindow(WindowChoice w,bool foreground) {
        if(w==null||!IsWindow(w.Handle)||!IsWindowVisible(w.Handle)||IsIconic(w.Handle))throw new Exception("窗口已关闭或最小化，请重新选择");
        uint pid; GetWindowThreadProcessId(w.Handle,out pid); var process=Process.GetProcessById((int)pid);
        if(pid!=w.Pid||process.StartTime.ToUniversalTime().Ticks!=w.Started||BlockedApps.Contains(process.ProcessName))throw new Exception("窗口应用已变化，请重新选择");
        if(pid==Process.GetCurrentProcess().Id&&!BrowserWindows.ContainsKey(w.Handle))throw new Exception("不能操作小序自身的控制界面");
        if(foreground&&GetForegroundWindow()!=w.Handle)throw new Exception("当前窗口已切换，请核对后继续");
        if(Regex.IsMatch(Title(w.Handle),"Windows PowerShell|命令提示符|终端|管理员:|API.?Keys|密码管理",RegexOptions.IgnoreCase))throw new Exception("此窗口需要你亲自操作");
    }
    static string Controls(WindowChoice w) {
        var root=AutomationElement.FromHandle(w.Handle); var walker=TreeWalker.ControlViewWalker;
        var queue=new Queue<AutomationElement>(); queue.Enqueue(root); var text=new StringBuilder(); int count=0;
        while(queue.Count>0&&count++<120) {
            var element=queue.Dequeue();
            if(element.Current.IsPassword)throw new Exception("窗口包含密码输入，请自行处理后再继续");
            string name=element.Current.Name;
            if(!element.Current.IsOffscreen) text.AppendLine(Cut(element.Current.ControlType.ProgrammaticName+": "+name,180));
            var child=walker.GetFirstChild(element); int sibling=0;
            while(child!=null&&sibling++<30&&queue.Count<140){queue.Enqueue(child);child=walker.GetNextSibling(child);}
        }
        return Cut(text.ToString(),12000);
    }
    public static Shot Capture(WindowChoice w) {
        ValidateWindow(w,true); string controls=Controls(w); RECT r;
        if(!GetWindowRect(w.Handle,out r)||r.Right-r.Left<100||r.Bottom-r.Top<100)throw new Exception("窗口太小，请调整后继续");
        if((long)(r.Right-r.Left)*(r.Bottom-r.Top)>24000000)throw new Exception("窗口尺寸过大，请缩小后继续");
        using(var original=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) {
            using(var g=Graphics.FromImage(original)){IntPtr dc=g.GetHdc();try{if(!PrintWindow(w.Handle,dc,2))throw new Exception("此应用不支持窗口截取，请使用其他窗口");}finally{g.ReleaseHdc(dc);}}
            double scale=Math.Min(1,1400.0/Math.Max(original.Width,original.Height));
            int width=(int)(original.Width*scale),height=(int)(original.Height*scale);
            if(width<100||height<100)throw new Exception("窗口比例过窄，请调整后继续");
            using(var resized=new Bitmap(original,new Size(width,height))) using(var stream=new MemoryStream()) {
                var codec=ImageCodecInfo.GetImageEncoders().First(i=>i.MimeType=="image/jpeg");
                using(var quality=new EncoderParameters(1)){quality.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,78L);resized.Save(stream,codec,quality);}
                if(stream.Length>2000000)throw new Exception("窗口画面过大，请缩小窗口后继续");
                return new Shot{Image=Convert.ToBase64String(stream.ToArray()),Width=width,Height=height,Controls=controls,Rect=r};
            }
        }
    }
    static string S(Dictionary<string,object> a,string k){return AssistantForm.S(a,k);}
    static int Number(Dictionary<string,object> a,string k,int min,int max) {object value;if(!a.TryGetValue(k,out value)||!(value is int)|| (int)value<min||(int)value>max)throw new Exception("操作坐标或数量无效");return (int)value;}
    static readonly Dictionary<string,ushort[]> Keys = new Dictionary<string,ushort[]> {
        {"ENTER",new ushort[]{13}}, {"TAB",new ushort[]{9}}, {"SHIFT_TAB",new ushort[]{16,9}}, {"ESC",new ushort[]{27}}, {"BACKSPACE",new ushort[]{8}}, {"LEFT",new ushort[]{37}}, {"RIGHT",new ushort[]{39}}, {"UP",new ushort[]{38}}, {"DOWN",new ushort[]{40}}, {"HOME",new ushort[]{36}}, {"END",new ushort[]{35}}, {"PAGEUP",new ushort[]{33}}, {"PAGEDOWN",new ushort[]{34}}, {"CTRL_A",new ushort[]{17,65}}, {"CTRL_S",new ushort[]{17,83}}, {"CTRL_Z",new ushort[]{17,90}}
    };
    public static void ValidateAction(Dictionary<string,object> a) {
        string kind=S(a,"kind");
        if(kind=="click"||kind=="scroll"){Number(a,"x",0,1000);Number(a,"y",0,1000);}
        if(kind=="click"&&!new[]{"left","right","double"}.Contains(S(a,"button")))throw new Exception("点击类型无效");
        if(kind=="scroll"){Number(a,"amount",1,6);if(!new[]{"up","down"}.Contains(S(a,"direction")))throw new Exception("滚动方向无效");}
        if(kind=="key"&&!Keys.ContainsKey(S(a,"key")))throw new Exception("此快捷键需要你亲自操作");
        Guid target;
        if(kind=="switch_window"&&!Guid.TryParse(S(a,"windowId"),out target))throw new Exception("窗口标识无效");
        if(kind=="type") {
            string value=S(a,"text");
            if(value.Length<1||value.Length>3000||Regex.IsMatch(value,"javascript:|data:text/html|(?im)^\\s*(powershell|pwsh|cmd(?:\\.exe)?|bash|wscript|cscript|mshta|curl|wget)(?:\\s|$)"))throw new Exception("此输入需要你亲自操作");
            if(value.Any(c=>Char.IsControl(c)&&c!='\n'&&c!='\r'&&c!='\t'))throw new Exception("输入包含不支持的控制字符");
        }
        if(!new[]{"click","scroll","key","type","wait","switch_window"}.Contains(kind))throw new Exception("不支持的电脑操作");
    }
    static void GuardElement(AutomationElement element) {
        for(int i=0;element!=null&&i<5;i++,element=TreeWalker.ControlViewWalker.GetParent(element)) {
            if(element.Current.IsPassword)throw new Exception("密码输入需要你亲自处理");
            var type=element.Current.ControlType;
            if((type==ControlType.Button||type==ControlType.MenuItem||type==ControlType.Hyperlink||type==ControlType.Edit)&&Sensitive.IsMatch(element.Current.Name))throw new Exception("此步骤需要你亲自处理");
        }
    }
    static void Send(params INPUT[] input) { if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length)throw new Exception("应用拒绝输入，请检查窗口权限并自行操作；不要提升助手权限"); }
    static INPUT K(ushort key,uint flags) { return new INPUT{type=1,data=new UNION{key=new KEY{vk=key,flags=flags}}}; }
    static INPUT Mouse(uint flags,uint data=0) { return new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=flags,mouseData=data}}}; }
    public static async Task Execute(WindowChoice w,Shot shot,Dictionary<string,object> a,Action check) {
        ValidateAction(a); check(); RECT r;GetWindowRect(w.Handle,out r);
        if(r.Left!=shot.Rect.Left||r.Top!=shot.Rect.Top||r.Right!=shot.Rect.Right||r.Bottom!=shot.Rect.Bottom)throw new Exception("窗口位置或大小已变化，请核对后继续");
        string kind=S(a,"kind");
        if(kind=="switch_window") throw new Exception("切换窗口必须经过本机设备授权和目标校验");
        if(kind=="wait"){await Task.Delay(800);return;}
        if(kind=="click"||kind=="scroll") {
            int x=r.Left+(int)Math.Round(Number(a,"x",0,1000)*(r.Right-r.Left-1)/1000.0);
            int y=r.Top+(int)Math.Round(Number(a,"y",0,1000)*(r.Bottom-r.Top-1)/1000.0);
            if(GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=w.Handle)throw new Exception("目标位置被其他窗口遮挡，请核对后继续");
            GuardElement(AutomationElement.FromPoint(new System.Windows.Point(x,y))); check();
            // SetCursorPos is not used: SendInput marks pointer movement as injected for the manual-input pause hook.
            var screen=SystemInformation.VirtualScreen;
            Send(new INPUT{type=0,data=new UNION{mouse=new MOUSE{dx=(int)((x-screen.Left)*65535.0/(screen.Width-1)),dy=(int)((y-screen.Top)*65535.0/(screen.Height-1)),flags=0xC001}}});
            check();
            if(kind=="scroll")Send(Mouse(0x0800,unchecked((uint)((S(a,"direction")=="up"?120:-120)*Number(a,"amount",1,6)))));
            else { bool right=S(a,"button")=="right";Send(Mouse(right?0x0008u:0x0002u),Mouse(right?0x0010u:0x0004u));if(S(a,"button")=="double"){await Task.Delay(80);check();Send(Mouse(2),Mouse(4));} }
            return;
        }
        GuardElement(AutomationElement.FocusedElement); check();
        if(kind=="key") {
            ushort[] keys=Keys[S(a,"key")];var inputs=new List<INPUT>();foreach(var key in keys)inputs.Add(K(key,0));foreach(var key in keys.Reverse())inputs.Add(K(key,2));Send(inputs.ToArray());
        } else {
            // Unicode SendInput doesn't interpret text as key shortcuts or executable code.
            foreach(char ch in S(a,"text")) {
                check();GuardElement(AutomationElement.FocusedElement);
                Send(new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=4}}},new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=6}}});
                await Task.Delay(2);
            }
        }
    }
    public sealed class Hook : IDisposable {
        readonly HookProc mouseProc,keyProc;readonly IntPtr mouse,key;
        public Hook(Action pause) {
            mouseProc=(n,w,l)=>{if(n>=0&&(((MouseHook)Marshal.PtrToStructure(l,typeof(MouseHook))).flags&1)==0)pause();return CallNextHookEx(IntPtr.Zero,n,w,l);};
            keyProc=(n,w,l)=>{if(n>=0&&(((KeyHook)Marshal.PtrToStructure(l,typeof(KeyHook))).flags&16)==0)pause();return CallNextHookEx(IntPtr.Zero,n,w,l);};
            mouse=SetWindowsHookEx(14,mouseProc,GetModuleHandle(null),0);key=SetWindowsHookEx(13,keyProc,GetModuleHandle(null),0);
            if(mouse==IntPtr.Zero||key==IntPtr.Zero){Dispose();throw new Exception("无法启用手动操作暂停保护，请重启本机助手。");}
        }
        public void Dispose(){if(mouse!=IntPtr.Zero)UnhookWindowsHookEx(mouse);if(key!=IntPtr.Zero)UnhookWindowsHookEx(key);}
    }
    public static int SelfTest() {
        try {
            var j=new JavaScriptSerializer();Action<string> valid=s=>ValidateAction(AssistantForm.D(j.DeserializeObject(s)));
            valid("{\"kind\":\"type\",\"text\":\"整理成三项：你好\"}");
            valid("{\"kind\":\"click\",\"x\":500,\"y\":1000,\"button\":\"left\"}");
            valid("{\"kind\":\"key\",\"key\":\"CTRL_S\"}");
            var current=new WindowChoice(); var other=new WindowChoice();
            valid("{\"kind\":\"switch_window\",\"windowId\":\""+other.Id+"\"}");
            if(ResolveTarget(new[]{current,other},other.Id,current)!=other) throw new Exception("Window target mismatch");
            foreach(string id in new[]{current.Id,Guid.NewGuid().ToString()}) {
                bool rejected=false; try{ResolveTarget(new[]{current,other},id,current);}catch{rejected=true;}
                if(!rejected) throw new Exception("Unknown/current window accepted");
            }
            foreach(string input in new[]{"{\"kind\":\"switch_window\",\"windowId\":\"123\"}","{\"kind\":\"shell\"}","{\"kind\":\"key\",\"key\":\"WIN_R\"}","{\"kind\":\"type\",\"text\":\"powershell -enc ab\"}","{\"kind\":\"click\",\"x\":-1,\"y\":0,\"button\":\"left\"}"}) {
                bool rejected=false;try{valid(input);}catch{rejected=true;}if(!rejected)throw new Exception("Unexpected accepted action");
            }
            if(Marshal.SizeOf(typeof(INPUT))!=(IntPtr.Size==8?40:28))throw new Exception("Native input layout invalid");
            Console.WriteLine("Native action validation: passed (no desktop input performed)");return 0;
        } catch(Exception e){Console.WriteLine(e.Message);return 1;}
    }
}
}
