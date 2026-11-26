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
        if(args.Length==1 && args[0]=="--self-test-director")return DirectorTest.Run();
        if(args.Length==1 && args[0]=="--self-test-director-autosubs")return DirectorTest.AutoSubs();
        if(args.Length>0 && args[0].StartsWith("--self-test-director-child-",StringComparison.Ordinal))return DirectorTest.Child(args);
        if(args.Length==1 && args[0]=="--run-file-plan")return FilePlanRunner.ChildMain(false);
        if(args.Length==1 && args[0]=="--self-test-file-plan")return FilePlanRunner.ChildMain(true);
        if (args.Length == 1 && args[0] == "--self-test") return Native.SelfTest() + ShellPolicy.SelfTest() + AssistantForm.ConnectionSelfTest();
        if (args.Length == 1 && args[0] == "--runtime-check") return DesktopShell.CheckRuntime();
        if (args.Length == 2 && args[0] == "--ui-preview") { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); return AssistantForm.Preview(args[1]); }
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
    public readonly string Code, RequestId, Diagnostic;
    public ApiFailure(int status, string text) : this(status,text,"CONNECTION_CHECK","") { }
    ApiFailure(int status,string text,string code,string requestId) : base(text+Details(status,code,requestId)) {
        Status=status;Code=code;RequestId=requestId;Diagnostic=Details(status,code,requestId);
    }
    static string Details(int status,string code,string requestId) {
        return "（诊断："+code+" / HTTP "+status+(requestId.Length>0?" / 请求 "+requestId:"")+"）";
    }
    static readonly Dictionary<string,string> Messages=new Dictionary<string,string> {
        {"UNAUTHENTICATED","本机连接已失效，请点击「操作本机」重新连接。"},
        {"DEVICE_REVOKED","电脑连接已断开或过期，请点击「操作本机」重新连接。"},
        {"PAIR_EXPIRED","配对码已失效，请在网站重新生成。"},
        {"DEVICE_LIMIT","最多连接5台电脑，请先断开不用的设备。"},
        {"DEVICE_OFFLINE","电脑暂时离线，请检查本机助手连接。"},
        {"DESKTOP_BUSY","这台电脑已有任务，请完成或停止后再发送。"},
        {"REQUEST_CONFLICT","任务标识已被使用，请刷新网站任务状态。"},
        {"VALIDATION_ERROR","电脑画面或操作参数校验失败，请更新桌面端后核对任务。"},
        {"WINDOW_CHANGED","操作窗口已变化，请在本机核对窗口后继续。"},
        {"AUTHORIZATION_CHANGED","跨窗口授权已变化，请在本机核对后继续。"},
        {"DESKTOP_PLANNING","当前窗口仍在分析，请稍后核对任务状态。"},
        {"AI_NOT_READY","智能服务尚未启用或验证，请管理员检查服务配置。"},
        {"VISION_REQUIRED","所选模型不支持识图，请在网站选择支持图片输入的模型。"},
        {"INVALID_IMAGE","窗口画面格式校验失败，请重新核对窗口后继续。"},
        {"DESKTOP_AI_ERROR","智能服务未返回有效操作，请核对服务状态后继续。"},
        {"DESKTOP_PROVIDER_BUDGET","智能服务已达到预算限制，请管理员检查额度后继续。"},
        {"DESKTOP_PROVIDER_CREDITS","智能服务余额不足，请管理员检查余额后继续。"},
        {"DESKTOP_PROVIDER_AUTH","智能服务凭据未通过验证，请管理员检查配置。"},
        {"DESKTOP_PROVIDER_PERMISSION","智能服务未允许调用所选模型，请管理员检查模型权限。"},
        {"DESKTOP_PROVIDER_POLICY","智能服务的调用规则阻止了本次请求，请核对任务与服务配置。"},
        {"DESKTOP_PROVIDER_PRIVACY","当前模型没有符合数据隐私要求的可用服务，请管理员核对模型与服务配置。"},
        {"DESKTOP_PROVIDER_REGION","智能服务当前区域不支持本次调用，请管理员检查配置。"},
        {"DESKTOP_PROVIDER_UNAVAILABLE","智能服务暂不可用，请稍后核对任务并继续。"},
        {"DESKTOP_PROVIDER_RATE_LIMIT","智能服务请求过于频繁，请稍后核对任务并继续。"},
        {"DESKTOP_PROVIDER_HTTP","智能服务未接受本次请求，请凭诊断编号检查服务状态。"},
        {"MODEL_UNAVAILABLE","所选模型当前不可用，请在网站刷新模型列表并重新选择。"},
        {"AI_MODEL_CAPABILITY","所选模型不支持电脑操作，请在网站重新选择已接通的识图模型。"},
        {"NOT_FOUND","电脑任务或连接不存在，请刷新网站任务状态。"},
        {"FORBIDDEN","当前操作未获允许，请核对账号权限和本机授权。"},
        {"INTERNAL_ERROR","网站处理未完成，请凭诊断编号检查服务状态。"},
        {"INVALID_RESPONSE","网站返回格式异常，请检查网站服务后重试。"}
    };
    public static ApiFailure FromResponse(int status,string code,string requestId,string message) {
        string text;
        if(!Messages.TryGetValue(code,out text)) {code="API_ERROR";text=status==429?"请求过于频繁，请稍后再试。":status>=500?"网站服务暂不可用，请稍后核对任务状态。":"电脑请求未完成，请核对网站任务状态。";}
        // Only a known application template may contribute a numeric provider status.
        // Arbitrary upstream messages, codes and response bodies are never displayed.
        if(code=="DESKTOP_AI_ERROR") {
            var match=Regex.Match(message??"","^智能服务暂不可用（HTTP ([1-5][0-9]{2})），任务已暂停$");
            if(match.Success)text="智能服务暂不可用（供应商 HTTP "+match.Groups[1].Value+"），请核对所选模型与服务状态。";
            else if(message=="操作指令格式无效")text="智能服务返回的操作指令格式无效，请核对模型后继续。";
            else if(message=="智能服务返回异常，任务已暂停")text="智能服务返回异常，任务已暂停，请核对模型后继续。";
        }
        Guid parsed;
        requestId=Guid.TryParseExact(requestId,"D",out parsed)?parsed.ToString():"";
        return new ApiFailure(status,text,code,requestId);
    }
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
    public string ExplorerFolder;
    public string FileShortcut;
    public Native.PopupMenu Popup;
    public string Image, Controls;
    public int Width, Height;
    public Native.RECT Rect;
    public Rectangle InputBounds;
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
    readonly Button allow = new Button { Text = "继续当前任务", AutoSize = true, Enabled = false, Visible = false };
    readonly Button manualAllow = new Button { Text = "允许本次任务", AutoSize = true, Enabled = false };
    readonly Button pause = new Button { Text = "暂停", AutoSize = true };
    readonly Button stop = new Button { Text = "停止", AutoSize = true };
    readonly Button authorization = new Button { Text = "授权跨窗口操作", AutoSize = true };
    readonly Label permission = new Label { AutoSize = true, MaximumSize = new Size(570, 0) };
    FlowLayoutPanel advancedPanel;
    readonly Timer timer = new Timer { Interval = 2000 };
    string token = "", owner = "", deviceId = "", taskId = "", approvedId = "", state = "";
    string authorizationId = "", activeAuthorizationId = "", autoAttemptedId = "";
    Native.WindowContinuation continuation;
    bool BoundTask { get { return task!=null && S(task,"previousTaskId").Length>0; } }
    void ForgetWindow() {
        if(continuation!=null)continuation.Dispose();
        continuation=null;
    }
    void RememberWindow(string id,WindowChoice window) {
        ForgetWindow();
        if(authorizationId.Length==0 || isolatedPreview)return;
        continuation=Native.WindowContinuation.Capture(id,authorizationId,window,BrowserOnly);
    }
    WindowChoice BoundWindow() {
        if(continuation==null || !continuation.Matches(S(task,"previousTaskId"),S(task,"boundWindowId"),authorizationId,BrowserOnly))
            throw new Exception("原窗口记录已失效，请重新指定要操作的窗口或网页。");
        continuation.Validate();
        return continuation.Window;
    }
    bool changingAuthorization;
    long permissionEpoch;
    public event Action Changed;
    public event Action SetupRequested;
    public event Action WorkspaceRequested;
    public bool Connected { get { return token.Length > 0; } }
    public bool Authorized { get { return Connected && authorizationId.Length > 0; } }
    public bool EngineReady { get { return !closing && inputHook!=null && stopKey!=null && timer.Enabled; } }
    public string EngineError { get; private set; }
    public string StopShortcut { get { return stopKey==null ? "" : stopKey.Shortcut; } }
    public bool CanShowReleaseNotice { get {
        if(working || allowing || pairing || changingAuthorization)return false;
        if(!Connected)return true;
        // A restored connection learns whether work is waiting from its first poll.
        return task!=null && (taskId.Length==0 || state=="DONE" || state=="FAILED" || state=="CANCELED");
    } }
    public string DeviceId { get { return deviceId; } }
    bool started, pairing, isolatedPreview;
    WindowChoice selected;
    bool polling, working, armed, closing, captureBlocked, allowing;
    bool manualPauseSent, manualPausePending;
    bool observingForeground;
    DateTime foregroundInputAt;
    sealed class ForegroundInUse : Exception {}
    const string WaitingForForeground = "你可以继续使用电脑。原任务窗口回到前台并空闲后，小序会重新观察并继续。";
    long manualPauseVersion=-1;
    string manualPauseNote="", startFailureNote="", executingKind="";
    string nativeAttemptId="";
    string backgroundAttemptId="", previousVerificationId="";
    string desktopExplorerTaskId="";
    string wecomTaskId="";
    bool locatingWeCom;
    DateTime lastPhysicalInput;
    Native.ExplorerCopy fileCopy;
    string failureTaskId="", failureDiagnostic="";
    Action<Action> manualPauseDispatch;
    Func<WindowChoice> startWindowOverride;
    Func<string,Action,Task<WindowChoice>> notepadOverride;
    Func<Action,Action,Task<WindowChoice>> wecomOverride;
    Func<Dictionary<string,object>,Func<Task>,string,Task<int>> executeFolderBatch=Native.CreateDesktopFolders;
    Func<Dictionary<string,object>,string[],Func<Task>,System.Threading.CancellationToken,Native.FolderAttachment[],Task<int>> executeFileScript=(plan,steps,check,stop,sources)=>FilePlanRunner.Run(plan,steps,check,stop,null,sources);
    System.Threading.CancellationTokenSource folderPlanStop;
    long epoch;
    Dictionary<string, object> task;
    bool BrowserOnly { get { return task!=null&&task.ContainsKey("localBrowser")&&Object.Equals(task["localBrowser"],true); } }
    bool IsBackgroundCopy {get {return task!=null && S(task,"fileCopyMode")=="background";}}
    const string folderReceipt="file-copy-folder.bin";
    string ReadFolderReceipt() {return File.Exists(Path.Combine(folder,folderReceipt))?ReadProtected(folderReceipt):"";}
    string NativeAction { get { return task==null?"":S(task,"nativeAction"); } }
    bool IsFolderBatch {get {return Native.IsFolderBatchAction(NativeAction);}}
    readonly Dictionary<string, string> journal = new Dictionary<string, string>();
    Native.Hook inputHook;
    Native.StopKey stopKey;
    DateTime retryProtectionAt;

    public AssistantForm() {
        Text = "电脑任务"; Width = 650; Height = 590; MinimumSize = new Size(620, 510);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(246, 247, 252);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(20) };
        Controls.Add(layout);
        var title = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 12) };
        title.Controls.Add(new Label { Text = "本机操作", AutoSize = true, Font = new Font(Font.FontFamily, 17, FontStyle.Bold), Margin = new Padding(0, 0, 12, 0) });
        var back = new Button { Text = "返回工作台", AutoSize = true };
        back.Click += (s,e) => { if(WorkspaceRequested!=null) WorkspaceRequested(); };
        title.Controls.Add(back);
        layout.Controls.Add(title);
        layout.Controls.Add(new Label { Text = "点击「操作本机」，首次允许并记住后，就可以在工作台直接说或输入任务。", AutoSize = true, MaximumSize = new Size(570, 0) });
        layout.Controls.Add(connection);
        layout.Controls.Add(permission);
        var setup = new Button { Text = "操作本机", AutoSize = true, Padding = new Padding(10, 5, 10, 5), Margin = new Padding(0, 10, 0, 10) };
        setup.Click += (s,e) => { if(SetupRequested!=null) SetupRequested(); };
        layout.Controls.Add(setup);
        layout.Controls.Add(new Label { Text = "当前任务", AutoSize = true, Margin = new Padding(0, 18, 0, 5) });
        layout.Controls.Add(instruction); layout.Controls.Add(status);
        var controls = new FlowLayoutPanel { AutoSize = true };
        controls.Controls.Add(allow); controls.Controls.Add(pause); controls.Controls.Add(stop); layout.Controls.Add(controls);
        layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(570, 0), Margin = new Padding(0, 10, 0, 8), Text = "点击鼠标、滚轮或按键会暂停；仅移动鼠标不会中断。登录、付款、发送和删除仍由你接手。" });
        var advancedToggle = new Button { Text = "高级设置 ▸", AutoSize = true, Margin = new Padding(0, 12, 0, 5) };
        var advanced = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Visible = false, MaximumSize = new Size(580, 0) };
        advancedPanel=advanced;
        advancedToggle.Click += (s,e) => { advanced.Visible = !advanced.Visible; advancedToggle.Text = advanced.Visible ? "收起高级设置 ▾" : "高级设置 ▸"; };
        layout.Controls.Add(advancedToggle); layout.Controls.Add(advanced);
        advanced.Controls.Add(new Label { Text = "连接其他浏览器：粘贴该账号生成的配对码", AutoSize = true, MaximumSize = new Size(570, 0) });
        var pairing = new FlowLayoutPanel { AutoSize = true };
        var pair = new Button { Text = "连接", AutoSize = true };
        var disconnect = new Button { Text = "断开本机", AutoSize = true };
        pairing.Controls.Add(code); pairing.Controls.Add(pair); pairing.Controls.Add(disconnect); advanced.Controls.Add(pairing);
        advanced.Controls.Add(authorization);
        advanced.Controls.Add(new Label { Text = "手动选择起始窗口（已记住允许时可自动选择）", AutoSize = true, Margin = new Padding(0, 18, 0, 5) });
        advanced.Controls.Add(windows);
        var buttons = new FlowLayoutPanel { AutoSize = true };
        var refresh = new Button { Text = "刷新窗口", AutoSize = true };
        buttons.Controls.Add(refresh); buttons.Controls.Add(manualAllow); advanced.Controls.Add(buttons);
        advanced.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(570, 0), Margin = new Padding(0, 14, 0, 0), Text = "手动允许时只操作选定窗口。记住允许后，新任务可自动选择已打开的普通应用和网页。允许在重启后保留，可随时撤销。\n\n操作画面、控件文字及窗口标题会交给智能服务处理，截图不保存。不要以管理员身份运行助手。" });
        pair.Click += async (s, e) => await Safe(async () => {
            pair.Enabled = false;
            try {
                await PairCode(code.Text.Trim());
            } finally { pair.Enabled = true; }
        });
        disconnect.Click += async (s,e) => await Safe(Disconnect);
        refresh.Click += (s,e) => { if (!armed) RefreshWindows(); };
        manualAllow.Click += async (s,e) => await Safe(AllowTask);
        allow.Click += async (s,e) => await Safe(async () => { if(!Authorized) throw new Exception("本机允许已撤销，请重新确认。"); await StartTask(true); });
        authorization.Click += async (s,e) => await Safe(ChangeAuthorization);
        pause.Click += async (s,e) => await Safe(async () => { LocalPause(); await Control("pause", "你已暂停操作"); });
        stop.Click += async (s,e) => await StopTask();
        timer.Tick += async (s,e) => {
            if(!EngineReady && DateTime.UtcNow>=retryProtectionAt) StartProtection();
            if(EngineReady) await Poll();
        };
        Shown += (s,e) => { if(!isolatedPreview) StartEngine(); };
        FormClosing += (s,e) => Shutdown();
    }
    public void StartEngine() {
        if(started || closing) return;
        started=true;
        LoadSaved(); RefreshWindows();
        timer.Start();
        StartProtection();
    }
    void StartProtection() {
        if(closing || EngineReady) return;
        try {
            stopKey=new Native.StopKey(()=>{LocalPause();BeginInvoke(new Action(async()=>await StopTask()));});
            inputHook=new Native.Hook(ManualInput);
            EngineError="";
            stop.Text="停止 ("+StopShortcut+")";
            status.Text=Connected?"正在接收电脑任务。":"连接后等待网站发送任务。";
        } catch(Exception ex) {
            ReleaseProtection();
            EngineError=ex.Message;
            retryProtectionAt=DateTime.UtcNow.AddSeconds(10);
            stop.Text="停止";
            status.Text=EngineError;
        }
        ShowConnection();
    }
    void ReleaseProtection() {
        if(inputHook!=null) { inputHook.Dispose(); inputHook=null; }
        if(stopKey!=null) { stopKey.Dispose(); stopKey=null; }
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
        ForgetWindow();
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
        ForgetWindow();
        ReleaseProtection();
    }
    protected override void Dispose(bool disposing) {
        if(disposing) { Shutdown(); timer.Dispose(); http.Dispose(); }
        base.Dispose(disposing);
    }
    void ShowConnection() {
        connection.Text = token.Length > 0 ? "已连接 · " + owner : "未连接本机";
        bool granted = authorizationId.Length > 0;
        permission.Text = granted ? (EngineReady ? "已记住本机授权，可在工作台直接发送电脑指令。" : "已记住本机授权，等待执行器就绪。") : "尚未允许自动操作；点击「操作本机」完成首次确认。";
        authorization.Text = granted ? "撤销本机操作授权" : "允许并记住本机操作";
        authorization.Enabled = Connected && !changingAuthorization;
        ShowTaskControls();
        if(Changed!=null) Changed();
    }
    void ShowTaskControls() {
        bool ready = EngineReady && task!=null && (!captureBlocked || NativeAction.Length>0) && !working && !allowing && !changingAuthorization && new[]{"WAITING","PAUSED","NEEDS_USER"}.Contains(state);
        allow.Visible = Authorized && new[]{"PAUSED","NEEDS_USER"}.Contains(state);
        allow.Enabled = ready; manualAllow.Enabled = ready;
        manualAllow.Text = Authorized ? "从此窗口继续" : "允许本次任务";
    }
    void SaveConnection() {
        SaveProtected("connection.bin",json.Serialize(new { token, owner, deviceId, origin=Origin, authorizationId }));
    }
    void ClearExpiredConnection() {
        ForgetWindow();
        LocalPause(); permissionEpoch++;
        token=""; owner=""; deviceId=""; authorizationId=""; activeAuthorizationId="";
        taskId=""; approvedId=""; state=""; task=null; autoAttemptedId=""; instruction.Text="";
        try { SaveConnection(); } catch { status.Text+=" 本机连接记录未能清理，请检查磁盘。"; }
        ShowConnection();
    }
    async Task<bool> ReconcileAuthorization(Dictionary<string,object> result) {
        if(changingAuthorization) return false;
        string remoteGrant=S(result,"authorizationId");
        if(authorizationId==remoteGrant) return true;
        changingAuthorization=true;
        try {
            ForgetWindow();LocalPause(); authorizationId=""; SaveConnection(); ShowConnection();
            // Keep an old revoke serialized with consent so it cannot clear a new grant.
            // A server grant alone never elevates this local Windows user.
            if(remoteGrant.Length>0) { await Request("authorization",new {enabled=false}); return false; }
            return true;
        } finally { changingAuthorization=false; ShowConnection(); }
    }
    public async Task RefreshStatus() {
        if(token.Length==0 || closing || pairing || changingAuthorization) return;
        string connectionToken=token; long permissionVersion=permissionEpoch;
        try {
            var result=await Request("poll",new {statusOnly=true});
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            await ReconcileAuthorization(result);
        } catch(ApiFailure e) {
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            if(e.Status!=401 && e.Status!=403) throw;
            status.Text="本机连接已失效，请点击「操作本机」重新连接。";
            ClearExpiredConnection();
        } catch(HttpRequestException) {
            throw new ApiFailure(503,"暂时无法验证本机连接，原有连接已保留，请检查网络后重试。");
        } catch(TaskCanceledException) {
            throw new ApiFailure(503,"验证本机连接超时，原有连接已保留，请稍后重试。");
        }
    }
    public async Task RequestAuthorization(string expectedDeviceId) {
        if(!Connected || deviceId!=expectedDeviceId) throw new Exception("本机连接已变化，请重新选择电脑。");
        if(changingAuthorization) throw new Exception("本机允许状态正在更新，请稍后再试。");
        // Repeated setup is idempotent; a web request can only open native consent, never revoke or silently grant.
        if(!Authorized) await ChangeAuthorization();
    }
    async Task ChangeAuthorization() {
        if (!Connected || changingAuthorization) return;
        bool enable = authorizationId.Length == 0;
        changingAuthorization=true; ShowConnection();
        string connectionToken=token;
        try {
            if (enable && !ConfirmAuthorization()) return;
            if(token!=connectionToken || !Connected || closing) return;
            ForgetWindow();permissionEpoch++; LocalPause();
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
    static Form AuthorizationDialog(string shortcut) {
        var dialog=new Form { Text="允许小序操作本机", Width=540, Height=290, StartPosition=FormStartPosition.CenterParent, FormBorderStyle=FormBorderStyle.FixedDialog, MaximizeBox=false, MinimizeBox=false, ShowInTaskbar=false, Font=new Font("Microsoft YaHei UI",10), AutoScaleMode=AutoScaleMode.Dpi };
            var text=new Label { Dock=DockStyle.Fill, Padding=new Padding(24,20,24,12), Text="按你的指令操作已打开的网页与应用，也可打开系统记事本。确认一次后记住本机。\n\n识屏操作会将画面、控件文字及窗口标题交给智能服务。登录、付款、发送和删除由你接手。\n\n随时可撤销；"+(String.IsNullOrEmpty(shortcut)?"可在电脑任务中点击停止。":shortcut+" 停止。") };
            var buttons=new FlowLayoutPanel { Dock=DockStyle.Bottom, Height=62, Padding=new Padding(18,10,18,10), FlowDirection=FlowDirection.RightToLeft };
            var accept=new Button { Text="允许并记住", Width=145, Height=36, DialogResult=DialogResult.Yes };
            var cancel=new Button { Text="取消", Width=100, Height=36, DialogResult=DialogResult.Cancel };
            buttons.Controls.Add(accept);buttons.Controls.Add(cancel);dialog.Controls.Add(text);dialog.Controls.Add(buttons);
            dialog.CancelButton=cancel;dialog.AcceptButton=cancel;dialog.ActiveControl=cancel;
        return dialog;
    }
    bool ConfirmAuthorization() {
        using(var dialog=AuthorizationDialog(StopShortcut)) return dialog.ShowDialog(TopLevelControl ?? this)==DialogResult.Yes;
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
                string body=await response.Content.ReadAsStringAsync();
                IEnumerable<string> ids;string requestId=response.Headers.TryGetValues("X-Request-Id",out ids)?ids.FirstOrDefault()??"":"";
                Dictionary<string,object> parsed;
                try { parsed=D(json.DeserializeObject(body)); }
                catch { throw ApiFailure.FromResponse((int)response.StatusCode,"INVALID_RESPONSE",requestId,""); }
                if(requestId.Length==0)requestId=S(parsed,"requestId");
                if (!response.IsSuccessStatusCode) {
                    var error = D(parsed.ContainsKey("error") ? parsed["error"] : null);
                    throw ApiFailure.FromResponse((int)response.StatusCode,S(error,"code"),requestId,S(error,"message"));
                }
                return D(parsed.ContainsKey("data") ? parsed["data"] : null);
            }
        }
    }
    string TaskStage(Dictionary<string,object> value) {
        string text=S(value,"stage");
        string state=S(value,"status");
        string prefix=state=="PAUSED"?"任务已暂停：":state=="NEEDS_USER"?"需要你接手：":"";
        if(prefix.Length>0 && taskId==failureTaskId && failureDiagnostic.Length>0 && !text.Contains(failureDiagnostic))text+=failureDiagnostic;
        return text.StartsWith(prefix,StringComparison.Ordinal)?text:prefix+text;
    }
    static string FailureText(Exception error) {
        if(error is HttpRequestException)return "网络连接中断，已停止本机输入；恢复后请核对任务并继续。";
        if(error is TaskCanceledException)return "网站请求超时，已停止本机输入；请核对任务状态后继续。";
        return error.Message.Substring(0,Math.Min(300,error.Message.Length));
    }
    async Task ReportStepFailure(string id,string connectionToken,long version,string commandId,Exception error) {
        if(!CurrentOperation(id,connectionToken,version))return;
        var api=error as ApiFailure;failureTaskId=id;failureDiagnostic=api==null?"":api.Diagnostic;
        string note=FailureText(error);status.Text=note;
        bool blocked=commandId.Length>0 && error is Native.InputNotSent;
        if(blocked) {
            try { Record(commandId,"blocked"); } catch { /* The previous uncertain record still prevents replay. */ }
        }
        if(commandId.Length>0)note=(blocked?"本步未发送输入。":"操作已中止，请核对窗口。")+note;
        note=note.Substring(0,Math.Min(300,note.Length));
        // The conditional handoff preserves a server/user pause or stop that won the race.
        var result=commandId.Length>0
            ? await Request("tasks/"+id+"/ack",new {commandId,outcome=blocked?"blocked":"uncertain",note})
            : await Request("tasks/"+id+"/control",new {action="handoff",startupFailure=true,note});
        if(!CurrentOperation(id,connectionToken,version))return;
        state=S(result,"status");task=result;status.Text=TaskStage(result);ShowTaskControls();
        if(Changed!=null)Changed();
    }
    async Task Control(string action, string note) {
        if (taskId.Length == 0 || token.Length == 0) return;
        await Request("tasks/" + taskId + "/control", new { action, note });
    }
    void LocalPause() { armed = false; fileCopy=null; foregroundInputAt=DateTime.MinValue; observingForeground=false; epoch++; if(folderPlanStop!=null)folderPlanStop.Cancel(); }
    bool CurrentOperation(string id,string connectionToken,long version) {
        return !closing && id.Length>0 && id==taskId && token==connectionToken && version==epoch;
    }
    void ManualInput(string reason) {
        lastPhysicalInput=DateTime.UtcNow;
        if(locatingWeCom) return; // No desktop input is sent while locating. Check idle and the current claim before focusing.
        if(backgroundAttemptId.Length>0 || (fileCopy!=null && fileCopy.PasteIssued && working))return;
        if((!armed && !allowing) || closing || manualPauseSent) return;
        if(CanYieldForeground && (!working || observingForeground)) {
            foregroundInputAt=DateTime.UtcNow;
            status.Text=WaitingForForeground;
            return;
        }
        manualPauseSent=true;manualPausePending=true;
        string id=taskId, connectionToken=token;
        manualPauseNote=reason+(executingKind=="type" ? "；文字输入已暂停，请核对已输入部分后继续" : "，已暂停");
        if(allowing) startFailureNote=manualPauseNote;
        LocalPause();long version=epoch;manualPauseVersion=version;string note=manualPauseNote;
        status.Text=note;
        Action send=async()=>await Safe(async()=>await ReportManualPause(id,connectionToken,version,note));
        if(manualPauseDispatch!=null)manualPauseDispatch(send);else BeginInvoke(send);
    }
    async Task ReportManualPause(string id,string connectionToken,long version,string note) {
        try {
            if(!CurrentOperation(id,connectionToken,version)) return;
            var result=await Request("tasks/"+id+"/control",new {action="pause",note});
            if(!CurrentOperation(id,connectionToken,version)) return;
            state=S(result,"status");task=result;status.Text=TaskStage(result);ShowTaskControls();
            if(Changed!=null)Changed();
        } finally {
            if(manualPauseVersion==version)manualPausePending=false;
        }
    }
    async Task ReportStartFailure(string id,string connectionToken,long version,string note) {
        if(!CurrentOperation(id,connectionToken,version))return;
        var payload=new Dictionary<string,object>{{"action","handoff"},{"startupFailure",true},{"note",note.Substring(0,Math.Min(300,note.Length))}};
        if(nativeAttemptId.Length>0)payload["attemptId"]=nativeAttemptId;
        var result=await Request("tasks/"+id+"/control",payload);
        if(!CurrentOperation(id,connectionToken,version))return;
        // A failed claim which never reached the server performed no local action.
        if(nativeAttemptId.Length>0 && S(result,"status")=="WAITING")autoAttemptedId="";
        state=S(result,"status");task=result;status.Text=TaskStage(result);startFailureNote="";ShowTaskControls();
        if(Changed!=null)Changed();
    }
    async Task StopTask() { LocalPause(); await Safe(async () => { await Control("stop", "你已停止操作"); status.Text = "已停止"; }); }
    void RefreshWindows() {
        windows.Items.Clear();
        foreach(var item in Native.Windows(Handle)) {
            if(!BrowserOnly||Native.LocalBrowserWindows.ContainsKey(item.Handle))windows.Items.Add(item);
        }
        if (windows.Items.Count>0) windows.SelectedIndex = 0;
    }
    async Task AllowTask() { await StartTask(false); }
    bool CurrentStart(string id,string connectionToken,long version,string grant) {
        return CurrentOperation(id,connectionToken,version) && authorizationId==grant;
    }
    void CheckStart(string id,string connectionToken,long version,string grant) {
        if(!CurrentStart(id,connectionToken,version,grant)) throw new Exception("开始操作已取消，请核对任务后继续。");
    }
    async Task StartTask(bool automatic) {
        if(!EngineReady && !isolatedPreview) throw new Exception(EngineError??"本机执行器尚未就绪。");
        if (working || (polling && !automatic) || changingAuthorization || allowing || task == null || !new[]{"WAITING","PAUSED","NEEDS_USER"}.Contains(state)) throw new Exception("请等待当前状态更新后再试。");
        if(IsFolderBatch) {
            if(!Authorized || BrowserOnly || BoundTask)throw new Exception("桌面批量任务需要当前电脑已记住的本机操作授权。");
            if(state=="WAITING")await RunFolderCreation();
            else await Control("resume","继续原桌面批量任务");
            return;
        }
        if(IsBackgroundCopy && state=="WAITING") {await RunBackgroundCopy();return;}
        if(IsBackgroundCopy && state!="WAITING") {await Control("resume","继续原后台复制任务");return;}
        allowing=true;
        LocalPause(); long version=epoch;
        string id=taskId, grant=authorizationId, connectionToken=token;
        manualPauseSent=false;manualPausePending=false;manualPauseVersion=-1;manualPauseNote="";startFailureNote="";autoAttemptedId=id;
        failureTaskId="";failureDiagnostic="";nativeAttemptId="";
        Exception failure=null;
        try {
        string nativeAction=NativeAction;
        bool wecomTask=S(task,"startLocation")=="wecom";
        if(wecomTask || nativeAction.Length>0) {
            if(wecomTask) {
                if(BrowserOnly || BoundTask || nativeAction.Length>0 || grant.Length==0)
                    throw new Exception("请在原 Windows 电脑上记住操作授权，再继续企业微信任务。");
            } else if(BrowserOnly || grant.Length==0 || (nativeAction!="open_notepad" && nativeAction!="focus_notepad" && nativeAction!="type_notepad"))
                throw new Exception("请先在本机确认记住操作授权，再继续记事本任务。");
            if(state!="WAITING") {
                var resumed=await Request("tasks/"+id+"/control",new {action="resume"});
                CheckStart(id,connectionToken,version,grant);
                if(S(resumed,"status")!="WAITING")throw new Exception("任务状态已变化，请核对后继续。");
                // The server clears delivery on every resume. A real poll must
                // receive this attempt before the client may claim or execute it.
                task=resumed;state="WAITING";autoAttemptedId="";status.Text=TaskStage(resumed);
                ShowTaskControls();return;
            }
            if(wecomTask)await StartWeCom(id,connectionToken,version,grant);
            else await RunNotepad(id,connectionToken,version,grant,nativeAction);
            return;
        }
        if(captureBlocked)throw new Exception("窗口截取未响应，请重启本机助手后继续此任务。");
        bool browserOnly=BrowserOnly;
        bool fileTask=task.ContainsKey("fileCopy") && task["fileCopy"]!=null;
        if(fileTask && (browserOnly || BoundTask || grant.Length==0))throw new Exception("文件快捷键需要已记住授权的本机资源管理器。");
        bool explorerTask=!fileTask && !browserOnly && !BoundTask && grant.Length>0 && S(task,"startLocation")=="desktopExplorer";
        desktopExplorerTaskId="";
        if(((automatic && explorerTask) || fileTask) && state!="WAITING") {
            var resumed=await Request("tasks/"+id+"/control",new {action="resume"});
            CheckStart(id,connectionToken,version,grant);
            if(S(resumed,"status")!="WAITING")throw new Exception("原任务状态已变化，请核对后继续。");
            task=resumed;state="WAITING";autoAttemptedId="";ShowTaskControls();return;
        }
        var copyTask=fileTask ? new Native.ExplorerCopy(D(task["fileCopy"]),S(task,"instruction"),id+":"+grant,
            ReadFolderReceipt,
            value=>SaveProtected(folderReceipt,value)) : null;
        if(copyTask!=null) {
            status.Text="正在核对复制来源和目标目录。";
            await copyTask.Open(Handle,()=>CheckStart(id,connectionToken,version,grant));
            selected=copyTask.SourceWindow;
        } else if(BoundTask) {
            selected=BoundWindow();
        } else if(browserOnly) {
            selected=automatic?Native.Windows(Handle).FirstOrDefault(w=>Native.LocalBrowserWindows.ContainsKey(w.Handle)):windows.SelectedItem as WindowChoice;
            Native.LocalBrowser(selected).ValidateLocalPage();
        } else if(automatic && explorerTask) {
            status.Text="正在核对资源管理器的桌面目录。";
            selected=await Native.OpenDesktopExplorer(Handle,()=>CheckStart(id,connectionToken,version,grant));
        } else {
            selected=startWindowOverride!=null?startWindowOverride():automatic?Native.InitialWindow(Native.Windows(Handle)):windows.SelectedItem as WindowChoice;
        }
        if (selected == null) throw new Exception("请先打开要操作的应用，再刷新并选择窗口。");
        Native.ValidateWindow(selected, false);
        Native.RefreshTitle(selected);
        if(automatic) { status.Text="已收到电脑任务，即将按设备授权开始；"+StopShortcut+" 可停止。"; await Task.Delay(1500); }
        CheckStart(id,connectionToken,version,grant);
        if(BoundTask)BoundWindow();
        if(automatic && explorerTask)await Native.CheckDesktopExplorerStart(selected);
        if(copyTask!=null)await copyTask.CheckStart(selected);
        CheckStart(id,connectionToken,version,grant);
        var payload=new Dictionary<string,object>{{"action","allow"},{"window",selected.Title},{"application",selected.App},{"windowId",selected.Id}};
        if(grant.Length>0) payload["authorizationId"]=grant;
        if(browserOnly)payload["localBrowser"]=true;
        var result=await Request("tasks/" + id + "/control",payload);
        CheckStart(id,connectionToken,version,grant);
        if(S(result,"status")!="RUNNING") throw new Exception("任务已暂停或停止，请刷新后核对。");
        approvedId = id; activeAuthorizationId=grant;
        if(copyTask!=null)await copyTask.PrepareAuthorizedDestination(Handle,()=>CheckStart(id,connectionToken,version,grant));
        CheckStart(id,connectionToken,version,grant);
        if(!Native.IsForeground(selected) && !Native.SetForegroundWindow(selected.Handle)) throw new Exception("无法激活操作窗口，请手动切换后继续。");
        await Task.Delay(700);
        CheckStart(id,connectionToken,version,grant);
        Native.ValidateWindow(selected, true);
        if(automatic && explorerTask)await Native.CheckDesktopExplorerStart(selected);
        if(copyTask!=null) {
            await copyTask.CheckStart(selected);
            await copyTask.SelectSourceFiles(()=>CheckStart(id,connectionToken,version,grant));
        }
        CheckStart(id,connectionToken,version,grant);
        if(explorerTask)desktopExplorerTaskId=id;
        fileCopy=copyTask;
        armed = true; epoch++; state="RUNNING"; allow.Enabled=false; manualAllow.Enabled=false;
        status.Text = "正在操作；点击、滚轮或按键可接手，移动鼠标不会中断。";
        } catch(Exception ex) {
            // A user pause/stop, grant change or newer task owns its own outcome.
            if(!CurrentStart(id,connectionToken,version,grant))return;
            LocalPause();version=epoch;failure=ex;startFailureNote=ex.Message;
        }
        finally { locatingWeCom=false;allowing=false; }
        if(failure!=null) {
            await ReportStartFailure(id,connectionToken,version,startFailureNote);
        }
    }
    async Task RunNotepad(string id,string connectionToken,long version,string grant,string nativeAction) {
        Action check=()=>CheckStart(id,connectionToken,version,grant);
        nativeAttemptId=Guid.NewGuid().ToString();
        var claim=await Request("tasks/"+id+"/control",new {action="start_native",authorizationId=grant,attemptId=nativeAttemptId});
        check();
        if(S(claim,"status")!="RUNNING")throw new Exception("任务状态或本机授权已变化，请核对后继续。");
        task=claim;state="RUNNING";status.Text="正在定位系统记事本窗口。";
        WindowChoice target;
        if(nativeAction=="type_notepad") {
            target=BoundWindow();
            Native.SetForegroundWindow(target.Handle);
            for(int i=0;i<10 && !Native.IsForeground(target);i++){await Task.Delay(100);check();}
            check();BoundWindow();Native.ValidateWindow(target,true);
            string key="notepad-input:"+id;
            if(journal.ContainsKey(key))throw new Exception("此任务已尝试输入，请核对原文后重新下达指令。");
            string text=S(task,"nativeText");
            continuation.InsertNotepadText(text,()=>{check();Record(key,"requested");});
        } else target=notepadOverride!=null
            ? await notepadOverride(nativeAction,check)
            : await Native.FocusNotepad(Handle,nativeAction=="open_notepad",check,()=>{
                string key="notepad-launch:"+id;
                if(journal.ContainsKey(key))throw new Exception("本任务已尝试启动记事本。请打开其窗口后继续。");
                Record(key,"requested");
            });
        check();
        RememberWindow(id,target);
        var completion=new Dictionary<string,object>{{"action","complete_native"},{"authorizationId",grant},{"attemptId",nativeAttemptId},{"windowId",target.Id},{"window",target.Title},{"application","notepad"}};
        if(continuation!=null)completion["retainedWindow"]=true;
        var result=await Request("tasks/"+id+"/control",completion);
        check();
        state=S(result,"status");task=result;status.Text=TaskStage(result);ShowTaskControls();
        if(Changed!=null)Changed();
    }
    async Task StartWeCom(string id,string connectionToken,long version,string grant) {
        Action check=()=>CheckStart(id,connectionToken,version,grant);
        locatingWeCom=true;
        nativeAttemptId=Guid.NewGuid().ToString();
        var claimBody=new {action="start_wecom",authorizationId=grant,attemptId=nativeAttemptId};
        var claim=await Request("tasks/"+id+"/control",claimBody);
        check();
        if(S(claim,"status")!="RUNNING")throw new Exception("企业微信任务已停止或已撤销授权。");
        task=claim;state="RUNNING";status.Text="正在查找这台电脑上的企业微信。";
        Action beforeLaunch=()=>{
            check();
            string key="wecom-launch:"+id;
            if(journal.ContainsKey(key))throw new Exception("此任务已请求打开企业微信。请从托盘打开主窗口后继续。");
            Record(key,"requested");
        };
        var lastCheck=Stopwatch.StartNew();
        Func<bool,Task> checkLease=async force=>{
            check();
            if(force || lastCheck.ElapsedMilliseconds>=3000) {
                var current=await Request("tasks/"+id+"/control",claimBody);
                check();
                if(S(current,"status")!="RUNNING")throw new Exception("原企业微信定位任务已暂停或停止。");
                lastCheck.Restart();
            }
        };
        Func<Task> waitForIdle=async()=>{
            do {
                while(WaitingForWindow(true,lastPhysicalInput,DateTime.UtcNow)) {
                    status.Text="正在等你用完键鼠，再定位企业微信。";
                    await Task.Delay(250);await checkLease(false);
                }
                await checkLease(true);
            } while(WaitingForWindow(true,lastPhysicalInput,DateTime.UtcNow));
        };
        var target=wecomOverride!=null ? await wecomOverride(check,beforeLaunch) : await Native.FocusWeCom(check,beforeLaunch,waitForIdle,()=>checkLease(false));
        check();
        var result=await Request("tasks/"+id+"/control",new {action="ready_wecom",authorizationId=grant,attemptId=nativeAttemptId,windowId=target.Id,window="企业微信",application="WXWork"});
        check();state=S(result,"status");task=result;
        if(state=="RUNNING") {
            selected=target;approvedId=id;activeAuthorizationId=grant;wecomTaskId=id;
            foregroundInputAt=WaitingForWindow(true,lastPhysicalInput,DateTime.UtcNow)?lastPhysicalInput:DateTime.MinValue;
            armed=true;epoch++;allow.Enabled=false;manualAllow.Enabled=false;
        }
        status.Text=TaskStage(result);ShowTaskControls();if(Changed!=null)Changed();
    }
    async Task Poll() {
        if (polling || allowing || changingAuthorization || token.Length == 0 || closing) return;
        polling = true;
        string connectionToken=token; long permissionVersion=permissionEpoch, pollVersion=epoch;
        try {
            string retainedTaskId=continuation==null?null:continuation.RetainedTaskId(authorizationId);
            var result = await Request("poll", new { localBrowser=true, nativeActions=true, windowContinuations=true, desktopExplorer=true, fileCopyShortcuts=true, desktopFolderCopy=true, fileCopyVerification=true, backgroundFileCopy=true, folderCreation=true, folderNotes=true, folderBatchNotes=true, folderAttachment=true, folderAttachments=true, wecomApp=true, retainedTaskId });
            if(token!=connectionToken || permissionVersion!=permissionEpoch || pollVersion!=epoch || closing) return;
            if(!await ReconcileAuthorization(result)) return;
            task = D(result.ContainsKey("task") ? result["task"] : null);
            if (task.Count == 0) { taskId = ""; state = ""; allow.Enabled = false; LocalPause(); if (!working) status.Text = "暂无进行中的电脑任务；结果可在网站查看。"; return; }
            string id = S(task,"id"); state = S(task,"status");
            if (taskId != id) { LocalPause(); approvedId = ""; autoAttemptedId="";startFailureNote="";nativeAttemptId="";manualPauseSent=false;manualPausePending=false; if(BrowserOnly)RefreshWindows(); }
            taskId = id; instruction.Text = S(task,"instruction"); if(!manualPausePending || !new[]{"WAITING","RUNNING"}.Contains(state))status.Text = TaskStage(task);
            allow.Enabled = !captureBlocked && !working && new[]{"WAITING","PAUSED","NEEDS_USER"}.Contains(state);
            if (state != "RUNNING" && armed) LocalPause();
            if (state=="PAUSED" || state=="NEEDS_USER") { autoAttemptedId="";startFailureNote=""; }
            if(authorizationId.Length>0 && !manualPausePending && !working && !allowing) {
                if(IsFolderBatch && (state=="WAITING" || state=="RUNNING")) {
                    BeginFolderCreation();
                    return;
                }
                var verify=D(task.ContainsKey("fileCopyVerification")?task["fileCopyVerification"]:null);
                if(verify.Count>0 && (state=="NEEDS_USER" || state=="RUNNING")) {
                    if(previousVerificationId!=S(verify,"commandId"))BeginPasteVerification(verify);
                    return;
                }
                if(IsBackgroundCopy && (state=="RUNNING" || state=="WAITING")) {
                    BeginBackgroundCopy();
                    return;
                }
            }
            if(new[]{"WAITING","RUNNING"}.Contains(state) && autoAttemptedId==id && startFailureNote.Length>0 && !manualPausePending && !working) {
                // Retry only the failure report after a network loss, never desktop input.
                await ReportStartFailure(id,connectionToken,epoch,startFailureNote);return;
            }
            if (authorizationId.Length>0 && state=="WAITING" && autoAttemptedId!=id && !working) {
                autoAttemptedId=id;
                await StartTask(true);
                return;
            }
            if (state == "RUNNING" && !armed && !working && !manualPausePending) await Control("handoff", manualPauseNote.Length>0?manualPauseNote:"本机输入已暂停，请核对任务和窗口后继续");
            if (state == "RUNNING" && armed && !working) { working = true; RunStep(taskId, epoch); }
        } catch(ApiFailure e) {
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            LocalPause(); status.Text = e.Message;
            if (e.Status == 401 || e.Status == 403) {
                ClearExpiredConnection();
            }
        }
        catch(Exception e) {
            if(token!=connectionToken || permissionVersion!=permissionEpoch || closing) return;
            LocalPause(); status.Text = e is HttpRequestException || e is TaskCanceledException ? "网络连接中断，已停止本机输入。恢复后请核对任务并继续。" : e.Message;
        }
        finally { polling = false; if(!closing) { ShowTaskControls(); if(Changed!=null) Changed(); } }
    }
    bool CanYieldForeground { get { return armed && !allowing && selected!=null && fileCopy==null && activeAuthorizationId.Length>0 && activeAuthorizationId==authorizationId; } }
    static bool WaitingForWindow(bool foreground,DateTime inputAt,DateTime now) {
        return !foreground || now-inputAt<TimeSpan.FromSeconds(3);
    }
    void Check(string id, long version) {
        CheckTaskActive(id,version);
        if(observingForeground && CanYieldForeground) {
            Native.ValidateWindow(selected,false,true);
            if(foregroundInputAt!=DateTime.MinValue || !Native.IsForeground(selected))throw new ForegroundInUse();
        }
        Native.ValidateWindow(selected, true);
        if(wecomTaskId==id)Native.CheckWeComWindow(selected);
        if(BoundTask)BoundWindow();
        if(BrowserOnly)Native.LocalBrowser(selected).ValidateLocalPage();
    }
    void CheckTaskActive(string id,long version) {
        if (!armed || id != approvedId || id != taskId || version != epoch || closing) throw new Exception("操作已暂停");
        if(activeAuthorizationId.Length>0 && activeAuthorizationId!=authorizationId) throw new Exception("跨窗口授权已撤销");
    }
    async void RunStep(string id, long version) {
        string commandId = "",connectionToken=token;
        Shot shot=null;
        Exception failure=null;
        try {
        try {
            observingForeground=CanYieldForeground;
            if(observingForeground) {
                Native.ValidateWindow(selected,false,true);
                if(WaitingForWindow(Native.IsForeground(selected),foregroundInputAt,DateTime.UtcNow))throw new ForegroundInUse();
                foregroundInputAt=DateTime.MinValue;
            }
            Check(id, version);
            Native.RefreshTitle(selected);
            bool browserOnly=BrowserOnly;
            BrowserWindow localBrowser=browserOnly?Native.LocalBrowser(selected):null;
            long browserRevision=localBrowser==null?0:localBrowser.PageRevision;
            Rectangle? contentBounds=localBrowser==null?(Rectangle?)null:localBrowser.ContentBounds();
            Action checkInput=()=>{
                Check(id,version);
                if(localBrowser!=null&&browserRevision!=localBrowser.PageRevision)
                    throw new Exception("本地网页已切换，请核对当前页面再继续。");
            };
            bool wecom=wecomTaskId==id;
            bool crossWindow=!browserOnly&&!BoundTask&&!wecom&&activeAuthorizationId.Length>0;
            var copy=fileCopy;
            if(copy!=null)await copy.CheckLocation(selected);
            var available = copy!=null ? copy.Windows(selected) : crossWindow ? Native.ObservationWindows(Handle,selected) : new List<WindowChoice>();
            string explorerFolder=crossWindow && desktopExplorerTaskId==id ? await Native.DesktopExplorerListLocation(selected) : null;
            checkInput();
            // UI Automation and PrintWindow may wait on a hung application. Never capture another window as fallback.
            var capture = Task.Run(() => Native.Capture(selected, contentBounds, copy!=null));
            if (await Task.WhenAny(capture,Task.Delay(4000)) != capture) { captureBlocked=true; throw new Exception("应用窗口没有响应，请关闭本机助手后重试"); }
            shot = await capture;
            checkInput();
            if(copy!=null && shot.Popup!=null)throw new Native.InputNotSent("请关闭资源管理器中的菜单，核对文件列表后继续。");
            string requestId=Guid.NewGuid().ToString();
            var observation=new Dictionary<string,object>{{"requestId",requestId},{"window",selected.Title},{"application",selected.App},{"windowId",selected.Id}};
            if(copy!=null)observation["fileCopy"]=true;
            else {
                observation["image"]=shot.Image;observation["width"]=shot.Width;
                observation["height"]=shot.Height;observation["controls"]=shot.Controls;
            }
            if(copy!=null && crossWindow && shot.Popup==null) {
                shot.FileShortcut=await copy.WaitForEvidence(selected,checkInput);
                if(shot.FileShortcut!=null)observation["fileShortcut"]=shot.FileShortcut;
            }
            if(explorerFolder!=null && shot.Popup==null && String.Equals(explorerFolder,await Native.DesktopExplorerListLocation(selected),StringComparison.OrdinalIgnoreCase)) {
                shot.ExplorerFolder=explorerFolder;
                observation["desktopExplorer"]=true;
            }
            checkInput();
            if(browserOnly)observation["localBrowser"]=true;
            else if(crossWindow) observation["windows"]=available.Select(w=>new {id=w.Id,title=w.Title,application=w.App}).ToArray();
            var plan = await Request("tasks/" + id + "/plan", observation);
            CheckTaskActive(id,version);
            var command = D(plan.ContainsKey("command") ? plan["command"] : null);
            if (command.Count == 0) {
                if(foregroundInputAt==DateTime.MinValue && Native.IsForeground(selected) && S(D(plan.ContainsKey("task")?plan["task"]:null),"status")=="DONE")RememberWindow(id,selected);
                LocalPause(); return;
            }
            commandId = S(command,"id"); Guid parsed;
            if (!Guid.TryParse(commandId, out parsed)) throw new Exception("指令标识无效");
            string outcome;
            if (journal.TryGetValue(commandId, out outcome)) {
                // An uncertain input is handed back, never replayed, even after a restart or lost HTTP response.
                await Ack(id,commandId,outcome=="ok"?"ok":outcome=="blocked"?"blocked":"uncertain", outcome=="ok"?"该步骤已执行，已恢复反馈":outcome=="blocked"?"本步未发送输入，请核对窗口后继续":"上次执行结果不确定，请核对窗口后继续");
                if (outcome != "ok") LocalPause();
                return;
            }
            if(observingForeground && S(command,"requestId")==requestId && (foregroundInputAt!=DateTime.MinValue || !Native.IsForeground(selected))) {
                // No permit or input has been issued for this observation. Never replay its coordinates.
                await Request("tasks/"+id+"/yield-observation",new {requestId,commandId});
                throw new ForegroundInUse();
            }
            observingForeground=false;
            checkInput();
            var action = D(command.ContainsKey("action") ? command["action"] : null);
            if(S(command,"requestId")!=requestId) throw new Exception("待执行步骤来自旧画面，请核对窗口后继续");
            Native.ValidateAction(action);
            string wecomInput=S(command,"wecomInput");
            if(wecom)Native.CheckWeComAction(action,shot.Popup!=null,wecomInput);
            if(copy!=null)copy.VerifyOtherAction(action,selected);
            string key=S(action,"kind")=="key"?S(action,"key"):"";
            bool copyKey=key=="COPY" || key=="PASTE";
            var permitBody=new Dictionary<string,object>{{"commandId",commandId}};
            if(copyKey) {
                string expected=key=="COPY"?"copy":"paste";
                if(copy==null || shot.Popup!=null || shot.FileShortcut!=expected || await copy.WaitForEvidence(selected,checkInput)!=expected)
                    throw new Native.InputNotSent("本次文件快捷键未能核对来源选中项、目标或剪贴板，本步未发送。");
                checkInput();permitBody["fileShortcut"]=expected;
            }
            WindowChoice target=null;
            if(S(action,"kind")=="switch_window") {
                if(shot.Popup!=null)throw new Native.InputNotSent("弹出菜单打开时只能操作已核验的当前菜单。");
                if(browserOnly || BoundTask || wecom)throw new Exception("此任务只能操作已确认的窗口。");
                if(activeAuthorizationId.Length==0) throw new Exception("尚未授权跨窗口操作");
                target=Native.ResolveTarget(available,S(action,"windowId"),selected);
                Native.ValidateWindow(target,false);
            }
            Check(id,version);
            var permit = await Request("tasks/" + id + "/permit",permitBody);
            if (!permit.ContainsKey("allowed") || !Convert.ToBoolean(permit["allowed"])) throw new Exception("步骤已过期或已暂停，请核对后继续");
            Check(id, version);
            Record(commandId,"uncertain"); // Write-ahead record must succeed before any input.
            if(target!=null) {
                Check(id,version); Native.ValidateWindow(target,false);
                if(!Native.IsForeground(target) && !Native.SetForegroundWindow(target.Handle)) throw new Exception("无法切换目标窗口，请手动切换后继续。");
                selected=target;
                await Task.Delay(500);
                Check(id,version);
                if(copy!=null)await copy.PrepareSwitchedWindow(target,()=>Check(id,version));
            } else {
                if(copy!=null)await copy.CheckLocation(selected);
                if(copy!=null && key=="PASTE")copy.PasteCommandId=commandId;
                executingKind=S(action,"kind");await Native.Execute(selected,shot,action,checkInput,localBrowser,copy,()=>CheckTaskActive(id,version),wecom,wecomInput);
            }
            Record(commandId,"ok");
            observingForeground=CanYieldForeground;
            await Ack(id,commandId,"ok",S(action,"description"));
            await Task.Delay(600);
        } catch(ForegroundInUse) {
            if(CurrentOperation(id,connectionToken,version))status.Text=WaitingForForeground;
            return;
        } catch(Exception e) {
            if(version!=epoch || taskId!=id || closing)return;
            string knownOutcome;
            bool wasVerified=commandId.Length>0 && journal.TryGetValue(commandId,out knownOutcome) && knownOutcome=="ok";
            LocalPause();status.Text=FailureText(e);if(!wasVerified)failure=e;
        }
        if(failure!=null) {
            try { await ReportStepFailure(id,connectionToken,epoch,commandId,failure); } catch { /* Keep the original safe failure; never retry desktop input here. */ }
        }
        } finally { if(shot!=null && shot.Popup!=null)shot.Popup.Release();working=false;observingForeground=false;executingKind="";if(!closing){ShowTaskControls();if(Changed!=null)Changed();} }
    }
    async Task Ack(string id,string commandId,string outcome,string note) { await Request("tasks/"+id+"/ack",new {commandId,outcome,note}); }
    async void BeginFolderCreation() { await Safe(RunFolderCreation); }
    async Task DownloadTaskAttachment(Native.FolderAttachment attachment,string id,string attempt,string grant,string connectionToken,Func<Task> check,System.Threading.CancellationToken stop) {
        Guid taskGuid,attemptGuid,grantGuid;
        if(!Guid.TryParse(id,out taskGuid) || !Guid.TryParse(attempt,out attemptGuid) || !Guid.TryParse(grant,out grantGuid))
            throw new IOException("附件任务的授权编号无效。");
        string path=Base+"tasks/"+taskGuid+"/folder-attachment?attemptId="+attemptGuid+"&authorizationId="+grantGuid;
        if(attachment.Id!=null)path+="&fileId="+attachment.Id;
        using(var deadline=System.Threading.CancellationTokenSource.CreateLinkedTokenSource(stop))
        using(var request=new HttpRequestMessage(HttpMethod.Get,path)) {
            deadline.CancelAfter(TimeSpan.FromMinutes(3));request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",connectionToken);
            using(var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token)) {
                if(!response.IsSuccessStatusCode)throw new IOException("无法读取本次任务授权的附件（HTTP "+(int)response.StatusCode+"）。");
                if(response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value!=attachment.Length)
                    throw new IOException("任务附件大小与授权回执不一致。");
                using(var stream=await response.Content.ReadAsStreamAsync())
                using(deadline.Token.Register(stream.Dispose)) {
                    var bytes=new byte[attachment.Length];int offset=0;
                    while(offset<bytes.Length) {
                        await check();
                        int read=await stream.ReadAsync(bytes,offset,Math.Min(131072,bytes.Length-offset),deadline.Token);
                        if(read==0)throw new IOException("附件传输中断，请重试。");
                        offset+=read;
                    }
                    if(await stream.ReadAsync(new byte[1],0,1,deadline.Token)!=0)throw new IOException("附件传输长度超出授权范围。");
                    await Task.Run(()=>attachment.SetContent(bytes),deadline.Token);
                }
            }
        }
    }
    async Task RunFolderCreation() {
        if(working || allowing || !Authorized || BrowserOnly || BoundTask || !IsFolderBatch)return;
        string expectedAction=NativeAction;
        string id=taskId,grant=authorizationId,connectionToken=token,attempt=S(task,"folderCreationAttemptId");
        long version=epoch;
        Guid parsed;
        if(!Guid.TryParse(attempt,out parsed))throw new Exception("未收到本次桌面批量任务的编号。");
        working=true;backgroundAttemptId=attempt;
        string route="tasks/"+id+"/folder-creation";
        Action check=()=>{
            CheckStart(id,connectionToken,version,grant);
            if(backgroundAttemptId!=attempt || NativeAction!=expectedAction || S(task,"folderCreationAttemptId")!=attempt || (state!="WAITING" && state!="RUNNING"))
                throw new OperationCanceledException("桌面批量任务已停止。");
        };
        Func<Task<Dictionary<string,object>>> claim=async()=>{
            check();
            var result=await Request(route,new {action="start",authorizationId=grant,attemptId=attempt});
            check();
            if(S(result,"id")!=id || S(result,"folderCreationAttemptId")!=attempt || S(result,"status")!="RUNNING" || S(result,"nativeAction")!=expectedAction)
                throw new OperationCanceledException("本次桌面批量任务授权已失效。");
            return result;
        };
        string handoff=null;
        try {
            try {
            var start=await claim();
            task=start;state="RUNNING";
            status.Text=Native.CopiesAttachments(expectedAction)?"正在后台分发聊天附件并核验各子目录中的副本，可以继续使用键鼠。":
                expectedAction==Native.CreateFoldersWithNotes?"正在后台创建并核对子目录和同名文本文件，可以继续使用键鼠。":
                expectedAction==Native.CreateNotes?"正在各子目录中创建并核对同名文本文件，可以继续使用键鼠。":"正在后台创建并核对文件夹，可以继续使用键鼠。";
            var lease=Stopwatch.StartNew();
            var ui=Stopwatch.StartNew();
            Func<Task> checkpoint=async()=>{
                if(ui.ElapsedMilliseconds>=40) { await Task.Delay(1);ui.Restart(); }
                check();
                if(lease.ElapsedMilliseconds>=2000) {await claim();lease.Restart();}
            };
            var plan=D(start.ContainsKey("folderCreation")?start["folderCreation"]:null);
            int verified;
            string[] verifiedDigests=null;
            if(expectedAction==Native.CreateFoldersWithNotes || Native.CopiesAttachments(expectedAction)) {
                var steps=FilePlanRunner.ReadSteps(start.ContainsKey("folderSteps")?start["folderSteps"]:null);
                if(!steps.SequenceEqual(Native.FolderSteps(expectedAction)))throw new IOException("任务授权与文件执行脚本不一致。");
                folderPlanStop=new System.Threading.CancellationTokenSource();
                try {
                    Native.FolderAttachment[] sources=null;
                    if(expectedAction==Native.CopyAttachment)sources=new[]{new Native.FolderAttachment(D(start.ContainsKey("folderAttachment")?start["folderAttachment"]:null))};
                    else if(Native.CopiesAttachments(expectedAction))sources=Native.FolderAttachment.ReadList(start.ContainsKey("folderAttachments")?start["folderAttachments"]:null);
                    if(sources!=null)foreach(var attachment in sources) {
                        await DownloadTaskAttachment(attachment,id,attempt,grant,connectionToken,checkpoint,folderPlanStop.Token);
                        await checkpoint();
                    }
                    verified=await executeFileScript(plan,steps,checkpoint,folderPlanStop.Token,sources);
                    if(sources!=null)verifiedDigests=sources.Select(a=>a.Digest).ToArray();
                }
                finally {folderPlanStop.Dispose();folderPlanStop=null;}
            } else verified=await executeFolderBatch(plan,checkpoint,expectedAction);
            check();
            var completion=new Dictionary<string,object>{{"action","complete"},{"authorizationId",grant},{"attemptId",attempt},{"verifiedCount",verified}};
            if(expectedAction==Native.CopyAttachment)completion["sha256"]=verifiedDigests[0];
            else if(verifiedDigests!=null)completion["sha256s"]=verifiedDigests;
            var result=await Request(route,completion);
            if(CurrentStart(id,connectionToken,version,grant)) {task=result;state=S(result,"status");status.Text=TaskStage(result);}
        } catch(Exception error) {
            if(!CurrentStart(id,connectionToken,version,grant))return;
            status.Text=FailureText(error);
            if(!(error is HttpRequestException || error is OperationCanceledException || error is ApiFailure))handoff=status.Text;
            }
            if(handoff!=null) {
                var result=await Request("tasks/"+id+"/control",new {action="handoff",startupFailure=true,attemptId=attempt,note=handoff});
                if(CurrentStart(id,connectionToken,version,grant)){task=result;state=S(result,"status");status.Text=TaskStage(result);}
            }
        } finally {working=false;backgroundAttemptId="";if(!closing)ShowTaskControls();}
    }
    async void BeginBackgroundCopy() {await Safe(RunBackgroundCopy);}
    async Task RunBackgroundCopy() {
        if(working || allowing || authorizationId.Length==0 || !IsBackgroundCopy || BrowserOnly || BoundTask)return;
        string id=taskId,grant=authorizationId,connectionToken=token;
        long version=epoch;
        var seed=task;bool recovering=state=="RUNNING";
        var saved=D(seed.ContainsKey("backgroundCopyAttempt")?seed["backgroundCopyAttempt"]:null);
        string attempt=recovering?S(saved,"attemptId"):Guid.NewGuid().ToString();
        Guid parsed;if(!Guid.TryParse(attempt,out parsed))return;
        working=true;backgroundAttemptId=attempt;
        Action check=()=>{
            CheckStart(id,connectionToken,version,grant);
            if(backgroundAttemptId!=attempt || (state!="WAITING" && state!="RUNNING"))throw new OperationCanceledException("原后台任务已暂停或停止");
        };
        Func<string,string,Task<Dictionary<string,object>>> send=(action,note)=>Request("tasks/"+id+"/background-copy",new{action,authorizationId=grant,attemptId=attempt,note});
        string handoff=null;
        try {
        try {
            if(!recovering) {await send("start","后台复制已接单");check();state="RUNNING";}
            var spec=D(seed.ContainsKey("fileCopy")?seed["fileCopy"]:null);
            if(spec.Count==0)throw new Exception("缺少本次后台复制的文件范围。");
            status.Text="正在后台核对文件，电脑可以正常使用。";
            if(recovering) {
                if(!saved.ContainsKey("permitted") || !Object.Equals(saved["permitted"],true))throw new Exception("后台尝试已中断且未取得写入许可，请核对原任务。");
                var verified=Native.ExplorerCopy.ForBackgroundVerification(spec,S(seed,"instruction"),id+":"+grant,ReadFolderReceipt,attempt);
                await verified.VerifyPastedFiles(check);
            } else {
                var copy=new Native.ExplorerCopy(spec,S(seed,"instruction"),id+":"+grant,ReadFolderReceipt,value=>SaveProtected(folderReceipt,value));
                await send("permit","来源与目标已核对，申请一次后台写入");check();
                var last=Stopwatch.StartNew();
                Func<Task> lease=async()=>{
                    check();
                    if(last.ElapsedMilliseconds>=2200) {
                        await send("check","检查原后台任务授权");check();last.Restart();
                    }
                };
                status.Text="正在后台复制文件，电脑可以正常使用。";
                await copy.RunBackground(attempt,lease,check);
            }
            check();
            var done=await send("complete","后台复制已逐项核对文件内容和原目录。");
            if(CurrentStart(id,connectionToken,version,grant)) {
                task=done;state=S(done,"status");LocalPause();status.Text=TaskStage(done);
            }
        } catch(Exception e) {
            if(CurrentStart(id,connectionToken,version,grant) && (state=="WAITING" || state=="RUNNING")) {
                status.Text=FailureText(e);
                // A lost response may have committed the original attempt. Poll for it;
                // never write the files again on an uncertain network response.
                if(!(e is HttpRequestException) && !(e is TaskCanceledException) && !(e is ApiFailure)) {
                    handoff=FailureText(e);
                }
            }
        }
        if(handoff!=null) {try {await send("handoff",handoff);} catch {}}
        } finally {working=false;backgroundAttemptId="";if(!closing)ShowTaskControls();}
    }
    async void BeginPasteVerification(Dictionary<string,object> verify) {
        string id=taskId,grant=authorizationId,connectionToken=token,command=S(verify,"commandId");
        Guid parsed;
        if(grant!=S(verify,"authorizationId") || !Guid.TryParse(command,out parsed) || working || armed || allowing)return;
        long version=epoch;var seed=task;working=true;previousVerificationId=command;
        Action check=()=>{
            CheckStart(id,connectionToken,version,grant);
            var latest=D(task.ContainsKey("fileCopyVerification")?task["fileCopyVerification"]:null);
            if((state!="RUNNING" && state!="NEEDS_USER") || S(latest,"commandId")!=command ||
                S(latest,"authorizationId")!=grant)throw new OperationCanceledException("原任务已更改");
        };
        string outcome="uncertain",note="";
        try {
            try {
                check();string recorded;
                if(!journal.TryGetValue(command,out recorded) || (recorded!="ok" && recorded!="uncertain" && recorded!="blocked"))
                    throw new Exception("缺少原粘贴指令在本机的执行日志。");
                var spec=D(seed.ContainsKey("fileCopy")?seed["fileCopy"]:null);
                var local=Native.ExplorerCopy.ForVerification(spec,S(seed,"instruction"),id+":"+grant,ReadFolderReceipt,command);
                if(local.VerifiedUnsent) {
                    if(recorded=="ok")throw new Exception("原命令成功记录与未发键阶段不一致，请核对。");
                    outcome="blocked";note="原任务的粘贴尚未发出，已核验来源清单和该任务创建的空目录。";
                } else {
                    if(recorded=="blocked")throw new Exception("原命令日志与粘贴阶段不一致，请核对。");
                    await local.VerifyPastedFiles(check);outcome="ok";note="已还原原粘贴回执，源与目标内容逐项核验一致。";
                }
            } catch(Exception e) {note=FailureText(e);}
            check();
            var corrected=await Request("tasks/"+id+"/ack",new{commandId=command,outcome,fileCopyVerified=true,authorizationId=grant,note});
            if(CurrentStart(id,connectionToken,version,grant)) {
                task=corrected;state=S(task,"status");status.Text=TaskStage(task);
                autoAttemptedId="";LocalPause();
                if(outcome=="blocked" && state=="NEEDS_USER")previousVerificationId="";
            }
        } catch {previousVerificationId="";} // an interrupted read-only report can be retried
        finally {working=false;if(!closing)ShowTaskControls();}
    }
    // Self-tests use a hidden form, fake HTTP and a fresh temporary directory.
    // They never start the engine, load real credentials, install hooks or send desktop input.
    sealed class FakeHandler : HttpMessageHandler {
        public Func<HttpRequestMessage,HttpResponseMessage> Reply;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,System.Threading.CancellationToken cancellationToken) { return Task.FromResult(Reply(request)); }
    }
    AssistantForm(HttpMessageHandler handler,string isolatedFolder) : this() {
        http.Dispose(); http=new HttpClient(handler); folder=isolatedFolder; isolatedPreview=true;
    }
    static HttpResponseMessage TestResponse(int code,string body) { return new HttpResponseMessage((HttpStatusCode)code){Content=new StringContent(body,Encoding.UTF8,"application/json")}; }
    public static int ConnectionSelfTest() {
        string isolated=Path.Combine(Path.GetTempPath(),"xuti-connection-test-"+Guid.NewGuid().ToString("N"));
        try {
            var fake=new FakeHandler();
            using(var form=new AssistantForm(fake,isolated)) {
                Native.DesktopExplorerSelfTest(isolated);
                Native.ExplorerCopy.SelfTest(isolated);
                Native.FolderCreationSelfTest(isolated);
                Native.WeComSelfTest(isolated);
                System.Threading.SynchronizationContext.SetSynchronizationContext(null);
                FilePlanRunner.SelfTest();
                Action seed=()=>{form.token=new string('a',64);form.owner="Isolated self-test";form.deviceId=Guid.NewGuid().ToString();form.authorizationId=Guid.NewGuid().ToString();};
                seed(); string grant=form.authorizationId;
                fake.Reply=req=>{var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));if(!req.RequestUri.AbsolutePath.EndsWith("/poll")||!Object.Equals(body["statusOnly"],true)||body.ContainsKey("localBrowser"))throw new Exception("Status refresh advertised a working engine");return TestResponse(200,"{\"data\":{\"authorizationId\":\""+grant+"\",\"task\":{\"status\":\"WAITING\"}}}");};
                form.RefreshStatus().GetAwaiter().GetResult();
                if(!form.Connected||!form.Authorized||form.taskId.Length>0||form.armed)throw new Exception("Status changed valid authorization or started execution");
                foreach(int code in new[]{401,403}) {
                    seed();fake.Reply=req=>TestResponse(code,"{\"error\":{\"message\":\"expired\"}}");
                    form.RefreshStatus().GetAwaiter().GetResult();
                    if(form.Connected||form.Authorized||form.deviceId.Length>0)throw new Exception("Expired credential retained");
                }
                seed();string retained=form.token;grant=form.authorizationId;
                fake.Reply=req=>{throw new HttpRequestException("isolated network failure");};
                bool network=false;try{form.RefreshStatus().GetAwaiter().GetResult();}catch(ApiFailure e){network=e.Status==503;}
                if(!network||form.token!=retained||form.authorizationId!=grant)throw new Exception("Network error erased saved authorization");
                seed();fake.Reply=req=>{form.token=new string('b',64);form.deviceId="new-device";form.permissionEpoch++;return TestResponse(401,"{}");};
                form.RefreshStatus().GetAwaiter().GetResult();
                if(form.token!=new string('b',64)||form.deviceId!="new-device")throw new Exception("Late status erased a newer connection");
                seed();fake.Reply=req=>TestResponse(200,"{\"data\":{\"authorizationId\":null}}");
                form.RefreshStatus().GetAwaiter().GetResult();
                if(!form.Connected||form.Authorized)throw new Exception("Remote revocation did not preserve unprivileged connection");
                seed();form.authorizationId="";int revocations=0;
                fake.Reply=req=>{if(req.RequestUri.AbsolutePath.EndsWith("/authorization")){revocations++;bool blocked=false;try{form.RequestAuthorization(form.deviceId).GetAwaiter().GetResult();}catch(Exception e){blocked=e.Message.Contains("状态正在更新");}if(!blocked)throw new Exception("New consent overlapped an in-flight old revoke");return TestResponse(200,"{\"data\":{}}");}return TestResponse(200,"{\"data\":{\"authorizationId\":\""+Guid.NewGuid().ToString()+"\"}}");};
                form.RefreshStatus().GetAwaiter().GetResult();
                if(form.Authorized||revocations!=1)throw new Exception("Status elevated an unconfirmed local grant");
                Action newTask=()=>{seed();form.taskId=Guid.NewGuid().ToString();form.task=new Dictionary<string,object>{{"id",form.taskId},{"status","WAITING"},{"stage","Waiting"}};form.state="WAITING";form.armed=false;form.allowing=false;form.working=false;form.manualPauseSent=false;form.manualPausePending=false;form.manualPauseVersion=-1;form.startFailureNote="";form.autoAttemptedId="";form.epoch++;};
                foreach(string batchAction in new[]{Native.CreateFolders,Native.CreateNotes,Native.CreateFoldersWithNotes,Native.CopyAttachment,Native.CopyAttachments,Native.CreateFoldersWithAttachments}) {
                newTask();
                string batchAttempt=Guid.NewGuid().ToString();
                form.task["nativeAction"]=batchAction;form.task["folderCreationAttemptId"]=batchAttempt;
                int batchRequests=0,batchExecutions=0,downloads=0;
                bool plural=batchAction==Native.CopyAttachments || batchAction==Native.CreateFoldersWithAttachments;
                var fixtures=new[]{
                    new{id=Guid.NewGuid().ToString(),name="test 文档.txt",bytes=3,sha256="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
                    new{id=Guid.NewGuid().ToString(),name="second.txt",bytes=4,sha256="88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589"}
                };
                fake.Reply=req=>{
                    if(req.Method==HttpMethod.Get && Native.CopiesAttachments(batchAction) && batchRequests==1) {
                        if(!req.RequestUri.AbsolutePath.EndsWith("/"+form.taskId+"/folder-attachment") || !req.RequestUri.Query.Contains("attemptId="+batchAttempt) ||
                            !req.RequestUri.Query.Contains("authorizationId="+form.authorizationId) || req.Headers.Authorization.Parameter!=form.token)
                            throw new Exception("Attachment download was not bound to task, device and attempt");
                        if(plural && !req.RequestUri.Query.Contains("fileId="+fixtures[downloads].id))throw new Exception("Wrong file in attachment set");
                        if(!plural && req.RequestUri.Query.Contains("fileId="))throw new Exception("Legacy attachment was requested with fileId");
                        return new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Encoding.ASCII.GetBytes(downloads++==0?"abc":"abcd"))};
                    }
                    var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));
                    batchRequests++;
                    if(!req.RequestUri.AbsolutePath.EndsWith("/folder-creation") || S(body,"attemptId")!=batchAttempt || S(body,"authorizationId")!=form.authorizationId)
                        throw new Exception("Folder batch used the wrong authorization, attempt or endpoint");
                    if(batchRequests==1 && S(body,"action")=="start")
                        return TestResponse(200,form.json.Serialize(new{data=new{id=form.taskId,status="RUNNING",nativeAction=batchAction,folderCreationAttemptId=batchAttempt,folderSteps=Native.FolderSteps(batchAction),folderCreation=new{parentName="test",folderNames=new[]{"A","B"}},folderAttachment=fixtures[0],folderAttachments=fixtures}}));
                    if(batchRequests==2 && S(body,"action")=="complete" && S(body,"verifiedCount")=="2" &&
                        (plural?((object[])body["sha256s"]).Cast<string>().SequenceEqual(fixtures.Select(f=>f.sha256)):!body.ContainsKey("sha256s")) &&
                        (batchAction==Native.CopyAttachment?S(body,"sha256")==fixtures[0].sha256:!body.ContainsKey("sha256")))
                        return TestResponse(200,"{\"data\":{\"status\":\"DONE\"}}");
                    throw new Exception("Unexpected folder batch request");
                };
                form.executeFolderBatch=async(plan,checkpoint,action)=>{
                    if(action!=batchAction)throw new Exception("Wrong folder operation");
                    batchExecutions++;
                    form.ManualInput(Native.MouseInputReason(0x0201,0));
                    form.ManualInput(Native.KeyInputReason(0x0100,0));
                    await checkpoint();
                    if(form.manualPausePending || S(plan,"parentName")!="test")throw new Exception("Background batch lost its plan or paused on foreground input");
                    return 2;
                };
                form.executeFileScript=(plan,steps,checkpoint,stop,sources)=>{
                    if(!steps.SequenceEqual(Native.FolderSteps(batchAction)) || (sources!=null)!=Native.CopiesAttachments(batchAction) ||
                        (sources!=null && (sources.Length!=(plural?2:1) || Encoding.ASCII.GetString(sources[0].Content)!="abc" ||
                            (plural && Encoding.ASCII.GetString(sources[1].Content)!="abcd"))))throw new Exception("Unexpected executable batch or attachment");
                    return form.executeFolderBatch(plan,checkpoint,batchAction);
                };
                form.StartTask(true).GetAwaiter().GetResult();
                if(batchExecutions!=1 || batchRequests!=2 || form.state!="DONE" || form.armed)throw new Exception("Background folder batch used foreground input or completed without verification");
                }
                newTask();int calls=0;string firstTask=form.taskId,firstToken=form.token;
                var queued=new List<Action>();form.manualPauseDispatch=queued.Add;form.allowing=true;form.executingKind="type";
                form.ManualInput(Native.KeyInputReason(0x0100,0));
                long pauseVersion=form.manualPauseVersion;
                form.ManualInput(Native.MouseInputReason(0x0201,0));
                if(queued.Count!=1||form.armed||!form.manualPauseNote.Contains("文字输入已暂停"))throw new Exception("Manual takeover was not deduplicated or type reason missing");
                fake.Reply=req=>{calls++;if(!req.RequestUri.AbsolutePath.EndsWith("/"+firstTask+"/control"))throw new Exception("Pause targeted another task");return TestResponse(200,"{\"data\":{\"status\":\"PAUSED\",\"stage\":\"manual key\"}}");};
                form.ReportManualPause(firstTask,firstToken,pauseVersion,form.manualPauseNote).GetAwaiter().GetResult();
                if(calls!=1||form.state!="PAUSED"||form.manualPausePending)throw new Exception("Manual pause was not reported once");
                form.taskId=Guid.NewGuid().ToString();
                form.ReportManualPause(firstTask,firstToken,pauseVersion,"old task").GetAwaiter().GetResult();
                form.ReportManualPause(form.taskId,new string('b',64),form.epoch,"old token").GetAwaiter().GetResult();
                form.ReportManualPause(form.taskId,form.token,form.epoch-1,"old epoch").GetAwaiter().GetResult();
                if(calls!=1)throw new Exception("Stale pause reached the API");
                newTask();form.allowing=true;form.executingKind="";form.ManualInput(Native.MouseInputReason(0x020A,0));
                pauseVersion=form.manualPauseVersion;firstTask=form.taskId;firstToken=form.token;
                fake.Reply=req=>{form.LocalPause();throw new HttpRequestException("pause network failure");};
                try{form.ReportManualPause(firstTask,firstToken,pauseVersion,form.manualPauseNote).GetAwaiter().GetResult();}catch(HttpRequestException){}
                if(form.manualPausePending)throw new Exception("Failed pause retained a pending flag after epoch changed");
                newTask();form.armed=true;form.working=true;form.observingForeground=true;
                form.selected=new WindowChoice();form.activeAuthorizationId=form.authorizationId;
                int previousPauseCount=queued.Count;long activeEpoch=form.epoch;
                form.ManualInput(Native.KeyInputReason(0x0100,0));
                var inputAt=form.foregroundInputAt;
                if(inputAt==DateTime.MinValue || !form.armed || form.epoch!=activeEpoch || queued.Count!=previousPauseCount ||
                   !WaitingForWindow(true,inputAt,inputAt.AddSeconds(1)) || !WaitingForWindow(false,inputAt,inputAt.AddMinutes(1)) ||
                   WaitingForWindow(true,inputAt,inputAt.AddSeconds(4)))throw new Exception("User input during observation must yield until the original window is idle");
                form.LocalPause();form.selected=null;form.activeAuthorizationId="";
                if(form.foregroundInputAt!=DateTime.MinValue || form.CanYieldForeground)throw new Exception("Explicit pause retained an automatic continuation");
                newTask();int starts=0;form.startWindowOverride=()=>{starts++;return null;};calls=0;
                fake.Reply=req=>{calls++;var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));if(S(body,"action")!="handoff"||!body.ContainsKey("startupFailure")||!Convert.ToBoolean(body["startupFailure"]))throw new Exception("Startup failure was not marked");return TestResponse(200,"{\"data\":{\"status\":\"NEEDS_USER\",\"stage\":\"Open an application then continue\"}}");};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=1||starts!=1||form.state!="NEEDS_USER"||form.armed)throw new Exception("Pre-allow failure remained waiting");
                newTask();calls=0;form.startWindowOverride=()=>{form.LocalPause();form.state="PAUSED";return null;};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=0||form.state!="PAUSED")throw new Exception("Canceled startup overwrote a user pause");
                newTask();string newerTask=Guid.NewGuid().ToString();form.startWindowOverride=()=>{form.taskId=newerTask;return null;};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=0||form.taskId!=newerTask)throw new Exception("Old startup reported against a new task");
                foreach(bool locateOnly in new[]{true,false}) {
                    newTask();form.task["startLocation"]="wecom";var actions=new List<string>();
                    var target=new WindowChoice{Title="Private chat title",App="WXWork"};
                    form.wecomOverride=(check,beforeLaunch)=>{
                        check();actions.Add("foreground");beforeLaunch();return Task.FromResult(target);
                    };
                    fake.Reply=req=>{
                        var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));
                        string action=S(body,"action");actions.Add(action);
                        if(action=="ready_wecom" && (S(body,"windowId")!=target.Id || S(body,"application")!="WXWork" || S(body,"window")!="企业微信"))
                            throw new Exception("WeCom readiness must identify the window without a contact or chat title");
                        return TestResponse(200,"{\"data\":{\"status\":\""+(action=="ready_wecom" && locateOnly?"DONE":"RUNNING")+"\"}}");
                    };
                    form.StartTask(true).GetAwaiter().GetResult();
                    if(!actions.SequenceEqual(new[]{"start_wecom","foreground","ready_wecom"}) || form.armed==locateOnly ||
                        (!locateOnly && (form.wecomTaskId!=form.taskId || form.selected!=target)))
                        throw new Exception("WeCom startup must claim once, bind a verified target, and skip capture for locating only");
                }
                newTask();form.task["startLocation"]="wecom";form.authorizationId="";
                form.wecomOverride=(check,beforeLaunch)=>{throw new Exception("WeCom started without a remembered grant");};
                fake.Reply=req=>{
                    var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));
                    if(S(body,"action")!="handoff" || S(body,"note").Contains("without a remembered grant"))throw new Exception("Invalid unauthorised WeCom action");
                    return TestResponse(200,"{\"data\":{\"status\":\"NEEDS_USER\"}}");
                };
                form.StartTask(true).GetAwaiter().GetResult();
                form.wecomOverride=null;
                foreach(string nativeAction in new[]{"focus_notepad","open_notepad"}) {
                    newTask();form.task["nativeAction"]=nativeAction;
                    var events=new List<string>();string attempt=null;
                    var target=new WindowChoice{Title="Notepad test",App="notepad"};
                    form.notepadOverride=(operation,check)=>{
                        check();if(operation!=nativeAction)throw new Exception("Focus changed to launch");
                        events.Add("verified_foreground");return Task.FromResult(target);
                    };
                    fake.Reply=req=>{
                        var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));
                        string action=S(body,"action");events.Add(action);
                        if(!req.RequestUri.AbsolutePath.EndsWith("/tasks/"+form.taskId+"/control")||S(body,"authorizationId")!=form.authorizationId)throw new Exception("Native operation left the authorized device task");
                        if(action=="start_native") { attempt=S(body,"attemptId");Guid parsed;if(!Guid.TryParse(attempt,out parsed))throw new Exception("Missing native claim ID"); }
                        else if(action!="complete_native"||S(body,"attemptId")!=attempt||S(body,"windowId")!=target.Id||S(body,"application")!="notepad")throw new Exception("No confirmed notepad");
                        return TestResponse(200,form.json.Serialize(new{data=new{id=form.taskId,nativeAction,status=action=="start_native"?"RUNNING":"DONE"}}));
                    };
                    form.StartTask(true).GetAwaiter().GetResult();
                    if(form.state!="DONE"||form.armed||!events.SequenceEqual(new[]{"start_native","verified_foreground","complete_native"}))throw new Exception("Notepad task bypassed claim, verification or completion");
                }
                newTask();form.task["nativeAction"]="type_notepad";form.task["previousTaskId"]=Guid.NewGuid().ToString();calls=0;starts=0;
                form.notepadOverride=(operation,check)=>{starts++;return Task.FromResult(new WindowChoice());};
                fake.Reply=req=>{
                    calls++;var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));
                    if(calls==1 && S(body,"action")=="start_native")return TestResponse(200,form.json.Serialize(new{data=new{status="RUNNING",previousTaskId="previous",nativeAction="type_notepad",boundWindowId="source",nativeText="9999999"}}));
                    if(calls!=2 || S(body,"action")!="handoff")throw new Exception("Missing original document was not handed off");
                    return TestResponse(200,form.json.Serialize(new{data=new{status="NEEDS_USER"}}));
                };
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=2||starts!=0||form.state!="NEEDS_USER")throw new Exception("Typing selected a substitute Notepad");
                newTask();form.task["nativeAction"]="focus_notepad";calls=0;
                form.notepadOverride=(operation,check)=>{throw new Exception("No eligible Notepad");};
                fake.Reply=req=>{
                    var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));calls++;
                    if(calls==2 && (S(body,"action")!="handoff"||S(body,"attemptId")!=form.nativeAttemptId||S(body,"note")!="No eligible Notepad"))throw new Exception("Missing native handoff");
                    return TestResponse(200,form.json.Serialize(new{data=new{status=calls==1?"RUNNING":"NEEDS_USER"}}));
                };
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=2||form.state!="NEEDS_USER")throw new Exception("Missing Notepad reported success");
                newTask();form.task["nativeAction"]="open_notepad";calls=0;
                form.notepadOverride=(operation,check)=>{form.LocalPause();check();throw new Exception("Native action continued after takeover");};
                fake.Reply=req=>{calls++;return TestResponse(200,"{\"data\":{\"status\":\"RUNNING\"}}");};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=1||form.armed)throw new Exception("Interrupted native operation posted completion");
                newTask();form.task["nativeAction"]="open_notepad";form.authorizationId="";calls=0;starts=0;
                form.notepadOverride=(operation,check)=>{starts++;return Task.FromResult(new WindowChoice());};
                fake.Reply=req=>{calls++;var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));if(S(body,"action")!="handoff"||body.ContainsKey("attemptId"))throw new Exception("Unapproved Notepad claim attempted");return TestResponse(200,"{\"data\":{\"status\":\"NEEDS_USER\"}}");};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=1||starts!=0)throw new Exception("Unapproved native execution");
                newTask();form.task["nativeAction"]="focus_notepad";form.state="NEEDS_USER";calls=0;
                fake.Reply=req=>{calls++;var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));if(S(body,"action")!="resume")throw new Exception("A resumed task must be polled before claiming");return TestResponse(200,"{\"data\":{\"status\":\"WAITING\",\"nativeAction\":\"focus_notepad\"}}");};
                form.StartTask(true).GetAwaiter().GetResult();
                if(calls!=1||form.state!="WAITING"||form.autoAttemptedId.Length!=0)throw new Exception("Resume failed to wait for delivery");
                newTask();starts=0;int reports=0;form.startWindowOverride=()=>{starts++;return null;};
                fake.Reply=req=>{reports++;throw new HttpRequestException("failure report offline");};
                try{form.StartTask(true).GetAwaiter().GetResult();}catch(HttpRequestException){}
                if(form.startFailureNote.Length==0||form.armed)throw new Exception("Unreported startup failure was lost");
                fake.Reply=req=>{if(req.RequestUri.AbsolutePath.EndsWith("/poll"))return TestResponse(200,form.json.Serialize(new{data=new{authorizationId=form.authorizationId,task=new{id=form.taskId,status="WAITING",stage="Waiting"}}}));reports++;return TestResponse(200,"{\"data\":{\"status\":\"NEEDS_USER\",\"stage\":\"Open an application then continue\"}}");};
                form.Poll().GetAwaiter().GetResult();
                if(starts!=1||reports!=2||form.state!="NEEDS_USER")throw new Exception("Recovery retried input or left startup waiting");
                string diagnosticId=Guid.NewGuid().ToString(),secret="isolated-secret-must-not-appear";
                var providerError=ApiFailure.FromResponse(502,"DESKTOP_AI_ERROR",diagnosticId,"智能服务暂不可用（HTTP 403），任务已暂停");
                if(providerError.Status!=502||providerError.Code!="DESKTOP_AI_ERROR"||providerError.RequestId!=diagnosticId||!providerError.Message.Contains("供应商 HTTP 403"))throw new Exception("Structured provider diagnosis was lost");
                foreach(string untrusted in new[]{"UNKNOWN_"+secret,"MODEL_UNAVAILABLE","DESKTOP_PROVIDER_PERMISSION"}) {
                    var safe=ApiFailure.FromResponse(403,untrusted,secret,secret);
                    if(safe.Message.Contains(secret)||safe.RequestId.Length>0)throw new Exception("Untrusted response text leaked into diagnosis");
                }
                seed();fake.Reply=req=>TestResponse(502,form.json.Serialize(new{error=new{code="DESKTOP_AI_ERROR",message="智能服务暂不可用（HTTP 403），任务已暂停"},requestId=diagnosticId}));
                bool structured=false;try{form.Request("poll",new{}).GetAwaiter().GetResult();}catch(ApiFailure e){structured=e.Status==502&&e.Code=="DESKTOP_AI_ERROR"&&e.RequestId==diagnosticId;}
                if(!structured)throw new Exception("HTTP response error structure was discarded");
                fake.Reply=req=>{var response=TestResponse(503,"<html>"+secret+"</html>");response.Headers.Add("X-Request-Id",diagnosticId);return response;};
                bool malformed=false;try{form.Request("poll",new{}).GetAwaiter().GetResult();}catch(ApiFailure e){malformed=e.Status==503&&e.Code=="INVALID_RESPONSE"&&e.RequestId==diagnosticId&&!e.Message.Contains(secret);}
                if(!malformed)throw new Exception("Malformed response lost safe HTTP diagnosis");
                newTask();firstTask=form.taskId;firstToken=form.token;long failureVersion=form.epoch;calls=0;
                fake.Reply=req=>{calls++;var body=D(form.json.DeserializeObject(req.Content.ReadAsStringAsync().GetAwaiter().GetResult()));if(S(body,"action")!="handoff"||!body.ContainsKey("startupFailure")||!Convert.ToBoolean(body["startupFailure"])||!S(body,"note").Contains(diagnosticId))throw new Exception("Failure handoff lacked guarded diagnosis");return TestResponse(200,form.json.Serialize(new{data=new{id=firstTask,status="PAUSED",stage="智能服务暂不可用（HTTP 403），任务已暂停"}}));};
                form.ReportStepFailure(firstTask,firstToken,failureVersion,"",providerError).GetAwaiter().GetResult();
                if(calls!=1||form.state!="PAUSED"||!form.status.Text.Contains("HTTP 403")||!form.status.Text.Contains(diagnosticId)||!form.status.Text.StartsWith("任务已暂停："))throw new Exception("Server pause or task diagnosis was overwritten");
                fake.Reply=req=>TestResponse(200,form.json.Serialize(new{data=new{authorizationId=form.authorizationId,task=new{id=firstTask,status="PAUSED",stage="智能服务暂不可用（HTTP 403），任务已暂停"}}}));
                form.Poll().GetAwaiter().GetResult();
                if(!form.status.Text.Contains(diagnosticId)||form.status.Text.Contains("连接或智能服务异常"))throw new Exception("Polling erased the same-task diagnosis");
                form.taskId=Guid.NewGuid().ToString();
                form.ReportStepFailure(firstTask,firstToken,failureVersion,"",providerError).GetAwaiter().GetResult();
                if(calls!=1)throw new Exception("Old failure reached a newer task");
                newTask();firstTask=form.taskId;firstToken=form.token;failureVersion=form.epoch;
                fake.Reply=req=>{form.taskId=Guid.NewGuid().ToString();form.state="WAITING";return TestResponse(200,"{\"data\":{\"status\":\"PAUSED\",\"stage\":\"old failure\"}}");};
                form.ReportStepFailure(firstTask,firstToken,failureVersion,"",providerError).GetAwaiter().GetResult();
                if(form.state!="WAITING")throw new Exception("Late failure overwrote the new task");
                newTask();firstTask=form.taskId;firstToken=form.token;failureVersion=form.epoch;
                fake.Reply=req=>TestResponse(200,"{\"data\":{\"status\":\"CANCELED\",\"stage\":\"你已停止操作\"}}");
                form.ReportStepFailure(firstTask,firstToken,failureVersion,"",providerError).GetAwaiter().GetResult();
                if(form.state!="CANCELED"||form.status.Text!="你已停止操作")throw new Exception("Failure revived a stopped task");
            }
            Console.WriteLine("Desktop connection, startup and safe diagnosis validation: passed (fake HTTP, isolated credentials, no desktop input)");return 0;
        } catch(Exception ex){Console.WriteLine(ex.Message);return 1;}
        finally {
            foreach(string name in new[]{"connection.bin","connection.bin.tmp","commands.bin","commands.bin.tmp"}){string file=Path.Combine(isolated,name);if(File.Exists(file))File.Delete(file);}
            if(Directory.Exists(isolated))Directory.Delete(isolated);
        }
    }
    sealed class PreviewHost : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    public static int Preview(string output) {
        try {
            Directory.CreateDirectory(output);
            Action<Form,string> draw=(control,name)=>{
                using(var host=new PreviewHost { ShowInTaskbar=false, FormBorderStyle=FormBorderStyle.None, StartPosition=FormStartPosition.Manual, Location=new Point(-32000,-32000), Size=control.Size, Opacity=0 }) {
                    control.TopLevel=false;control.Location=Point.Empty;host.Controls.Add(control);control.Show();host.Show();Application.DoEvents();control.PerformLayout();
                    using(var bitmap=new Bitmap(control.Width,control.Height)){control.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(output,name),ImageFormat.Png);}
                    host.Hide();host.Controls.Remove(control);
                }
            };
            var fake=new FakeHandler { Reply=req=>{throw new Exception("Preview must not access the network");} };
            using(var form=new AssistantForm(fake,Path.Combine(output,"unused-test-profile"))) {
                form.token="";form.ShowConnection();draw(form,"desktop-main.png");
                form.advancedPanel.Visible=true;foreach(Control child in form.Controls[0].Controls)if(child is Button && child.Text=="高级设置 ▸")child.Text="收起高级设置 ▾";form.Height=850;draw(form,"desktop-advanced.png");
                form.authorizationId=Guid.NewGuid().ToString();form.token=new string('a',64);form.owner="隔离预览";form.task=new Dictionary<string,object>();form.state="PAUSED";form.status.Text="任务已暂停，核对窗口后可直接继续。";form.advancedPanel.Visible=false;foreach(Control child in form.Controls[0].Controls)if(child is Button && child.Text=="收起高级设置 ▾")child.Text="高级设置 ▸";form.Height=590;form.ShowConnection();draw(form,"desktop-paused.png");
            }
            using(var dialog=AuthorizationDialog("Ctrl+Alt+X")) draw(dialog,"desktop-consent.png");
            Console.WriteLine("Desktop isolated UI previews saved; no engine or connection loaded.");return 0;
        } catch(Exception ex){Console.WriteLine(ex.Message);return 1;}
    }
    public static Dictionary<string,object> D(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    public static string S(Dictionary<string,object> value, string key) { object v; return value.TryGetValue(key,out v) ? Convert.ToString(v) : ""; }
}

