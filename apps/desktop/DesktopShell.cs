using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace XutiDesktop {
static partial class ShellPolicy {
    public const string Origin = "https://vip-web-production.up.railway.app";
    public const string SetupPath = "/my-workspace?assistant=desktop&connect=1";
    public static bool Trusted(string value) {
        Uri uri;
        return Uri.TryCreate(value,UriKind.Absolute,out uri) && uri.Scheme=="https" &&
            uri.Host==new Uri(Origin).Host && uri.Port==443 && uri.UserInfo.Length==0;
    }
    public static bool WebAddress(string value) {
        Uri uri;
        return value!=null && value.Length<=4096 && !value.Any(Char.IsControl) &&
            Uri.TryCreate(value,UriKind.Absolute,out uri) && uri.Scheme=="https" &&
            uri.Host.Length>0 && uri.UserInfo.Length==0;
    }
    public static Dictionary<string,object> Message(string source,string current,string raw) {
        if(!Trusted(source)||!Trusted(current)||raw==null||raw.Length>4096) throw new Exception("不支持的客户端请求");
        var d=AssistantForm.D(new JavaScriptSerializer().DeserializeObject(raw));
        string channel=AssistantForm.S(d,"channel"), action=AssistantForm.S(d,"action");
        if(channel!="xuti-desktop"||!new[]{"status","pair","authorize","show-tasks","open-local-browser","theme"}.Contains(action)) throw new Exception("不支持的客户端请求");
        if(action=="theme") {
            if(d.Keys.Any(k=>!new[]{"channel","action","value"}.Contains(k))||!new[]{"light","dark"}.Contains(AssistantForm.S(d,"value"))) throw new Exception("主题无效");
        } else {
            Guid id;
            if(!Guid.TryParse(AssistantForm.S(d,"id"),out id)||d.Keys.Any(k=>!new[]{"channel","action","id","code","deviceId","url"}.Contains(k))) throw new Exception("请求无效");
            if(action=="pair"&&!Regex.IsMatch(AssistantForm.S(d,"code"),"^[a-f0-9]{32}$")) throw new Exception("配对码无效");
            if(action!="pair"&&d.ContainsKey("code")) throw new Exception("请求无效");
            if(action=="authorize"&&!Guid.TryParse(AssistantForm.S(d,"deviceId"),out id)) throw new Exception("设备无效");
            if(action!="authorize"&&d.ContainsKey("deviceId")) throw new Exception("请求无效");
            if(d.ContainsKey("url")&&(action!="open-local-browser"||!(d["url"] is string)||!WebAddress((string)d["url"]))) throw new Exception("仅支持 HTTPS 网页地址。");
        }
        return d;
    }
    public static int SelfTest() {
        try {
            if(!Trusted(Origin+"/my-workspace")||!WebAddress("https://www.erp321.com/epaas"))throw new Exception("Expected valid origin");
            foreach(string uri in new[]{"http://vip-web-production.up.railway.app","https://vip-web-production.up.railway.app.evil.test","https://vip-web-production.up.railway.app:444","https://evil@vip-web-production.up.railway.app","file:///C:/private","javascript:alert(1)"})if(Trusted(uri))throw new Exception("Invalid origin accepted");
            foreach(string uri in new[]{"file:///C:/private","javascript:alert(1)","data:text/html,hello","http://localhost/","https://a:b@example.com"})if(WebAddress(uri))throw new Exception("Invalid navigation accepted");
            var j=new JavaScriptSerializer();
            string valid=j.Serialize(new{channel="xuti-desktop",action="status",id=Guid.NewGuid().ToString()});
            Message(Origin,Origin,valid);
            Message(Origin,Origin,j.Serialize(new{channel="xuti-desktop",action="authorize",id=Guid.NewGuid().ToString(),deviceId=Guid.NewGuid().ToString()}));
            Message(Origin,Origin,j.Serialize(new{channel="xuti-desktop",action="open-local-browser",id=Guid.NewGuid().ToString()}));
            Message(Origin,Origin,j.Serialize(new{channel="xuti-desktop",action="open-local-browser",id=Guid.NewGuid().ToString(),url="https://example.com/"}));
            foreach(string bad in new[]{j.Serialize(new{channel="xuti-desktop",action="open-local-browser",id=Guid.NewGuid().ToString(),url="file:///C:/private"}),j.Serialize(new{channel="xuti-desktop",action="status",id=Guid.NewGuid().ToString(),url="https://example.com/"})}) {
                bool rejected=false;try{Message(Origin,Origin,bad);}catch{rejected=true;}if(!rejected)throw new Exception("Invalid local browser request accepted");
            }
            foreach(string bad in new[]{j.Serialize(new{channel="xuti-desktop",action="authorize",id=Guid.NewGuid().ToString()}),j.Serialize(new{channel="xuti-desktop",action="authorize",id=Guid.NewGuid().ToString(),deviceId="wrong"}),j.Serialize(new{channel="xuti-desktop",action="status",id=Guid.NewGuid().ToString(),deviceId=Guid.NewGuid().ToString()})}) {
                bool rejected=false;try{Message(Origin,Origin,bad);}catch{rejected=true;}if(!rejected)throw new Exception("Invalid authorization request accepted");
            }
            foreach(string bad in new[]{j.Serialize(new{channel="xuti-desktop",action="shell",id=Guid.NewGuid().ToString()}),j.Serialize(new{channel="xuti-desktop",action="pair",id=Guid.NewGuid().ToString(),code="bad"}),j.Serialize(new{channel="xuti-desktop",action="status",id=Guid.NewGuid().ToString(),token="private"})}) {
                bool rejected=false;try{Message(Origin,Origin,bad);}catch{rejected=true;}if(!rejected)throw new Exception("Invalid bridge message accepted");
            }
            bool denied=false;try{Message("https://example.com",Origin,valid);}catch{denied=true;}if(!denied)throw new Exception("External page bridge accepted");
            DesktopRelease.SelfTest();
            Console.WriteLine("Desktop origin, navigation, bridge and release validation: passed");return 0;
        } catch(Exception e){Console.WriteLine(e.Message);return 1;}
    }
}

static class DesktopRelease {
    public const string FeedUrl = ShellPolicy.Origin + "/downloads/xuti-desktop-release.json";
    public const string DownloadUrl = ShellPolicy.Origin + "/downloads/xuti-desktop.zip";
    const int MaxFeedBytes = 4096;

    public static HttpClient CreateClient() {
        return new HttpClient(new HttpClientHandler { AllowAutoRedirect=false, UseCookies=false }) {
            Timeout=TimeSpan.FromSeconds(10), MaxResponseContentBufferSize=MaxFeedBytes
        };
    }
    public static async Task<Version> ReadLatestAsync(HttpClient client,CancellationToken cancellation) {
        using(var request=new HttpRequestMessage(HttpMethod.Get,FeedUrl)) {
            request.Headers.CacheControl=new System.Net.Http.Headers.CacheControlHeaderValue { NoCache=true };
            using(var response=await client.SendAsync(request,HttpCompletionOption.ResponseContentRead,cancellation).ConfigureAwait(false)) {
                if(response.StatusCode!=HttpStatusCode.OK || response.Content==null)return null;
                var bytes=await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                if(bytes.Length>MaxFeedBytes)return null;
                return ParseFeed(System.Text.Encoding.UTF8.GetString(bytes));
            }
        }
    }
    static Version ParseFeed(string body) {
        try {
            var data=new JavaScriptSerializer { MaxJsonLength=MaxFeedBytes, RecursionLimit=8 }.DeserializeObject(body) as Dictionary<string,object>;
            object field;
            if(data==null || !data.TryGetValue("version",out field))return null;
            string text=field as string;
            Version version;
            if(text==null || !Regex.IsMatch(text,@"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z") || !Version.TryParse(text,out version))return null;
            return version;
        } catch(ArgumentException) { return null; } catch(InvalidOperationException) { return null; }
    }
    public static void SelfTest() {
        var actual=ParseFeed("{\"version\":\"1.10.0\",\"url\":\"https://example.com/ignored\"}");
        if(actual==null || actual.CompareTo(new Version(1,9,99))<=0)throw new Exception("Invalid desktop release ordering");
        foreach(string invalid in new[]{"{}","[]","<html>","{\"version\":1}","{\"version\":\"1.2\"}","{\"version\":\"01.2.3\"}","{\"version\":\"1.2.3-beta\"}","{\"version\":\"1.2.3.4\"}"})
            if(ParseFeed(invalid)!=null)throw new Exception("Malformed desktop release accepted");
    }
}

static class ShellStyle {
    public static Button Button(string text,Action click) {
        var b=new Button{Text=text,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,FlatStyle=FlatStyle.Flat,Padding=new Padding(12,7,12,7),Margin=new Padding(3,0,3,0),Cursor=Cursors.Hand};
        b.FlatAppearance.BorderSize=0;b.Click+=(s,e)=>click();return b;
    }
    public static void Apply(Control c,bool dark) {
        c.BackColor=dark?Color.FromArgb(25,27,34):Color.FromArgb(248,249,253);
        c.ForeColor=dark?Color.FromArgb(224,229,247):Color.FromArgb(40,48,72);
        if(c is TextBox || c is ComboBox) c.BackColor=dark?Color.FromArgb(35,39,50):Color.White;
        if(c is Button){var b=(Button)c;b.FlatStyle=FlatStyle.Flat;b.FlatAppearance.BorderColor=dark?Color.FromArgb(60,66,92):Color.FromArgb(221,225,244);}
        foreach(Control child in c.Controls) if(!(child is WebView2)) Apply(child,dark);
    }
}

sealed class DesktopShell : Form {
    readonly WebView2 workspace=new WebView2{Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(247,248,253)};
    readonly AssistantForm assistant=new AssistantForm{TopLevel=false,FormBorderStyle=FormBorderStyle.None,Dock=DockStyle.Fill};
    readonly Panel workPanel=new Panel{Dock=DockStyle.Fill};
    readonly Panel taskPanel=new Panel{Dock=DockStyle.Fill,Visible=false,Padding=new Padding(30,12,30,12)};
    readonly FlowLayoutPanel updateNotice=new FlowLayoutPanel { AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,WrapContents=false,Padding=new Padding(8),BorderStyle=BorderStyle.FixedSingle,Visible=false,AccessibleName="桌面端更新" };
    readonly Label releaseLabel=new Label { AutoSize=true,Anchor=AnchorStyles.Left,Margin=new Padding(5,0,8,0) };
    readonly System.Windows.Forms.Timer updateTimer=new System.Windows.Forms.Timer { Interval=30*60*1000 };
    readonly CancellationTokenSource releaseLifetime=new CancellationTokenSource();
    readonly HttpClient releaseClient=DesktopRelease.CreateClient();
    readonly string reminderPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktopAssistant","release-reminder.txt");
    Version availableRelease,deferredRelease;
    long deferredUntil;
    bool reminderLoaded,checkingRelease,releaseDisposed;
    readonly ToolTip actionError=new ToolTip();
    readonly Panel notice=new Panel{Dock=DockStyle.Fill,Visible=false,Padding=new Padding(36)};
    readonly Label noticeText=new Label{Dock=DockStyle.Top,Height=100,Font=new Font("Microsoft YaHei UI",12)};
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly List<BrowserWindow> browsers=new List<BrowserWindow>();
    CoreWebView2Environment environment;
    Task<CoreWebView2Environment> localBrowserEnvironment;
    BrowserWindow localBrowser;
    bool ready,initializing,exiting,closePending,dark;
    long navigation;
    string pendingUrl=ShellPolicy.Origin+"/my-workspace";

    public DesktopShell() {
        Text="XUTI DESKTOP";Width=1340;Height=900;MinimumSize=new Size(980,650);
        StartPosition=FormStartPosition.CenterScreen;Font=new Font("Microsoft YaHei UI",10);
        AutoScaleMode=AutoScaleMode.Dpi;
        workspace.KeyDown+=(s,e)=>{
            Action action=Shortcut(e.KeyData);if(action==null)return;
            e.Handled=true;e.SuppressKeyPress=true;BeginInvoke(action);
        };
        try{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}
        workPanel.Controls.Add(workspace);workPanel.Controls.Add(notice);
        notice.Controls.Add(noticeText);
        var actions=new FlowLayoutPanel{Dock=DockStyle.Top,Height=52};
        actions.Controls.Add(ShellStyle.Button("重新连接",()=>{if(ready)workspace.CoreWebView2.Navigate(pendingUrl);else{var ignored=Initialize();}}));
        actions.Controls.Add(ShellStyle.Button("打开电脑任务",ShowTasks));
        actions.Controls.Add(ShellStyle.Button("在浏览器中打开",()=>OpenSystem(ShellPolicy.Origin+"/my-workspace")));
        actions.Controls.Add(ShellStyle.Button("安装网页运行环境",()=>OpenSystem("https://developer.microsoft.com/microsoft-edge/webview2/")));
        notice.Controls.Add(actions);actions.BringToFront();
        taskPanel.Controls.Add(assistant);
        Controls.Add(workPanel);Controls.Add(taskPanel);
        updateNotice.Controls.Add(releaseLabel);
        updateNotice.Controls.Add(ShellStyle.Button("下载新版",()=>{if(availableRelease!=null && assistant.CanShowReleaseNotice && OpenSystem(DesktopRelease.DownloadUrl))DeferRelease();}));
        updateNotice.Controls.Add(ShellStyle.Button("稍后",DeferRelease));
        Controls.Add(updateNotice);
        ClientSizeChanged+=(s,e)=>PositionUpdateNotice();
        updateNotice.SizeChanged+=(s,e)=>PositionUpdateNotice();
        assistant.Changed+=RefreshUpdateNotice;
        updateTimer.Tick+=async(s,e)=>await CheckForReleaseAsync();
        assistant.SetupRequested+=()=>{var ignored=RequestSetup();};
        assistant.WorkspaceRequested+=()=>ShowWorkspace(null);
        Shown+=async(s,e)=>{assistant.Show();assistant.StartEngine();await Initialize();};
        Shown+=async(s,e)=>{updateTimer.Start();await CheckForReleaseAsync();};
        FormClosing+=async(s,e)=>{
            if(exiting)return;
            e.Cancel=true;if(closePending)return;closePending=true;
            updateTimer.Stop();releaseLifetime.Cancel();
            await Task.WhenAny(assistant.EndSession(),Task.Delay(3000));
            assistant.Shutdown();exiting=true;BeginInvoke(new Action(Close));
        };
        FormClosed+=(s,e)=>{foreach(var b in browsers.ToArray())b.Close();assistant.Dispose();workspace.Dispose();};
        ApplyTheme(false);
    }
    public static int CheckRuntime() {
        try{Console.WriteLine("WebView2 runtime: "+CoreWebView2Environment.GetAvailableBrowserVersionString());return 0;}
        catch{Console.WriteLine("WebView2 runtime missing");return 1;}
    }
    protected override void Dispose(bool disposing) {
        if(disposing && !releaseDisposed) {
            releaseDisposed=true;
            updateTimer.Dispose();releaseLifetime.Cancel();releaseClient.Dispose();releaseLifetime.Dispose();
            actionError.Dispose();
        }
        base.Dispose(disposing);
    }
    async Task CheckForReleaseAsync() {
        if(checkingRelease || closePending || releaseDisposed)return;
        checkingRelease=true;
        try {
            var cancellation=releaseLifetime.Token;
            var version=await Task.Run(()=>DesktopRelease.ReadLatestAsync(releaseClient,cancellation));
            if(!closePending && !releaseDisposed)ApplyReleaseVersion(version);
        } catch(HttpRequestException) { /* Offline clients retry on the next tick. */ }
          catch(OperationCanceledException) { /* Timeout or shutdown. */ }
          catch(ObjectDisposedException) { /* The window closed during the request. */ }
        finally { checkingRelease=false; }
    }
    void ApplyReleaseVersion(Version version) {
        availableRelease=version!=null && version.CompareTo(new Version(ShellPolicy.Version))>0 ? version : null;
        if(availableRelease!=null && !reminderLoaded) {
            reminderLoaded=true;
            try {
                var file=new FileInfo(reminderPath);
                if(file.Exists && file.Length<=128) {
                    var parts=File.ReadAllText(reminderPath).Split(' ');
                    if(parts.Length==2 && Version.TryParse(parts[0],out deferredRelease))Int64.TryParse(parts[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out deferredUntil);
                }
            } catch(IOException) {} catch(UnauthorizedAccessException) {} catch(System.Security.SecurityException) {}
        }
        if(availableRelease!=null)releaseLabel.Text="桌面端 "+availableRelease+" 已发布";
        RefreshUpdateNotice();
    }
    void RefreshUpdateNotice() {
        if(closePending || releaseDisposed)return;
        bool show=availableRelease!=null && assistant.CanShowReleaseNotice && !(availableRelease.Equals(deferredRelease) && DateTime.UtcNow.Ticks<deferredUntil);
        if(updateNotice.Visible==show)return;
        updateNotice.Visible=show;
        if(show){updateNotice.BringToFront();PositionUpdateNotice();}
    }
    void PositionUpdateNotice() {
        updateNotice.Location=new Point(Math.Max(0,ClientSize.Width-updateNotice.Width-16),Math.Max(0,ClientSize.Height-updateNotice.Height-16));
    }
    void DeferRelease() {
        if(availableRelease==null)return;
        deferredRelease=availableRelease;deferredUntil=DateTime.UtcNow.AddDays(1).Ticks;
        RefreshUpdateNotice();
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(reminderPath));
            File.WriteAllText(reminderPath,deferredRelease+" "+deferredUntil.ToString(System.Globalization.CultureInfo.InvariantCulture));
        } catch(IOException) {} catch(UnauthorizedAccessException) {} catch(System.Security.SecurityException) {}
    }
    void ShowActionError(string text) {
        if(!exiting&&!IsDisposed&&Visible)actionError.Show(text,this,18,18,8000);
    }
    void ApplyTheme(bool value) {
        dark=value;ShellStyle.Apply(this,dark);
        workspace.DefaultBackgroundColor=dark?Color.FromArgb(17,18,23):Color.FromArgb(247,248,253);
        foreach(var b in browsers)b.Theme(dark);
    }
    void ShowTasks(){taskPanel.Visible=true;workPanel.Visible=false;}
    Action Shortcut(Keys keyData) {
        if(keyData==(Keys.Control|Keys.D1))return ()=>ShowWorkspace(null);
        if(keyData==(Keys.Control|Keys.D2))return ShowLocalBrowser;
        if(keyData==(Keys.Control|Keys.D3))return ShowTasks;
        if(keyData==(Keys.Control|Keys.Shift|Keys.L))return ()=>{var ignored=RequestSetup();};
        if(keyData==Keys.F1)return ()=>ShowWorkspace("/help?chapter=39-assistant-desktop.md");
        if(keyData==Keys.F5||keyData==(Keys.Control|Keys.R))return ()=>{
            ShowWorkspace(null);if(ready)workspace.Reload();else{var ignored=Initialize();}
        };
        return null;
    }
    protected override bool ProcessCmdKey(ref Message msg,Keys keyData) {
        Action action=Shortcut(keyData);if(action!=null){action();return true;}
        return base.ProcessCmdKey(ref msg,keyData);
    }
    void ShowWorkspace(string path) {
        workPanel.Visible=true;taskPanel.Visible=false;
        if(path!=null){pendingUrl=ShellPolicy.Origin+path;if(ready)workspace.CoreWebView2.Navigate(pendingUrl);}
    }
    async Task RequestSetup() {
        ShowWorkspace(null);
        if(ready && ShellPolicy.Trusted(workspace.CoreWebView2.Source)) {
            long version=navigation;
            try {
                string handled=await workspace.CoreWebView2.ExecuteScriptAsync("(() => { if (window !== window.top || location.origin !== 'https://vip-web-production.up.railway.app') return false; return !window.dispatchEvent(new Event('xuti-desktop-setup', {cancelable:true})); })()");
                if(version!=navigation || exiting) return;
                if(handled=="true") return;
            } catch {
                ShowActionError("页面暂时无法响应，请稍后从「我的电脑」重试。");
                return;
            }
        }
        ShowWorkspace(ShellPolicy.SetupPath);
    }
    void ShowNotice(string text){noticeText.Text=text;notice.Visible=true;notice.BringToFront();}
    bool OpenSystem(string url) {
        if(!ShellPolicy.WebAddress(url))return false;
        try{Process.Start(new ProcessStartInfo(url){UseShellExecute=true});return true;}catch{ShowActionError("无法打开系统浏览器，请检查默认浏览器设置。");return false;}
    }
    void OpenBrowser(string url) {
        if(environment==null){ShowNotice("网页环境尚未准备好，请稍后重试。");return;}
        if(BrowserWindow.WindowCount>=8){MessageBox.Show(this,"请先关闭不需要的网页窗口，最多同时打开8个。","小序");return;}
        var window=new BrowserWindow(environment,url,dark);
        browsers.Add(window);window.FormClosed+=(s,e)=>browsers.Remove(window);window.Show();
    }
    async void ShowLocalBrowser() {
        try { await OpenLocalBrowser(null, navigation); }
        catch { ShowActionError("本地浏览器未能启动。请检查 WebView2 Runtime 后重试。"); }
    }
    async Task OpenLocalBrowser(string url,long version) {
        if(localBrowserEnvironment==null) {
            string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktopAssistant","LocalBrowserProfile");
            localBrowserEnvironment=CoreWebView2Environment.CreateAsync(null,profile);
        }
        CoreWebView2Environment localEnvironment;
        try { localEnvironment=await localBrowserEnvironment; }
        catch { localBrowserEnvironment=null;throw; }
        if(exiting||version!=navigation)return;
        if(localBrowser==null||localBrowser.IsDisposed) {
            if(BrowserWindow.WindowCount>=8)throw new InvalidOperationException("请先关闭一个网页窗口。");
            var window=new BrowserWindow(localEnvironment,url,dark,true);
            localBrowser=window;browsers.Add(window);
            window.FormClosed+=(s,e)=>{browsers.Remove(window);if(localBrowser==window)localBrowser=null;};
            window.Show(this);
        } else {
            if(localBrowser.WindowState==FormWindowState.Minimized)localBrowser.WindowState=FormWindowState.Normal;
            if(url!=null)localBrowser.OpenAddress(url);
            localBrowser.Activate();
        }
        await localBrowser.EnsureReady();
    }
    async Task Initialize() {
        if(initializing||ready)return;initializing=true;ShowNotice("正在连接你的工作台…");
        try {
            // Dedicated local browser profile. Never read or copy an existing browser's cookies.
            string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktopAssistant","WebProfile");
            environment=await CoreWebView2Environment.CreateAsync(null,profile);
            await workspace.EnsureCoreWebView2Async(environment);
            var core=workspace.CoreWebView2;
            core.Settings.AreHostObjectsAllowed=false;core.Settings.AreDevToolsEnabled=false;
            core.Settings.IsWebMessageEnabled=true;core.Settings.IsPasswordAutosaveEnabled=false;
            core.Settings.IsGeneralAutofillEnabled=false;
            core.NavigationStarting+=(s,e)=>{
                navigation++;
                if(!ShellPolicy.Trusted(e.Uri)){e.Cancel=true;if(e.IsUserInitiated&&ShellPolicy.WebAddress(e.Uri))OpenBrowser(e.Uri);return;}
                pendingUrl=e.Uri;
            };
            core.NavigationCompleted+=(s,e)=>{if(e.IsSuccess)notice.Visible=false;else ShowNotice("暂时无法连接工作台。请检查网络，再点击「重新连接」。");};
            core.NewWindowRequested+=(s,e)=>{e.Handled=true;if(e.IsUserInitiated&&ShellPolicy.WebAddress(e.Uri))OpenBrowser(e.Uri);};
            core.PermissionRequested+=(s,e)=>BrowserWindow.Permission(this,e,true);
            core.DownloadStarting+=(s,e)=>BrowserWindow.Download(this,e);
            core.ProcessFailed+=(s,e)=>ShowNotice("网页进程已停止，请关闭并重新打开小序。需要暂停或停止电脑任务时，点击「打开电脑任务」。");
            core.WebMessageReceived+=OnMessage;
            core.WebResourceResponseReceived+=async(s,e)=>{
                Uri u;if(!Uri.TryCreate(e.Request.Uri,UriKind.Absolute,out u)||!ShellPolicy.Trusted(e.Request.Uri))return;
                if((u.AbsolutePath=="/api/v1/auth/logout"&&e.Response.StatusCode<300)||(u.AbsolutePath=="/api/v1/auth/me"&&e.Response.StatusCode==401)) {
                    try{await assistant.Disconnect();}catch{}
                }
            };
            // No native object, token, filesystem or execution API is injected into any page.
            await core.AddScriptToExecuteOnDocumentCreatedAsync(@"(() => {
                if (window !== window.top || location.origin !== 'https://vip-web-production.up.railway.app') return;
                Object.defineProperty(window, 'xutiDesktop', {value: Object.freeze({version:'" + ShellPolicy.Version + @"',localBrowser:true,nativeUpdates:true}), writable:false});
                const theme = () => window.chrome.webview.postMessage({channel:'xuti-desktop',action:'theme',value:document.documentElement.dataset.theme === 'dark'?'dark':'light'});
                addEventListener('DOMContentLoaded', () => {theme();new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});});
            })();");
            ready=true;core.Navigate(pendingUrl);
        } catch {ShowNotice("网页环境未能启动。请确认电脑已安装 Microsoft Edge WebView2 Runtime，然后重新打开小序。可点击下方按钮前往微软官网。");}
        finally{initializing=false;}
    }
    async void OnMessage(object sender,CoreWebView2WebMessageReceivedEventArgs e) {
        long version=navigation;string id="";
        try {
            var data=ShellPolicy.Message(e.Source,workspace.CoreWebView2.Source,e.WebMessageAsJson);
            string action=AssistantForm.S(data,"action");id=AssistantForm.S(data,"id");
            if(action=="theme"){ApplyTheme(AssistantForm.S(data,"value")=="dark");return;}
            if(action=="status") await assistant.RefreshStatus();
            if(action=="pair") {
                await assistant.PairCode(AssistantForm.S(data,"code"));
                if(version!=navigation){await assistant.Disconnect();return;}
            }
            if(action=="authorize") {
                await assistant.RequestAuthorization(AssistantForm.S(data,"deviceId"));
                if(version!=navigation){await assistant.Disconnect();return;}
            }
            if(action=="show-tasks")ShowTasks();
            if(action=="open-local-browser")await OpenLocalBrowser(data.ContainsKey("url")?(string)data["url"]:null,version);
            Reply(version,new{channel="xuti-desktop",id,ok=true,data=new{version=ShellPolicy.Version,connected=assistant.Connected,deviceId=assistant.DeviceId,authorized=assistant.Authorized}});
        } catch(Exception ex) {
            if(id.Length>0)Reply(version,new{channel="xuti-desktop",id,ok=false,error=ex is ApiFailure||ex is InvalidOperationException?ex.Message:"客户端未能完成请求，请检查本机状态后重试。"});
        }
    }
    void Reply(long version,object value) {
        if(!exiting&&version==navigation&&ready&&ShellPolicy.Trusted(workspace.CoreWebView2.Source))workspace.CoreWebView2.PostWebMessageAsJson(json.Serialize(value));
    }
}

