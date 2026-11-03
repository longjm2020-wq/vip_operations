using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace XutiDesktop {
static class ShellPolicy {
    public const string Origin = "https://vip-web-production.up.railway.app";
    public const string Version = "1.1.0";
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
        if(channel!="xuti-desktop"||!new[]{"status","pair","show-tasks","theme"}.Contains(action)) throw new Exception("不支持的客户端请求");
        if(action=="theme") {
            if(d.Keys.Any(k=>!new[]{"channel","action","value"}.Contains(k))||!new[]{"light","dark"}.Contains(AssistantForm.S(d,"value"))) throw new Exception("主题无效");
        } else {
            Guid id;
            if(!Guid.TryParse(AssistantForm.S(d,"id"),out id)||d.Keys.Any(k=>!new[]{"channel","action","id","code"}.Contains(k))) throw new Exception("请求无效");
            if(action=="pair"&&!Regex.IsMatch(AssistantForm.S(d,"code"),"^[a-f0-9]{32}$")) throw new Exception("配对码无效");
            if(action!="pair"&&d.ContainsKey("code")) throw new Exception("请求无效");
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
            foreach(string bad in new[]{j.Serialize(new{channel="xuti-desktop",action="shell",id=Guid.NewGuid().ToString()}),j.Serialize(new{channel="xuti-desktop",action="pair",id=Guid.NewGuid().ToString(),code="bad"}),j.Serialize(new{channel="xuti-desktop",action="status",id=Guid.NewGuid().ToString(),token="private"})}) {
                bool rejected=false;try{Message(Origin,Origin,bad);}catch{rejected=true;}if(!rejected)throw new Exception("Invalid bridge message accepted");
            }
            bool denied=false;try{Message("https://example.com",Origin,valid);}catch{denied=true;}if(!denied)throw new Exception("External page bridge accepted");
            Console.WriteLine("Desktop origin, navigation and bridge validation: passed");return 0;
        } catch(Exception e){Console.WriteLine(e.Message);return 1;}
    }
}

static class ShellStyle {
    public static readonly Color Blue=Color.FromArgb(70,88,239);
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
    readonly FlowLayoutPanel header=new FlowLayoutPanel{Dock=DockStyle.Top,Height=62,Padding=new Padding(14,10,12,8),WrapContents=false};
    readonly Label footer=new Label{Dock=DockStyle.Bottom,Height=30,Padding=new Padding(18,6,0,0),AutoEllipsis=true};
    readonly Panel notice=new Panel{Dock=DockStyle.Fill,Visible=false,Padding=new Padding(36)};
    readonly Label noticeText=new Label{Dock=DockStyle.Top,Height=100,Font=new Font("Microsoft YaHei UI",12)};
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly List<BrowserWindow> browsers=new List<BrowserWindow>();
    CoreWebView2Environment environment;
    bool ready,initializing,exiting,closePending,dark;
    long navigation;
    string pendingUrl=ShellPolicy.Origin+"/my-workspace";
    Button workButton,taskButton;