static partial class Native {
    // Only dedicated, unprivileged browser windows can be selected from this process.
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<IntPtr,byte> BrowserWindows = new System.Collections.Concurrent.ConcurrentDictionary<IntPtr,byte>();
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<IntPtr,BrowserWindow> LocalBrowserWindows = new System.Collections.Concurrent.ConcurrentDictionary<IntPtr,BrowserWindow>();
    public static BrowserWindow LocalBrowser(WindowChoice window) {
        BrowserWindow browser;
        if(window==null||!LocalBrowserWindows.TryGetValue(window.Handle,out browser))
            throw new Exception("请先从工作台右侧打开小序本地浏览器，再继续此任务。");
        return browser;
    }
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
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetProp(IntPtr h,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr h,string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr h,string name);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
        public int size,flags;
        public IntPtr active,focus,capture,menu,move,caret;
        public RECT caretRect;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo information);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr EditorQuery(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode)] static extern IntPtr EditorRead(IntPtr h,uint msg,IntPtr w,StringBuilder text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode)] static extern IntPtr EditorInsert(IntPtr h,uint msg,IntPtr w,string text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int max);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int max);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int bytes,out int needed);
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
    static readonly HashSet<string> BlockedApps = new HashSet<string>(new[]{"cmd","powershell","pwsh","windowsterminal","conhost","openconsole","wsl","bash","mintty","regedit","mmc","taskmgr","credentialuibroker","consent","msiexec","mstsc","putty","keepass","keepassxc","1password","bitwarden","systemsettings","textinputhost","inputapp","tabtip","codex","codex-computer-use","chatgpt"},StringComparer.OrdinalIgnoreCase);
    static readonly Regex Sensitive = new Regex("密码|验证码|密钥|授权码|付款|支付|删除|发送|转账|下单|安装|登录|password|passcode|api.?key|secret|credential|sign.?in|log.?in|payment|purchase|delete|send|checkout|install",RegexOptions.IgnoreCase);
    static string Title(IntPtr h) { var b=new StringBuilder(1024); GetWindowText(h,b,b.Capacity); return b.ToString(); }
    static string Cut(string s,int n) { return s.Length>n?s.Substring(0,n):s; }
    static bool IsSystemNotepad(string path) {
        if(String.IsNullOrEmpty(path))return false;
        string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if(new[]{Path.Combine(Environment.SystemDirectory,"notepad.exe"),Path.Combine(windows,"notepad.exe"),Path.Combine(windows,"SysWOW64","notepad.exe")}.Contains(path,StringComparer.OrdinalIgnoreCase)) return true;
        string packages=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"WindowsApps")+Path.DirectorySeparatorChar;
        return path.StartsWith(packages,StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(path.Substring(packages.Length),@"^Microsoft\.WindowsNotepad_[0-9.]+_(?:x64|x86|arm64|neutral)__8wekyb3d8bbwe\\(?:Notepad\\)?Notepad\.exe$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);
    }
    static bool IsNotepadWindow(IntPtr h,Process process) {
        if(!String.Equals(process.ProcessName,"notepad",StringComparison.OrdinalIgnoreCase))return false;
        var name=new StringBuilder(128);
        return GetClassName(h,name,name.Capacity)>0 && String.Equals(name.ToString(),"Notepad",StringComparison.OrdinalIgnoreCase)
            && IsSystemNotepad(process.MainModule.FileName);
    }
    public static IEnumerable<WindowChoice> Windows(IntPtr own,bool notepadOnly=false) {
        var result=new List<WindowChoice>();
        EnumWindows((h,p)=>{
            try { bool minimized=IsIconic(h);if(h==own||!IsWindowVisible(h)||(!notepadOnly&&minimized))return true;
                string title=Title(h); if(String.IsNullOrWhiteSpace(title))return true;
                RECT rect; if(!minimized&&(!GetWindowRect(h,out rect)||rect.Right-rect.Left<100||rect.Bottom-rect.Top<100))return true;
                uint pid; GetWindowThreadProcessId(h,out pid); using(var process=Process.GetProcessById((int)pid)) {
                if(notepadOnly && !IsNotepadWindow(h,process))return true;
                if(BlockedApps.Contains(process.ProcessName)||(pid==Process.GetCurrentProcess().Id&&!BrowserWindows.ContainsKey(h)))return true;
                var choice=new WindowChoice{Handle=h,Title=Cut(title,200).Trim(),App=Cut(process.ProcessName,80).Trim(),Pid=(int)pid,Started=process.StartTime.ToUniversalTime().Ticks};
                ValidateWindow(choice,false,notepadOnly); result.Add(choice); }
            } catch { } return true;
        },IntPtr.Zero);
        return result;
    }
    public static void RefreshTitle(WindowChoice w) { w.Title=Cut(Title(w.Handle),200).Trim(); }
    public static bool IsForeground(WindowChoice w) { return GetForegroundWindow()==w.Handle; }

    // Windows destroys per-window properties with their HWND. A restarted process
    // or a new window reusing the same handle cannot inherit this in-memory receipt.
    public sealed class WindowContinuation : IDisposable {
        readonly string source,grant,marker="Xuti.Window."+Guid.NewGuid().ToString("N");
        readonly DateTime expires=DateTime.UtcNow.AddMinutes(10);
        readonly BrowserWindow browser;
        readonly long revision;
        readonly string documentTitle;
        IntPtr editor;
        byte[] documentDigest;
        int[] tabId;
        public readonly WindowChoice Window;
        WindowContinuation(string id,string authorization,WindowChoice window,bool localBrowser) {
            source=id;grant=authorization;Window=window;
            if(localBrowser){browser=LocalBrowser(window);browser.ValidateLocalPage();revision=browser.PageRevision;}
            documentTitle=Title(window.Handle).TrimStart('*');
        }
        static Exception Changed() { return new Exception("原窗口或文档已变化，请重新指定要操作的窗口或网页。"); }
        public bool Matches(string id,string windowId,string authorization,bool localBrowser) {
            return source==id && Window.Id==windowId && grant==authorization && grant.Length>0 &&
                localBrowser==(browser!=null) && DateTime.UtcNow<=expires;
        }
        public string RetainedTaskId(string authorization) {
            if(!Matches(source,Window.Id,authorization,browser!=null))return null;
            try {
                Validate();
                if(editor!=IntPtr.Zero)CheckOriginalText(ReadEditor());
                return source;
            } catch { return null; }
        }
        public static WindowContinuation Capture(string id,string authorization,WindowChoice window,bool localBrowser) {
            WindowContinuation binding=null;
            try {
                ValidateWindow(window,true);
                binding=new WindowContinuation(id,authorization,window,localBrowser);
                if(!SetProp(window.Handle,binding.marker,new IntPtr(1)))throw Changed();
                if(String.Equals(window.App,"notepad",StringComparison.OrdinalIgnoreCase)) {
                    using(var process=Process.GetProcessById(window.Pid))
                        if(!IsNotepadWindow(window.Handle,process))throw Changed();
                    var candidates=new List<IntPtr>();
                    EnumChildWindows(window.Handle,(h,p)=>{
                        var name=new StringBuilder(128);
                        if(IsWindowVisible(h) && GetClassName(h,name,name.Capacity)>0 &&
                            Regex.IsMatch(name.ToString(),@"^(?:Edit|RichEditD2DPT)$",RegexOptions.IgnoreCase))
                            candidates.Add(h);
                        return true;
                    },IntPtr.Zero);
                    if(candidates.Count!=1)throw Changed();
                    binding.editor=candidates[0];
                    if(!SetProp(binding.editor,binding.marker,new IntPtr(1)))throw Changed();
                    binding.tabId=binding.SelectedTab();
                    using(var sha=SHA256.Create())
                        binding.documentDigest=sha.ComputeHash(Encoding.Unicode.GetBytes(binding.ReadEditor()));
                }
                return binding;
            } catch { if(binding!=null)binding.Dispose();return null; }
        }
        public void Dispose() {
            if(GetProp(Window.Handle,marker)==new IntPtr(1))RemoveProp(Window.Handle,marker);
            if(editor!=IntPtr.Zero && GetProp(editor,marker)==new IntPtr(1))RemoveProp(editor,marker);
        }
        int[] SelectedTab() {
            var tabs=AutomationElement.FromHandle(Window.Handle).FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.TabItem));
            if(tabs.Count==0)return new int[0]; // Classic single-document Notepad.
            var selected=tabs.Cast<AutomationElement>().Where(t=>Object.Equals(t.GetCurrentPropertyValue(SelectionItemPattern.IsSelectedProperty),true)).ToArray();
            if(selected.Length!=1)throw Changed();
            return selected[0].GetRuntimeId();
        }
        public void Validate() {
            ValidateWindow(Window,false);
            if(GetProp(Window.Handle,marker)!=new IntPtr(1))throw Changed();
            if(browser!=null && browser.PageRevision!=revision)throw Changed();
            if(editor!=IntPtr.Zero && (GetProp(editor,marker)!=new IntPtr(1) || GetAncestor(editor,2)!=Window.Handle ||
                !IsWindowVisible(editor) || Title(Window.Handle).TrimStart('*')!=documentTitle || !tabId.SequenceEqual(SelectedTab())))
                throw Changed();
        }
        int Query(uint message) {
            IntPtr value;
            if(EditorQuery(editor,message,IntPtr.Zero,IntPtr.Zero,3,500,out value)==IntPtr.Zero)throw Changed();
            return unchecked((int)value.ToInt64());
        }
        string ReadEditor() {
            int size=Query(0x000E); // WM_GETTEXTLENGTH
            if(size<0 || size>32000)throw new Exception("原文过长，请在记事本中亲自核对。");
            var buffer=new StringBuilder(size+1);IntPtr read;
            if(EditorRead(editor,0x000D,new IntPtr(buffer.Capacity),buffer,3,500,out read)==IntPtr.Zero || read.ToInt32()!=size)
                throw Changed();
            return buffer.ToString();
        }
        void CheckOriginalText(string original) {
            using(var sha=SHA256.Create())
                if(!documentDigest.SequenceEqual(sha.ComputeHash(Encoding.Unicode.GetBytes(original))))throw Changed();
        }
        void InsertAndVerify(string text,string expected) {
            IntPtr result;
            if(EditorInsert(editor,0x00C2,new IntPtr(1),text,3,800,out result)==IntPtr.Zero || ReadEditor()!=expected)
                throw new Exception("输入结果尚未核验，请检查原文后再下达指令。");
        }
        public void InsertNotepadText(string text,Action beforeInput) {
            if(editor==IntPtr.Zero || text.Length<1 || text.Length>500 || Regex.IsMatch(text,@"[\p{Cc}\p{Cf}]"))throw Changed();
            ValidateAction(new Dictionary<string,object>{{"kind","type"},{"text",text}});
            Validate();ValidateWindow(Window,true);CheckInputDesktop();
            var info=new GuiThreadInfo{size=Marshal.SizeOf(typeof(GuiThreadInfo))};uint pid;
            uint thread=GetWindowThreadProcessId(Window.Handle,out pid);
            if(!GetGUIThreadInfo(thread,ref info)||info.focus!=editor)throw new Exception("请先核对原记事本的正文编辑区，再重新下达指令。");
            GuardElement(AutomationElement.FromHandle(editor));
            string original=ReadEditor();
            CheckOriginalText(original);
            int selection=Query(0x00B0); // EM_GETSEL, indices fit the bounded text.
            int caret=selection&0xffff,end=(int)((uint)selection>>16);
            if(caret!=end || caret>original.Length || original.Length+text.Length>32000)
                throw new Exception("请在原文中放置插入光标，缩短过长文档后重新下达指令。");
            string expected=original.Insert(caret,text);
            beforeInput();Validate();ValidateWindow(Window,true);
            if(Query(0x00B0)!=selection || !GetGUIThreadInfo(thread,ref info) || info.focus!=editor)throw Changed();
            // EM_REPLACESEL targets the tagged editor directly, even if another app gains focus.
            InsertAndVerify(text,expected);
            RefreshTitle(Window);
        }
        public static void EditorSelfTest() {
            // Only the hidden fixture's own edit control receives a window message.
            using(var form=new Form())
            using(var original=new TextBox())
            using(var other=new TextBox()) {
                form.Controls.AddRange(new Control[]{original,other});
                var target=new WindowChoice{Handle=form.Handle};
                using(var bound=new WindowContinuation("source","grant",target,false)) {
                    bound.editor=original.Handle;other.CreateControl();
                    if(!SetProp(target.Handle,bound.marker,new IntPtr(1)) || !SetProp(bound.editor,bound.marker,new IntPtr(1)))
                        throw new Exception("Window tagging failed");
                    if(!bound.Matches("source",target.Id,"grant",false) || bound.Matches("old",target.Id,"grant",false) ||
                        bound.Matches("source",target.Id,"new-grant",false) || bound.Matches("source",target.Id,"grant",true))
                        throw new Exception("Window receipt leaked between tasks or scopes");
                    original.Text="ABC";original.Select(1,0);
                    bound.InsertAndVerify("9999999","A9999999BC");
                    if(original.Text!="A9999999BC" || other.Text.Length!=0 || GetProp(other.Handle,bound.marker)!=IntPtr.Zero)
                        throw new Exception("Input reached the wrong fixture window");
                    original.Dispose();
                    if(GetProp(bound.editor,bound.marker)!=IntPtr.Zero)throw new Exception("A destroyed editor retained its receipt");
                }
            }
        }
    }
    public static WindowChoice InitialWindow(IEnumerable<WindowChoice> candidates) {
        var list=candidates.ToList();
        return list.FirstOrDefault(w=>w.Handle==GetForegroundWindow()) ?? list.FirstOrDefault();
    }
    static void CheckInputDesktop(string taskName="记事本任务") {
        IntPtr desktop=OpenInputDesktop(0,false,1); // DESKTOP_READOBJECTS
        try {
            var name=new StringBuilder(128); int needed;
            if(desktop==IntPtr.Zero || !GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
                throw new Exception("请解锁电脑并返回普通 Windows 桌面，再继续"+taskName+"。");
        } finally { if(desktop!=IntPtr.Zero)CloseDesktop(desktop); }
    }
    public static async Task<WindowChoice> FocusNotepad(IntPtr own,bool open,Action check,Action beforeLaunch) {
        check();CheckInputDesktop();
        Func<WindowChoice> find=()=>InitialWindow(Windows(own,true).OrderBy(w=>IsIconic(w.Handle)));
        var target=find();
        if(target==null) {
            if(!open)throw new Exception("没有找到已打开的系统记事本。请先打开记事本，再继续此任务。");
            check();beforeLaunch();
            // No user-supplied executable, arguments, file, or shell association.
            using(Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"notepad.exe")){UseShellExecute=false})) {}
            for(int i=0;i<40 && target==null;i++) {
                await Task.Delay(200);check();CheckInputDesktop();target=find();
            }
            if(target==null)throw new Exception("已请求启动记事本，尚未找到可操作窗口。请查看记事本后继续。");
        }
        check();ValidateWindow(target,false,true);
        if(IsIconic(target.Handle)) {
            ShowWindowAsync(target.Handle,9); // SW_RESTORE
            for(int i=0;i<10 && IsIconic(target.Handle);i++) { await Task.Delay(100);check(); }
        }
        check();CheckInputDesktop();ValidateWindow(target,false);
        if(GetForegroundWindow()!=target.Handle)SetForegroundWindow(target.Handle);
        for(int i=0;i<10 && GetForegroundWindow()!=target.Handle;i++) {
            await Task.Delay(100);check();
        }
        check();CheckInputDesktop();
        if(GetForegroundWindow()!=target.Handle)throw new Exception("Windows 未将记事本切换到前台。请点击任务栏中的记事本，再继续当前任务。");
        ValidateWindow(target,true);RefreshTitle(target);
        return target;
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
    public static void ValidateWindow(WindowChoice w,bool foreground,bool allowMinimized=false) {
        if(w==null||!IsWindow(w.Handle)||!IsWindowVisible(w.Handle)||(!allowMinimized && IsIconic(w.Handle)))throw new Exception("窗口已关闭或最小化，请重新选择");
        uint pid; GetWindowThreadProcessId(w.Handle,out pid); var process=Process.GetProcessById((int)pid);
        if(pid!=w.Pid||process.StartTime.ToUniversalTime().Ticks!=w.Started||BlockedApps.Contains(process.ProcessName))throw new Exception("窗口应用已变化，请重新选择");
        if(pid==Process.GetCurrentProcess().Id&&!BrowserWindows.ContainsKey(w.Handle))throw new Exception("不能操作小序自身的控制界面");
        if(foreground&&GetForegroundWindow()!=w.Handle)throw new Exception("当前窗口已切换，请核对后继续");
        if(Regex.IsMatch(Title(w.Handle),"Windows PowerShell|命令提示符|终端|管理员:|API.?Keys|密码管理",RegexOptions.IgnoreCase))throw new Exception("此窗口需要你亲自操作");
    }
    static string Controls(WindowChoice w,Rectangle? contentBounds,bool details=true) {
        var root=AutomationElement.FromHandle(w.Handle); var walker=TreeWalker.ControlViewWalker;
        if(root==null)throw new InputNotSent("窗口的辅助功能控件未就绪，请核对后继续。");
        var queue=new Queue<AutomationElement>(); queue.Enqueue(root); var text=new StringBuilder(); int count=0;
        while(queue.Count>0&&count++<120) {
            var element=queue.Dequeue();
            if(element.Current.IsPassword)throw new Exception("窗口包含密码输入，请自行处理后再继续");
            if(details && !element.Current.IsOffscreen) {
                var bounds=element.Current.BoundingRectangle;
                bool inContent=!contentBounds.HasValue||(!bounds.IsEmpty&&
                    bounds.Left>=contentBounds.Value.Left&&bounds.Top>=contentBounds.Value.Top&&
                    bounds.Right<=contentBounds.Value.Right&&bounds.Bottom<=contentBounds.Value.Bottom);
                var type=element.Current.ControlType;
                if(inContent)text.AppendLine(Cut((type==null?"Control":type.ProgrammaticName)+": "+element.Current.Name,180));
            }
            var child=walker.GetFirstChild(element); int sibling=0;
            while(child!=null&&sibling++<30&&queue.Count<140){queue.Enqueue(child);child=walker.GetNextSibling(child);}
        }
        return Cut(text.ToString(),12000);
    }
    public sealed class InputNotSent : Exception {
        public InputNotSent(string reason):base(reason) {}
    }
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread,EnumProc callback,IntPtr data);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [StructLayout(LayoutKind.Sequential)] struct MenuItemInfo {
        public uint size,mask,type,state,id; public IntPtr submenu,checkedImage,uncheckedImage,data,typeData; public uint chars;public IntPtr bitmap;
    }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMenuItemInfo(IntPtr menu,uint index,bool byPosition,ref MenuItemInfo item);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu,uint position,StringBuilder text,int capacity,uint flags);
    [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr owner,IntPtr menu,uint item,out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint relation);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [StructLayout(LayoutKind.Sequential)] struct MenuBarInfo {
        public int size; public RECT bounds; public IntPtr menu,submenuWindow; public uint focusFlags;
    }
    [DllImport("user32.dll")] static extern bool GetMenuBarInfo(IntPtr window,int objectId,int item,ref MenuBarInfo info);
    sealed class PhysicalCoordinates : IDisposable {
        readonly IntPtr previous;
        public PhysicalCoordinates() {
            try { previous=SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) {}
            if(previous==IntPtr.Zero)throw new InputNotSent("无法核对弹出菜单的屏幕坐标，请亲自处理后继续。");
        }
        public void Dispose(){SetThreadDpiAwarenessContext(previous);}
    }
    static Rectangle Bounds(RECT r){return Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);}
    static GuiThreadInfo ThreadInfo(WindowChoice w,out uint thread) {
        uint pid;thread=GetWindowThreadProcessId(w.Handle,out pid);
        var info=new GuiThreadInfo{size=Marshal.SizeOf(typeof(GuiThreadInfo))};
        if(pid!=w.Pid || thread==0 || !GetGUIThreadInfo(thread,ref info))throw new InputNotSent("无法核对当前窗口的输入状态，请核对后继续。");
        return info;
    }
    static bool MenuOpen(GuiThreadInfo info){return (info.flags&0x1C)!=0;}
    static int AbsolutePixel(int point,int origin,int extent) {
        long offset=(long)point-origin;
        if(extent<=0 || offset<0 || offset>=extent)throw new InputNotSent("目标位置已离开屏幕，请核对后继续。");
        int normalized=(int)Math.Min(65535,(offset*65536+32768)/extent);
        if((long)normalized*extent/65536!=offset)throw new InputNotSent("无法精确定位目标像素，请核对屏幕后继续。");
        return normalized;
    }
    public sealed class PopupMenu {
        static readonly string markerName="Xuti.Popup."+Guid.NewGuid().ToString("N");
        static long generation;
        public IntPtr Window {get;private set;}
        public Rectangle BoundsOnScreen {get;private set;}
        IntPtr menu,menuOwner,marker;
        uint threadId;
        Item[] items;
        sealed class Item {
            public string text;public uint id,state,type;public IntPtr submenu;public Rectangle bounds;
            public bool Clickable { get {return text.Length>0 && (state&3)==0 && (type&0x904)==0 && !Sensitive.IsMatch(text.Replace("&",""));} }
            public bool Same(Item other){return id==other.id && type==other.type && state==other.state && submenu==other.submenu && text==other.text && bounds==other.bounds;}
        }
        static Item ReadItem(IntPtr menu,uint index) {
            RECT r;
            var info=new MenuItemInfo{size=(uint)Marshal.SizeOf(typeof(MenuItemInfo)),mask=0x107}; // type, state, id, submenu
            var caption=new StringBuilder(512);
            int n=GetMenuString(menu,index,caption,caption.Capacity,0x400);
            if(!GetMenuItemInfo(menu,index,true,ref info) || !GetMenuItemRect(IntPtr.Zero,menu,index,out r) || n>=caption.Capacity-1)
                throw Changed();
            return new Item{text=caption.ToString(),id=info.id,type=info.type,state=info.state&~0x80u,submenu=info.submenu,bounds=Bounds(r)};
        }
        static InputNotSent Changed(){return new InputNotSent("弹出菜单已变化，请核对当前菜单后继续。");}
        static bool OwnerMatches(IntPtr owner,WindowChoice w,uint thread) {
            uint pid;
            return owner!=IntPtr.Zero && GetWindowThreadProcessId(owner,out pid)==thread && pid==w.Pid &&
                (owner==w.Handle || GetAncestor(owner,2)==w.Handle);
        }
        static PopupMenu Current(WindowChoice w) {
            uint thread;var info=ThreadInfo(w,out thread);
            if(!MenuOpen(info) || !OwnerMatches(info.menu,w,thread))throw Changed();
            var found=new List<PopupMenu>();
            bool unsupported=false;
            EnumThreadWindows(thread,(h,unused)=>{
                if(!IsWindowVisible(h))return true;
                var name=new StringBuilder(32);
                if(GetClassName(h,name,name.Capacity)==0 || name.ToString()!="#32768")return true;
                uint pid;var bar=new MenuBarInfo{size=Marshal.SizeOf(typeof(MenuBarInfo))};RECT rect;
                if(GetWindowThreadProcessId(h,out pid)!=thread || pid!=w.Pid || !GetMenuBarInfo(h,-4,0,ref bar) ||
                    bar.menu==IntPtr.Zero || !GetWindowRect(h,out rect)){unsupported=true;return false;}
                found.Add(new PopupMenu{Window=h,menu=bar.menu,menuOwner=info.menu,threadId=thread,BoundsOnScreen=Bounds(rect)});
                return found.Count<=12;
            },IntPtr.Zero);
            if(unsupported || found.Count==0 || found.Count>12)throw Changed();
            // A standard cascading menu is a single chain of real HMENU submenus.
            // A second root (even in the same process/thread) makes the source ambiguous.
            var parents=new Dictionary<PopupMenu,PopupMenu>();
            foreach(var popup in found) {
                int count=GetMenuItemCount(popup.menu);
                if(count<1||count>128)throw Changed();
                popup.items=new Item[count];
                for(int i=0;i<count;i++) {
                    var item=ReadItem(popup.menu,(uint)i);popup.items[i]=item;
                    var child=found.FirstOrDefault(m=>m.menu==item.submenu);
                    if(child!=null){if(parents.ContainsKey(child))throw Changed();parents[child]=popup;}
                }
            }
            var leaves=found.Where(p=>!parents.ContainsValue(p)).ToList();
            if(leaves.Count!=1 || parents.Count!=found.Count-1)throw Changed();
            var visited=new HashSet<PopupMenu>();
            for(var node=leaves[0];node!=null;) {
                if(!visited.Add(node))throw Changed();
                PopupMenu parent;parents.TryGetValue(node,out parent);
                IntPtr owner=GetWindow(node.Window,4); // GW_OWNER may be absent on native tracking menus.
                if(owner!=IntPtr.Zero && !OwnerMatches(owner,w,thread) && (parent==null || owner!=parent.Window))throw Changed();
                node=parent;
            }
            if(visited.Count!=found.Count)throw Changed();
            return leaves[0];
        }
        public static PopupMenu Observe(WindowChoice w) {
            var popup=Current(w);
            popup.marker=new IntPtr(System.Threading.Interlocked.Increment(ref generation));
            if(!SetProp(popup.Window,markerName,popup.marker))throw Changed();
            return popup;
        }
        public void Release(){if(GetProp(Window,markerName)==marker)RemoveProp(Window,markerName);}
        public void Validate(WindowChoice w) {
            var live=Current(w);
            if(live.Window!=Window || live.menu!=menu || live.menuOwner!=menuOwner || live.threadId!=threadId ||
                live.BoundsOnScreen!=BoundsOnScreen || GetProp(Window,markerName)!=marker ||
                items.Length!=live.items.Length || !items.Zip(live.items,(a,b)=>a.Same(b)).All(s=>s))throw Changed();
        }
        public string ControlsText() {
            var list=new List<string>{"当前画面为目标窗口已展开的标准弹出菜单。只能左键单击可用项或等待。"};
            foreach(var item in items)if(item.text.Length>0)list.Add((item.Clickable?"菜单项 · ":"需接手 · ")+Cut(item.text,160));
            return Cut(String.Join("\n",list),12000);
        }
        void CheckPoint(int x,int y) {
            if(!BoundsOnScreen.Contains(x,y) || GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=Window)
                throw new InputNotSent("菜单位置被其他窗口遮挡，请核对后继续。");
            var matches=items.Where(item=>item.bounds.Contains(x,y)).ToList();
            if(matches.Count!=1 || !matches[0].Clickable)throw new InputNotSent("此菜单项无法安全核验，请亲自处理后继续。");
        }
        public void Click(WindowChoice owner,int x,int y,Action check) {
            using(new PhysicalCoordinates()) {
                check();Validate(owner);CheckPoint(x,y);
                GuardElement(AutomationElement.FromPoint(new System.Windows.Point(x,y)));
                int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
                if(width<2 || height<2 || !new Rectangle(left,top,width,height).Contains(x,y))throw Changed();
                var move=new INPUT{type=0,data=new UNION{mouse=new MOUSE{dx=AbsolutePixel(x,left,width),dy=AbsolutePixel(y,top,height),flags=0xC001}}};
                // Check owner, menu contents and actual topmost hit again after UIA, immediately before the single batch.
                check();Validate(owner);CheckPoint(x,y);Send(move,Mouse(2),Mouse(4));
            }
        }
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool AppendMenu(IntPtr menu,uint flags,UIntPtr id,string label);
        [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
        [DllImport("user32.dll")] static extern bool TrackPopupMenuEx(IntPtr menu,uint flags,int x,int y,IntPtr owner,IntPtr parameters);
        [DllImport("user32.dll")] static extern bool EndMenu();
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle,string windowClass,string name,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr module,IntPtr data);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
        delegate void MenuTestTimer(IntPtr window,uint message,UIntPtr timer,uint time);
        [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr window,UIntPtr id,uint interval,MenuTestTimer callback);
        [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window,UIntPtr id);
        static void MustBlock(Action action) {
            try {action();}catch(InputNotSent){return;}
            throw new Exception("A stale, covered or unapproved popup target passed validation");
        }
        public static void SelfTest() {
            foreach(int width in new[]{1920,3840,5120})foreach(int x in new[]{0,1,width/2,width-1})
                if((long)AbsolutePixel(x-1920,-1920,width)*width/65536!=x)throw new Exception("Virtual screen coordinate changed the hit pixel");
            // This thread creates its own Windows desktop with no SWITCHDESKTOP right.
            // TrackPopupMenu runs its real menu loop there. The test never sends system input.
            IntPtr desktop=CreateDesktop("XutiMenuTest"+Guid.NewGuid().ToString("N"),IntPtr.Zero,IntPtr.Zero,0,0xFF,IntPtr.Zero);
            if(desktop==IntPtr.Zero)throw new Exception("Unable to create the isolated popup fixture");
            Exception failure=null;
            var test=new System.Threading.Thread(()=>{
                try {
                    if(!SetThreadDesktop(desktop))throw new Exception("Unable to bind isolated popup thread");
                    using(var coords=new PhysicalCoordinates())
                    using(var process=Process.GetCurrentProcess()) {
                        IntPtr window=CreateWindowEx(0,"STATIC","Fixture owner",0x90000000,20,20,360,300,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
                        IntPtr other=CreateWindowEx(0,"STATIC","Fixture other",0x80000000,0,0,100,100,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
                        var target=new WindowChoice{Handle=window,Pid=process.Id,Started=process.StartTime.ToUniversalTime().Ticks};
                        var unrelated=new WindowChoice{Handle=other,Pid=target.Pid,Started=target.Started};
                        PopupMenu popup=null;IntPtr trackingMenu=CreatePopupMenu();
                        try {
                            if(window==IntPtr.Zero || other==IntPtr.Zero || trackingMenu==IntPtr.Zero)throw new Exception("Cannot create fixture menu");
                            if(!AppendMenu(trackingMenu,0,new UIntPtr(11),"Fixture item") ||
                                !AppendMenu(trackingMenu,1,new UIntPtr(12),"Disabled item") ||
                                !AppendMenu(trackingMenu,0,new UIntPtr(13),"Delete"))throw new Exception("Cannot install fixture menu items");
                            using(var timeout=new System.Threading.Timer(_=>PostMessage(window,0x1F,IntPtr.Zero,IntPtr.Zero),null,4000,System.Threading.Timeout.Infinite)) {
                                MenuTestTimer tick=(h,message,id,time)=>{
                                    KillTimer(h,id);
                                    try {
                                        popup=Observe(target);popup.Validate(target);
                                        if(popup.Window==window || !popup.ControlsText().Contains("Fixture item"))throw new Exception("Menu observation captured the owner");
                                        var shot=CaptureSurface(popup.Window,null,popup.ControlsText(),popup);
                                        if(shot.InputBounds!=popup.BoundsOnScreen || shot.Width<100 || shot.Height<100 || String.IsNullOrEmpty(shot.Image))throw new Exception("Popup capture bounds mismatch");
                                        var r=popup.items[0].bounds;popup.CheckPoint(r.Left+r.Width/2,r.Top+r.Height/2);
                                        foreach(var item in popup.items.Skip(1))MustBlock(()=>popup.CheckPoint(item.bounds.Left+2,item.bounds.Top+2));
                                        using(var stream=new MemoryStream(Convert.FromBase64String(shot.Image)))
                                        using(var bitmap=new Bitmap(stream)){
                                            var colors=new HashSet<int>();
                                            for(int y=2;y<bitmap.Height && colors.Count<8;y+=2)for(int x=2;x<bitmap.Width && colors.Count<8;x+=2)
                                                colors.Add(bitmap.GetPixel(x,y).ToArgb());
                                            if(colors.Count<8)throw new Exception("Captured menu image was blank");
                                        }
                                        MustBlock(()=>popup.Validate(unrelated));
                                        MustBlock(()=>popup.CheckPoint(r.Left-1000,r.Top));
                                        IntPtr overlay=CreateWindowEx(0x08000008,"BUTTON","Fixture overlay",0x90000000,r.Left,r.Top,r.Width,r.Height,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
                                        if(overlay==IntPtr.Zero)throw new Exception("Cannot create isolated covering window");
                                        try {MustBlock(()=>popup.CheckPoint(r.Left+r.Width/2,r.Top+r.Height/2));}finally{DestroyWindow(overlay);}
                                    } catch(Exception ex){failure=ex;}finally{EndMenu();}
                                };
                                UIntPtr timer=SetTimer(window,new UIntPtr(1),100,tick);
                                if(timer==UIntPtr.Zero)throw new Exception("Cannot observe fixture menu");
                                try {TrackPopupMenuEx(trackingMenu,0x182,80,80,window,IntPtr.Zero);}
                                finally {KillTimer(window,timer);GC.KeepAlive(tick);}
                            }
                            if(failure!=null)return;
                            if(popup==null)throw new Exception("Fixture menu did not enter tracking mode");
                            MustBlock(()=>popup.Validate(target));
                        } finally {if(popup!=null)popup.Release();DestroyMenu(trackingMenu);DestroyWindow(other);DestroyWindow(window);}
                    }
                } catch(Exception ex){failure=ex;}
            });
            test.SetApartmentState(System.Threading.ApartmentState.MTA);test.IsBackground=true;
            try {test.Start();if(!test.Join(7000))throw new Exception("Isolated menu fixture timed out");}
            finally {CloseDesktop(desktop);}
            if(failure!=null)throw new Exception("Isolated popup fixture: "+failure.Message,failure);
        }
    }
    public static Shot Capture(WindowChoice w, Rectangle? contentBounds=null,bool fileCopy=false) {
        ValidateWindow(w,true);
        uint thread;
        if(MenuOpen(ThreadInfo(w,out thread))) {
            if(fileCopy)throw new InputNotSent("请关闭资源管理器中的菜单，核对文件列表后继续。");
            if(contentBounds.HasValue || BrowserWindows.ContainsKey(w.Handle))throw new Exception("网页出现系统菜单，请亲自处理后继续。");
            using(new PhysicalCoordinates()) {
                var popup=PopupMenu.Observe(w);
                try {
                    var shot=CaptureSurface(popup.Window,null,popup.ControlsText(),popup);
                    ValidateWindow(w,true);popup.Validate(w);return shot;
                } catch {popup.Release();throw;}
            }
        }
        if(fileCopy) {
            if(contentBounds.HasValue || !IsExplorerFolderWindow(w.Handle))throw new InputNotSent("文件复制需要已核对的资源管理器窗口。");
            Controls(w,null,false);
            RECT rect;
            if(!GetWindowRect(w.Handle,out rect))throw new InputNotSent("无法核对资源管理器窗口的位置。");
            ValidateWindow(w,true);
            return new Shot {Rect=rect};
        }
        return CaptureSurface(w.Handle,contentBounds,Controls(w,contentBounds),null);
    }
    static Shot CaptureSurface(IntPtr surface,Rectangle? contentBounds,string controls,PopupMenu popup) {
        RECT r;
        int minimum=popup==null?100:1;
        if(!GetWindowRect(surface,out r)||r.Right-r.Left<minimum||r.Bottom-r.Top<minimum)throw new Exception("窗口太小，请调整后继续");
        if((long)(r.Right-r.Left)*(r.Bottom-r.Top)>24000000)throw new Exception("窗口尺寸过大，请缩小后继续");
        var windowBounds=Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);
        var inputBounds=contentBounds??windowBounds;
        if(!windowBounds.Contains(inputBounds))throw new Exception("网页区域已变化，请核对后继续。");
        using(var original=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) {
            using(var g=Graphics.FromImage(original)){IntPtr dc=g.GetHdc();try{if(!PrintWindow(surface,dc,2))throw new Exception("此应用不支持窗口截取，请使用其他窗口");}finally{g.ReleaseHdc(dc);}}
            double scale=Math.Min(popup==null?1:Math.Max(1,100.0/Math.Min(inputBounds.Width,inputBounds.Height)),1400.0/Math.Max(inputBounds.Width,inputBounds.Height));
            int width=(int)Math.Round(inputBounds.Width*scale),height=(int)Math.Round(inputBounds.Height*scale);
            if(width<100||height<100)throw new Exception("窗口比例过窄，请调整后继续");
            using(var resized=new Bitmap(width,height)) using(var stream=new MemoryStream()) {
                using(var g=Graphics.FromImage(resized))g.DrawImage(original,new Rectangle(0,0,width,height),new Rectangle(inputBounds.Left-r.Left,inputBounds.Top-r.Top,inputBounds.Width,inputBounds.Height),GraphicsUnit.Pixel);
                var codec=ImageCodecInfo.GetImageEncoders().First(i=>i.MimeType=="image/jpeg");
                using(var quality=new EncoderParameters(1)){quality.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,78L);resized.Save(stream,codec,quality);}
                if(stream.Length>2000000)throw new Exception("窗口画面过大，请缩小窗口后继续");
                return new Shot{Image=Convert.ToBase64String(stream.ToArray()),Width=width,Height=height,Controls=controls,Rect=r,InputBounds=inputBounds,Popup=popup};
            }
        }
    }
    static string S(Dictionary<string,object> a,string k){return AssistantForm.S(a,k);}
    static int Number(Dictionary<string,object> a,string k,int min,int max) {object value;if(!a.TryGetValue(k,out value)||!(value is int)|| (int)value<min||(int)value>max)throw new Exception("操作坐标或数量无效");return (int)value;}
    static readonly Dictionary<string,ushort[]> Keys = new Dictionary<string,ushort[]> {
        {"COPY",new ushort[]{17,67}}, {"PASTE",new ushort[]{17,86}},
        {"CTRL_SHIFT_N",new ushort[]{17,16,78}},
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
    static void SendChord(ushort[] keys) {
        var inputs=new List<INPUT>();
        foreach(var key in keys)inputs.Add(K(key,0));
        foreach(var key in keys.Reverse())inputs.Add(K(key,2));
        Send(inputs.ToArray());
    }
    public static async Task Execute(WindowChoice w,Shot shot,Dictionary<string,object> a,Action check,BrowserWindow localBrowser=null,ExplorerCopy copy=null,Action verifyTask=null,bool wecom=false,string wecomInput="") {
        ValidateAction(a); check();
        if(wecom)CheckWeComAction(a,shot.Popup!=null,wecomInput);
        if(shot.Popup!=null) {
            string action=S(a,"kind");
            if(action=="wait") {await Task.Delay(800);return;}
            if(localBrowser!=null || action!="click" || S(a,"button")!="left")
                throw new InputNotSent("当前标准菜单只支持单击可核验的菜单项，请重新观察。");
            int menuX=shot.InputBounds.Left+(int)Math.Round(Number(a,"x",0,1000)*(shot.InputBounds.Width-1)/1000.0);
            int menuY=shot.InputBounds.Top+(int)Math.Round(Number(a,"y",0,1000)*(shot.InputBounds.Height-1)/1000.0);
            shot.Popup.Click(w,menuX,menuY,check);
            return;
        }
        uint thread;
        if(MenuOpen(ThreadInfo(w,out thread)))throw new InputNotSent("弹出菜单已变化，请核对当前菜单后继续。");
        string fileKey=S(a,"kind")=="key"?S(a,"key"):"";
        if(fileKey=="COPY" || fileKey=="PASTE") {
            if(copy==null || localBrowser!=null || shot.FileShortcut==null)throw new InputNotSent("此快捷键只在已核对的文件复制任务中开放。");
            try {GuardElement(AutomationElement.FocusedElement);}
            catch(Exception e) {throw new InputNotSent("资源管理器文件列表的焦点或敏感控件未通过核对。"+e.Message);}
            await copy.Execute(w,fileKey,shot.FileShortcut,check,verifyTask??check);
            return;
        }
        RECT r;GetWindowRect(w.Handle,out r);
        if(r.Left!=shot.Rect.Left||r.Top!=shot.Rect.Top||r.Right!=shot.Rect.Right||r.Bottom!=shot.Rect.Bottom)throw new Exception("窗口位置或大小已变化，请核对后继续");
        if(localBrowser!=null&&localBrowser.ContentBounds()!=shot.InputBounds)throw new Exception("网页区域已变化，请核对后继续。");
        string kind=S(a,"kind");
        if(kind=="switch_window") throw new Exception("切换窗口必须经过本机设备授权和目标校验");
        if(kind=="wait"){await Task.Delay(800);return;}
        if(kind=="click"||kind=="scroll") {
            int x=shot.InputBounds.Left+(int)Math.Round(Number(a,"x",0,1000)*(shot.InputBounds.Width-1)/1000.0);
            int y=shot.InputBounds.Top+(int)Math.Round(Number(a,"y",0,1000)*(shot.InputBounds.Height-1)/1000.0);
            if(localBrowser!=null)localBrowser.ValidateLocalAction(kind,S(a,"button"),x,y);
            Action checkPoint=()=>{
                if(GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=w.Handle)throw new InputNotSent("目标位置被其他窗口遮挡，请核对后继续。");
                uint activeThread;
                if(MenuOpen(ThreadInfo(w,out activeThread)))throw new InputNotSent("弹出菜单已变化，请核对当前菜单后继续。");
            };
            checkPoint();
            var pointElement=AutomationElement.FromPoint(new System.Windows.Point(x,y));
            GuardElement(pointElement); check();
            // Move and act in one injected batch. A harmless physical move between
            // separate calls must not redirect the click or scroll to another control.
            var screen=SystemInformation.VirtualScreen;
            var move=new INPUT{type=0,data=new UNION{mouse=new MOUSE{dx=AbsolutePixel(x,screen.Left,screen.Width),dy=AbsolutePixel(y,screen.Top,screen.Height),flags=0xC001}}};
            check();checkPoint();
            if(wecom && kind=="click")CheckWeComControl(w,AutomationElement.FromPoint(new System.Windows.Point(x,y)),"");
            if(kind=="scroll")Send(move,Mouse(0x0800,unchecked((uint)((S(a,"direction")=="up"?120:-120)*Number(a,"amount",1,6)))));
            else { bool right=S(a,"button")=="right";Send(move,Mouse(right?0x0008u:0x0002u),Mouse(right?0x0010u:0x0004u));if(S(a,"button")=="double"){await Task.Delay(80);check();try{checkPoint();}catch(InputNotSent e){throw new Exception("已发送第一次单击，请核对结果。"+e.Message);}Send(move,Mouse(2),Mouse(4));} }
            return;
        }
        if(localBrowser!=null)localBrowser.ValidateLocalAction(kind,S(a,"key"),0,0);
        GuardElement(AutomationElement.FocusedElement); check();
        if(kind=="key") {
            string key=S(a,"key");
            if(copy!=null)copy.VerifyOtherAction(a,w);
            if(S(a,"key")=="CTRL_SHIFT_N") {
                if(localBrowser!=null || shot.Popup!=null || shot.ExplorerFolder==null)throw new Exception("只能在已核验的桌面文件列表中新建文件夹。");
                await CheckNewFolderShortcut(w,shot.ExplorerFolder);
                check();
                if(!ExplorerListFocused(w))throw new Exception("桌面文件列表已失去焦点，请核对后继续。");
            }
            SendChord(Keys[key]);
        } else {
            // Unicode SendInput doesn't interpret text as key shortcuts or executable code.
            var editTarget=wecom ? AutomationElement.FocusedElement : null;
            if(wecom)CheckWeComControl(w,editTarget,wecomInput);
            foreach(char ch in S(a,"text")) {
                if(localBrowser!=null)localBrowser.ValidateLocalAction(kind,"",0,0);
                check();var focused=AutomationElement.FocusedElement;GuardElement(focused);
                if(wecom && (focused==null || !Automation.Compare(editTarget,focused)))
                    throw new Exception("企业微信输入焦点已改变，请核对已输入的文字。");
                Send(new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=4}}},new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=6}}});
                await Task.Delay(2);
            }
        }
    }
    // A message-only top-level window owns the global shortcut for its full
    // lifetime, independent of the embedded task panel's HWND and visibility.
    public sealed class StopKey : NativeWindow,IDisposable {
        const int Id=1;
        readonly Action stop;
        public readonly string Shortcut;
        public StopKey(Action stop) {
            this.stop=stop;
            CreateHandle(new CreateParams{Parent=new IntPtr(-3),Caption="XutiDesktopStop"});
            try { Shortcut=SelectShortcut(modifiers=>RegisterHotKey(Handle,Id,modifiers,0x58)); }
            catch { DestroyHandle();throw; }
        }
        public static string SelectShortcut(Func<uint,bool> register) {
            if(register(3))return "Ctrl+Alt+X";
            if(register(7))return "Ctrl+Alt+Shift+X";
            throw new Exception("两个停止快捷键均被占用。请释放 Ctrl+Alt+X 或 Ctrl+Alt+Shift+X，客户端将自动恢复接单。");
        }
        protected override void WndProc(ref Message message) {
            if(message.Msg==0x312 && message.WParam.ToInt32()==Id)stop();
            base.WndProc(ref message);
        }
        public void Dispose() {
            if(Handle!=IntPtr.Zero) { UnregisterHotKey(Handle,Id);DestroyHandle(); }
        }
    }
    public sealed class Hook : IDisposable {
        readonly HookProc mouseProc,keyProc;readonly IntPtr mouse,key;
        public Hook(Action<string> pause) {
            mouseProc=(n,w,l)=>{if(n>=0){string reason=MouseInputReason(w.ToInt32(),((MouseHook)Marshal.PtrToStructure(l,typeof(MouseHook))).flags);if(reason!=null)pause(reason);}return CallNextHookEx(IntPtr.Zero,n,w,l);};
            keyProc=(n,w,l)=>{if(n>=0){string reason=KeyInputReason(w.ToInt32(),((KeyHook)Marshal.PtrToStructure(l,typeof(KeyHook))).flags);if(reason!=null)pause(reason);}return CallNextHookEx(IntPtr.Zero,n,w,l);};
            mouse=SetWindowsHookEx(14,mouseProc,GetModuleHandle(null),0);key=SetWindowsHookEx(13,keyProc,GetModuleHandle(null),0);
            if(mouse==IntPtr.Zero||key==IntPtr.Zero){Dispose();throw new Exception("无法启用手动操作暂停保护，请重启本机助手。");}
        }
        public void Dispose(){if(mouse!=IntPtr.Zero)UnhookWindowsHookEx(mouse);if(key!=IntPtr.Zero)UnhookWindowsHookEx(key);}
    }
    public static string MouseInputReason(int message,uint flags) {
        if((flags&3)!=0)return null; // Injected or lower-integrity injected input.
        if(message==0x0201||message==0x0204||message==0x0207||message==0x020B)return "检测到你点击鼠标";
        if(message==0x020A||message==0x020E)return "检测到你滚动鼠标";
        return null; // Movement and button release do not constitute taking over.
    }
    public static string KeyInputReason(int message,uint flags) {
        if((flags&0x12)!=0)return null;
        return message==0x0100||message==0x0104 ? "检测到你按键" : null;
    }
    public static int SelfTest() {
        try {
            WindowContinuation.EditorSelfTest();
            PopupMenu.SelfTest();
            var modifiers=new List<uint>();
            if(StopKey.SelectShortcut(m=>{modifiers.Add(m);return m==7;})!="Ctrl+Alt+Shift+X"||!modifiers.SequenceEqual(new uint[]{3,7}))throw new Exception("Occupied shortcut did not select the registered fallback");
            if(StopKey.SelectShortcut(m=>m==3)!="Ctrl+Alt+X")throw new Exception("Primary stop shortcut mismatch");
            bool blocked=false;try{StopKey.SelectShortcut(m=>false);}catch{blocked=true;}if(!blocked)throw new Exception("Executor started without a stop shortcut");
            if(!IsSystemNotepad(Path.Combine(Environment.SystemDirectory,"notepad.exe"))||IsSystemNotepad(Path.Combine(Path.GetTempPath(),"notepad.exe")))throw new Exception("Notepad identity check failed");
            foreach(int message in new[]{0x0200,0x0202,0x0205,0x0208,0x020C})if(MouseInputReason(message,0)!=null)throw new Exception("Mouse movement/release incorrectly took over");
            foreach(int message in new[]{0x0201,0x0204,0x0207,0x020B,0x020A,0x020E}) {
                if(MouseInputReason(message,0)==null)throw new Exception("Physical mouse press/wheel was ignored");
                if(MouseInputReason(message,1)!=null||MouseInputReason(message,2)!=null)throw new Exception("Injected mouse input took over");
            }
            foreach(int message in new[]{0x0101,0x0105})if(KeyInputReason(message,0)!=null)throw new Exception("Key release incorrectly took over");
            foreach(int message in new[]{0x0100,0x0104})if(KeyInputReason(message,0)==null||KeyInputReason(message,0x10)!=null||KeyInputReason(message,2)!=null)throw new Exception("Physical/injected key classification incorrect");
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