sealed class BrowserWindow : Form {
    public static int WindowCount { get; private set; }
    readonly CoreWebView2Environment environment;
    readonly WebView2 web=new WebView2{Dock=DockStyle.Fill};
    readonly TextBox address=new TextBox{Width=660,Font=new Font("Microsoft YaHei UI",11),Margin=new Padding(6,8,6,0)};
    readonly Label progress=new Label{Dock=DockStyle.Bottom,Height=28,Padding=new Padding(12,5,0,0),Text="此网页窗口可在「电脑任务」中选择。"};
    readonly Label welcome=new Label{Dock=DockStyle.Fill,Padding=new Padding(60,90,40,0),Font=new Font("Microsoft YaHei UI",16),Text="在网页与工作之间，自由切换。\n\n在上方输入网址，打开聚水潭、罗盘或其他工作页面。\n\n登录由你完成；网页会话仅保存在这台电脑。"};
    readonly bool dedicatedLocal;
    public long PageRevision { get; private set; }
    bool pageReady;
    string initial;
    public BrowserWindow(CoreWebView2Environment env,string url,bool dark,bool dedicatedLocal=false) {
        WindowCount++;
        this.dedicatedLocal=dedicatedLocal;
        environment=env;initial=url;Text=dedicatedLocal?"小序本地浏览器":"小序网页";Width=1180;Height=810;MinimumSize=new Size(900,600);StartPosition=FormStartPosition.CenterScreen;
        Font=new Font("Microsoft YaHei UI",10);
        web.KeyDown+=(s,e)=>{
            if(e.KeyData!=(Keys.Control|Keys.L))return;
            e.Handled=true;e.SuppressKeyPress=true;BeginInvoke(new Action(()=>{address.Focus();address.SelectAll();}));
        };
        try{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}
        var bar=new FlowLayoutPanel{Dock=DockStyle.Top,Height=58,Padding=new Padding(8,6,8,5),WrapContents=false};
        bar.Controls.Add(ShellStyle.Button("后退",()=>{if(web.CoreWebView2!=null&&web.CanGoBack)web.GoBack();}));
        bar.Controls.Add(ShellStyle.Button("前进",()=>{if(web.CoreWebView2!=null&&web.CanGoForward)web.GoForward();}));
        bar.Controls.Add(address);bar.Controls.Add(ShellStyle.Button("打开",Navigate));bar.Controls.Add(ShellStyle.Button("刷新",()=>{if(web.CoreWebView2!=null)web.Reload();}));
        bar.Resize+=(s,e)=>address.Width=Math.Max(300,bar.ClientSize.Width-360);
        address.KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Enter){e.SuppressKeyPress=true;Navigate();}};
        Controls.Add(web);Controls.Add(welcome);Controls.Add(progress);Controls.Add(bar);welcome.BringToFront();Theme(dark);
        Shown+=async(s,e)=>{
            try {
                await web.EnsureCoreWebView2Async(environment);var core=web.CoreWebView2;
                core.Settings.AreHostObjectsAllowed=false;core.Settings.IsWebMessageEnabled=false;core.Settings.AreDevToolsEnabled=false;
                core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
                core.NavigationStarting+=(o,a)=>{PageRevision++;if(!ShellPolicy.WebAddress(a.Uri)&&a.Uri!="about:blank"){a.Cancel=true;progress.Text="仅支持 HTTPS 网页地址。";}else {pageReady=false;welcome.Visible=false;}};
                core.SourceChanged+=(o,a)=>{PageRevision++;if(ShellPolicy.WebAddress(core.Source))address.Text=core.Source;};
                core.DocumentTitleChanged+=(o,a)=>{Text=(dedicatedLocal?"小序本地浏览器 · ":"小序网页 · ")+core.DocumentTitle;};
                core.NavigationCompleted+=(o,a)=>{pageReady=a.IsSuccess;progress.Text=a.IsSuccess?(dedicatedLocal?"可对小序说「在本地浏览器中…」；登录和敏感操作请亲自处理。":"在「电脑任务」允许此窗口，或记住跨窗口授权后，小序可以按任务操作网页。"):"网页加载失败，请检查地址或网络后重试。";};
                core.NewWindowRequested+=async(o,a)=>{
                    if(!a.IsUserInitiated||!ShellPolicy.WebAddress(a.Uri)||WindowCount>=8){a.Handled=true;return;}
                    using(var deferred=a.GetDeferral()) {
                        // Preserve window.opener for user-initiated login popups without exposing any bridge.
                        var child=new BrowserWindow(environment,null,dark);child.Show(this);
                        try{await child.EnsureReady();a.NewWindow=child.web.CoreWebView2;}catch{child.Close();}finally{a.Handled=true;}
                    }
                };
                core.PermissionRequested+=(o,a)=>Permission(this,a,false);
                core.DownloadStarting+=(o,a)=>Download(this,a);
                core.WindowCloseRequested+=(o,a)=>Close();
                Native.BrowserWindows.TryAdd(Handle,0);
                if(dedicatedLocal)Native.LocalBrowserWindows.TryAdd(Handle,this);
                if(initial!=null){address.Text=initial;Navigate();}
                else {welcome.Visible=true;welcome.BringToFront();address.Focus();}
            }catch{progress.Text="网页环境未能启动，请重启小序后再试。";}
        };
        FormClosed+=(s,e)=>{WindowCount--;byte ignored;BrowserWindow local;Native.LocalBrowserWindows.TryRemove(Handle,out local);Native.BrowserWindows.TryRemove(Handle,out ignored);web.Dispose();};
    }
    public async Task EnsureReady(){for(int i=0;i<100&&!IsDisposed;i++){if(web.CoreWebView2!=null)return;await Task.Delay(100);}throw new InvalidOperationException("本地网页启动超时，请重试。");}
    public void OpenAddress(string url) {
        if(!ShellPolicy.WebAddress(url))throw new InvalidOperationException("仅支持 HTTPS 网页地址。");
        if(web.CoreWebView2==null)initial=url;
        else {address.Text=url;Navigate();}
    }
    public void ValidateLocalPage() {
        if(!dedicatedLocal||IsDisposed||web.CoreWebView2==null||!pageReady||!ShellPolicy.WebAddress(web.CoreWebView2.Source)||welcome.Visible)
            throw new Exception("请在小序本地浏览器打开要操作的 HTTPS 网页，再继续。");
    }
    public Rectangle ContentBounds() {
        ValidateLocalPage();
        return web.RectangleToScreen(web.ClientRectangle);
    }
    public void ValidateLocalAction(string kind,string detail,int x,int y) {
        ValidateLocalPage();
        if(kind=="click"||kind=="scroll") {
            if(!ContentBounds().Contains(x,y)||(kind=="click"&&detail!="left"))
                throw new Exception("本地浏览器任务只能在网页内容区点击或滚动。");
        } else if(kind!="wait"&&(!web.ContainsFocus||detail.StartsWith("CTRL_"))) {
            throw new Exception("请先在网页内容区定位输入框；浏览器工具栏和快捷键由你操作。");
        }
    }
    public void Theme(bool dark){ShellStyle.Apply(this,dark);web.DefaultBackgroundColor=dark?Color.FromArgb(17,18,23):Color.White;}
    protected override bool ProcessCmdKey(ref Message msg,Keys keyData) {
        if(keyData==(Keys.Control|Keys.L)){address.Focus();address.SelectAll();return true;}
        return base.ProcessCmdKey(ref msg,keyData);
    }
    void Navigate(){string value=address.Text.Trim();if(!value.Contains("://"))value="https://"+value;if(!ShellPolicy.WebAddress(value)){progress.Text="请输入完整的 HTTPS 网址。";return;}if(web.CoreWebView2!=null)web.CoreWebView2.Navigate(value);}
    public static void Permission(Form owner,CoreWebView2PermissionRequestedEventArgs e,bool workspace) {
        e.State=CoreWebView2PermissionState.Deny;e.SavesInProfile=false;
        if(!ShellPolicy.WebAddress(e.Uri)||(workspace&&!ShellPolicy.Trusted(e.Uri)))return;
        if(e.PermissionKind!=CoreWebView2PermissionKind.Microphone&&e.PermissionKind!=CoreWebView2PermissionKind.Camera)return;
        string kind=e.PermissionKind==CoreWebView2PermissionKind.Microphone?"麦克风":"摄像头";
        if(MessageBox.Show(owner,new Uri(e.Uri).Host+" 请求使用"+kind+"。是否允许本次使用？","网页权限",MessageBoxButtons.YesNo,MessageBoxIcon.Question)==DialogResult.Yes)e.State=CoreWebView2PermissionState.Allow;
    }
    public static void Download(Form owner,CoreWebView2DownloadStartingEventArgs e) {
        using(var deferred=e.GetDeferral())using(var dialog=new SaveFileDialog()) {
            string name=Path.GetFileName(e.ResultFilePath);if(String.IsNullOrWhiteSpace(name))name="download";
            dialog.FileName=name;dialog.Title="保存下载文件";dialog.OverwritePrompt=true;
            if(dialog.ShowDialog(owner)==DialogResult.OK){e.ResultFilePath=dialog.FileName;e.Handled=false;}
            else e.Cancel=true;
        }
    }
}
}