    public DesktopShell() {
        Text="小序 · 桌面工作台";Width=1340;Height=900;MinimumSize=new Size(980,650);
        StartPosition=FormStartPosition.CenterScreen;Font=new Font("Microsoft YaHei UI",10);
        AutoScaleMode=AutoScaleMode.Dpi;
        workspace.KeyDown+=(s,e)=>{
            Action action=Shortcut(e.KeyData);if(action==null)return;
            e.Handled=true;e.SuppressKeyPress=true;BeginInvoke(action);
        };
        try{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}
        var brand=new Label{Text="XUTI  /  小序",AutoSize=false,Width=165,Height=40,TextAlign=ContentAlignment.MiddleLeft,Font=new Font("Microsoft YaHei UI",15,FontStyle.Bold)};
        header.Controls.Add(brand);
        workButton=ShellStyle.Button("工作台",()=>ShowWorkspace(null));
        taskButton=ShellStyle.Button("电脑任务",ShowTasks);
        header.Controls.Add(workButton);
        header.Controls.Add(ShellStyle.Button("打开网页",()=>OpenBrowser(null)));
        header.Controls.Add(taskButton);
        header.Controls.Add(ShellStyle.Button("连接本机",()=>ShowWorkspace("/my-workspace?assistant=desktop")));
        header.Controls.Add(ShellStyle.Button("刷新",()=>{if(ready){ShowWorkspace(null);workspace.Reload();}else{var ignored=Initialize();}}));
        header.Controls.Add(ShellStyle.Button("使用帮助",()=>ShowWorkspace("/help?chapter=39-assistant-desktop.md")));
        workPanel.Controls.Add(workspace);workPanel.Controls.Add(notice);
        notice.Controls.Add(noticeText);
        var actions=new FlowLayoutPanel{Dock=DockStyle.Top,Height=52};
        actions.Controls.Add(ShellStyle.Button("重新连接",()=>{if(ready)workspace.CoreWebView2.Navigate(pendingUrl);else{var ignored=Initialize();}}));
        actions.Controls.Add(ShellStyle.Button("在浏览器中打开",()=>OpenSystem(ShellPolicy.Origin+"/my-workspace")));
        actions.Controls.Add(ShellStyle.Button("安装网页运行环境",()=>OpenSystem("https://developer.microsoft.com/microsoft-edge/webview2/")));
        notice.Controls.Add(actions);actions.BringToFront();
        taskPanel.Controls.Add(assistant);
        Controls.Add(workPanel);Controls.Add(taskPanel);Controls.Add(footer);Controls.Add(header);
        assistant.Changed+=()=>UpdateFooter();
        Shown+=async(s,e)=>{assistant.Show();assistant.StartEngine();await Initialize();};
        FormClosing+=async(s,e)=>{
            if(exiting)return;
            e.Cancel=true;if(closePending)return;closePending=true;
            await Task.WhenAny(assistant.EndSession(),Task.Delay(3000));
            assistant.Shutdown();exiting=true;BeginInvoke(new Action(Close));
        };
        FormClosed+=(s,e)=>{foreach(var b in browsers.ToArray())b.Close();assistant.Dispose();workspace.Dispose();};
        ApplyTheme(false);brand.ForeColor=ShellStyle.Blue;UpdateFooter();
    }
    public static int CheckRuntime() {
        try{Console.WriteLine("WebView2 runtime: "+CoreWebView2Environment.GetAvailableBrowserVersionString());return 0;}
        catch{Console.WriteLine("WebView2 runtime missing");return 1;}
    }
    void UpdateFooter() {
        if(IsDisposed)return;
        footer.Text="小序 "+ShellPolicy.Version+"   ·   "+assistant.ConnectionText+"   ·   "+assistant.TaskText;
    }
    void ApplyTheme(bool value) {
        dark=value;ShellStyle.Apply(this,dark);
        workspace.DefaultBackgroundColor=dark?Color.FromArgb(17,18,23):Color.FromArgb(247,248,253);
        foreach(var b in browsers)b.Theme(dark);
        workButton.ForeColor=ShellStyle.Blue;taskButton.ForeColor=ShellStyle.Blue;
    }
    void ShowTasks(){taskPanel.Visible=true;workPanel.Visible=false;taskPanel.BringToFront();}
    Action Shortcut(Keys keyData) {
        if(keyData==(Keys.Control|Keys.D1))return ()=>ShowWorkspace(null);
        if(keyData==(Keys.Control|Keys.D2))return ()=>OpenBrowser(null);
        if(keyData==(Keys.Control|Keys.D3))return ShowTasks;
        if(keyData==(Keys.Control|Keys.Shift|Keys.L))return ()=>ShowWorkspace("/my-workspace?assistant=desktop");
        return null;
    }
    protected override bool ProcessCmdKey(ref Message msg,Keys keyData) {
        Action action=Shortcut(keyData);if(action!=null){action();return true;}
        return base.ProcessCmdKey(ref msg,keyData);
    }
    void ShowWorkspace(string path) {
        workPanel.Visible=true;taskPanel.Visible=false;workPanel.BringToFront();
        if(path!=null){pendingUrl=ShellPolicy.Origin+path;if(ready)workspace.CoreWebView2.Navigate(pendingUrl);}
    }
    void ShowNotice(string text){noticeText.Text=text;notice.Visible=true;notice.BringToFront();}
    void OpenSystem(string url) {
        if(!ShellPolicy.WebAddress(url))return;
        try{Process.Start(new ProcessStartInfo(url){UseShellExecute=true});}catch{ShowNotice("无法打开系统浏览器，请检查默认浏览器设置。");}
    }
    void OpenBrowser(string url) {
        if(environment==null){ShowNotice("网页环境尚未准备好，请稍后重试。");return;}
        if(BrowserWindow.WindowCount>=8){MessageBox.Show(this,"请先关闭不需要的网页窗口，最多同时打开8个。","小序");return;}
        var window=new BrowserWindow(environment,url,dark);
        browsers.Add(window);window.FormClosed+=(s,e)=>browsers.Remove(window);window.Show();
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
            core.NavigationCompleted+=(s,e)=>{if(e.IsSuccess)notice.Visible=false;else ShowNotice("暂时无法连接工作台。请检查网络，再点击「重新连接」。电脑任务可从顶部入口查看。");};
            core.NewWindowRequested+=(s,e)=>{e.Handled=true;if(e.IsUserInitiated&&ShellPolicy.WebAddress(e.Uri))OpenBrowser(e.Uri);};
            core.PermissionRequested+=(s,e)=>BrowserWindow.Permission(this,e,true);
            core.DownloadStarting+=(s,e)=>BrowserWindow.Download(this,e);
            core.ProcessFailed+=(s,e)=>ShowNotice("网页进程已停止，请关闭并重新打开小序。电脑任务可在顶部暂停或停止。");
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
                Object.defineProperty(window, 'xutiDesktop', {value: Object.freeze({version:'1.1.0'}), writable:false});
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
            if(action=="pair") {
                await assistant.PairCode(AssistantForm.S(data,"code"));
                if(version!=navigation){await assistant.Disconnect();return;}
            }
            if(action=="show-tasks")ShowTasks();
            Reply(version,new{channel="xuti-desktop",id,ok=true,data=new{version=ShellPolicy.Version,connected=assistant.Connected,deviceId=assistant.DeviceId}});
        } catch(Exception ex) {
            if(id.Length>0)Reply(version,new{channel="xuti-desktop",id,ok=false,error=ex is ApiFailure?ex.Message:"未能连接本机，请在电脑任务中检查连接，或重新生成配对码。"});
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
    string initial;
    public BrowserWindow(CoreWebView2Environment env,string url,bool dark) {
        WindowCount++;
        environment=env;initial=url;Text="小序网页";Width=1180;Height=810;MinimumSize=new Size(900,600);StartPosition=FormStartPosition.CenterScreen;
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
                core.NavigationStarting+=(o,a)=>{if(!ShellPolicy.WebAddress(a.Uri)&&a.Uri!="about:blank"){a.Cancel=true;progress.Text="仅支持 HTTPS 网页地址。";}else welcome.Visible=false;};
                core.SourceChanged+=(o,a)=>{if(ShellPolicy.WebAddress(core.Source))address.Text=core.Source;};
                core.DocumentTitleChanged+=(o,a)=>{Text="小序网页 · "+core.DocumentTitle;};
                core.NavigationCompleted+=(o,a)=>{progress.Text=a.IsSuccess?"在「电脑任务」选择这个窗口后，小序可以按任务操作网页。":"网页加载失败，请检查地址或网络后重试。";};
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
                if(initial!=null){address.Text=initial;Navigate();}
                else {welcome.Visible=true;welcome.BringToFront();address.Focus();}
            }catch{progress.Text="网页环境未能启动，请重启小序后再试。";}
        };
        FormClosed+=(s,e)=>{WindowCount--;byte ignored;Native.BrowserWindows.TryRemove(Handle,out ignored);web.Dispose();};
    }
    async Task EnsureReady(){for(int i=0;i<100;i++){if(web.CoreWebView2!=null)return;await Task.Delay(100);}throw new Exception("网页启动超时");}
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
