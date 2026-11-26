using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Automation;
using Microsoft.Win32;

namespace XutiDesktop {
static partial class Native {
    const string WeComPublisher = "Tencent Technology (Shenzhen) Company Limited";
    const string WeComClass = "WeWorkWindow";
    static readonly StringComparer WeComNames = StringComparer.OrdinalIgnoreCase;

    static string WeComPath(string value,bool displayIcon=false) {
        if(String.IsNullOrWhiteSpace(value))return null;
        value=value.Trim();
        if(displayIcon)value=Regex.Replace(value,@",\s*-?\d+\s*$","");
        if(value.Length>=2 && value[0]=='"' && value[value.Length-1]=='"')value=value.Substring(1,value.Length-2);
        if(!Regex.IsMatch(value,@"^[A-Za-z]:\\") || value.IndexOfAny(new[]{'"','\r','\n','%'})>=0 || value.IndexOf(':',2)>=0)
            return null;
        try {
            string full=Path.GetFullPath(value);
            if(!WeComNames.Equals(full,value) || !WeComNames.Equals(Path.GetFileName(full),"WXWork.exe") ||
                new DriveInfo(Path.GetPathRoot(full)).DriveType!=DriveType.Fixed)return null;
            return full;
        } catch {return null;}
    }
    static string RegisteredWeComPath(RegistryHive hive,RegistryView view,string key,string name,bool icon=false) {
        try {
            using(var registry=RegistryKey.OpenBaseKey(hive,view))
            using(var sub=registry.OpenSubKey(key))
                return sub==null ? null : WeComPath(sub.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string,icon);
        } catch {return null;}
    }
    static List<string> InstalledWeComPaths() {
        var paths=new HashSet<string>(WeComNames);
        foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})
        foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64}) {
            paths.Add(RegisteredWeComPath(hive,view,@"SOFTWARE\Tencent\WXWork","Executable"));
            paths.Add(RegisteredWeComPath(hive,view,@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WXWork.exe",""));
            foreach(string app in new[]{"企业微信","WXWork","WeCom"})
                paths.Add(RegisteredWeComPath(hive,view,@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\"+app,"DisplayIcon",true));
        }
        foreach(var dir in new[]{Environment.SpecialFolder.ProgramFilesX86,Environment.SpecialFolder.ProgramFiles}) {
            string folder=Environment.GetFolderPath(dir);
            if(folder.Length>0) {
                paths.Add(WeComPath(Path.Combine(folder,"WXWork","WXWork.exe")));
                paths.Add(WeComPath(Path.Combine(folder,"Tencent","WXWork","WXWork.exe")));
            }
        }
        return paths.Where(p=>p!=null && File.Exists(p)).ToList();
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    struct TrustFile {public uint size; public IntPtr path,handle,subject;}
    [StructLayout(LayoutKind.Sequential)]
    struct TrustData {
        public uint size; public IntPtr callback,sip;
        public uint ui,revocation,choice; public IntPtr info;
        public uint stateAction; public IntPtr state,url; public uint flags,context; public IntPtr signatureSettings;
    }
    [StructLayout(LayoutKind.Sequential)] struct TrustCertPrefix {public uint size; public IntPtr cert;}
    [DllImport("wintrust.dll",ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr hwnd,ref Guid action,ref TrustData data);
    [DllImport("wintrust.dll",ExactSpelling=true)] static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll",ExactSpelling=true)] static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data,uint signer,bool counterSigner,uint counter);
    [DllImport("wintrust.dll",ExactSpelling=true)] static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer,uint index);
    static bool VerifiedWeComFile(FileStream file) {
        // Inspect the signer of the signature that Windows actually validated, including file integrity.
        Guid policy=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        var nativeFile=new TrustFile{size=(uint)Marshal.SizeOf(typeof(TrustFile)),path=Marshal.StringToCoTaskMemUni(file.Name),handle=file.SafeFileHandle.DangerousGetHandle()};
        var data=new TrustData {size=(uint)Marshal.SizeOf(typeof(TrustData)),ui=2,choice=1,stateAction=1,flags=0x1000,info=Marshal.AllocHGlobal((int)nativeFile.size)};
        try {
            Marshal.StructureToPtr(nativeFile,data.info,false);
            if(WinVerifyTrust(new IntPtr(-1),ref policy,ref data)!=0 || data.state==IntPtr.Zero)return false;
            IntPtr provider=WTHelperProvDataFromStateData(data.state);
            IntPtr signer=provider==IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider,0,false,0);
            IntPtr leaf=signer==IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer,0);
            if(leaf==IntPtr.Zero)return false;
            IntPtr cert=((TrustCertPrefix)Marshal.PtrToStructure(leaf,typeof(TrustCertPrefix))).cert;
            if(cert==IntPtr.Zero)return false;
            using(var publisher=new X509Certificate2(cert)) {
                var meta=FileVersionInfo.GetVersionInfo(file.Name);
                return WeComNames.Equals(publisher.GetNameInfo(X509NameType.SimpleName,false),WeComPublisher) &&
                    WeComNames.Equals(meta.OriginalFilename,"WXWork.exe") &&
                    new[]{"企业微信","WeCom","WeChat Work","WeWork"}.Contains(meta.ProductName,WeComNames);
            }
        } finally {
            if(data.state!=IntPtr.Zero){data.stateAction=2;WinVerifyTrust(new IntPtr(-1),ref policy,ref data);}
            Marshal.FreeHGlobal(data.info);Marshal.FreeCoTaskMem(nativeFile.path);
        }
    }
    static Dictionary<string,FileStream> TrustedWeComFiles() {
        var accepted=new Dictionary<string,FileStream>(WeComNames);
        var installed=InstalledWeComPaths();
        foreach(string path in installed) {
            FileStream file=null;
            try {
                // A launch candidate stays open without write/delete sharing through Process.Start.
                file=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.Read);
                for(var dir=new DirectoryInfo(Path.GetDirectoryName(path));dir!=null;dir=dir.Parent)
                    if((dir.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException();
                if((File.GetAttributes(path)&FileAttributes.ReparsePoint)==0 && VerifiedWeComFile(file)) {
                    accepted.Add(path,file);file=null;
                }
            } catch(IOException) {} catch(UnauthorizedAccessException) {}
            finally {if(file!=null)file.Dispose();}
        }
        if(accepted.Count==0)throw new InputNotSent(installed.Count==0
            ? "未找到已安装的 Windows 企业微信。请确认这台电脑已安装官方客户端。"
            : "无法核验已安装企业微信的官方签名或应用身份，请检查客户端。");
        return accepted;
    }
    static WindowChoice WeComMainWindow(Dictionary<string,FileStream> installed) {
        var matches=new List<WindowChoice>();
        EnumWindows((h,unused)=>{
            try {
                if(!IsWindowVisible(h) || !HasClass(h,WeComClass) || GetWindow(h,4)!=IntPtr.Zero)return true;
                RECT size;
                if(!IsIconic(h) && (!GetWindowRect(h,out size) || size.Right-size.Left<100 || size.Bottom-size.Top<100))return true;
                uint pid;GetWindowThreadProcessId(h,out pid);
                using(var process=Process.GetProcessById((int)pid)) {
                    if(!WeComNames.Equals(process.ProcessName,"WXWork") || !installed.ContainsKey(process.MainModule.FileName))return true;
                    matches.Add(new WindowChoice{Handle=h,Pid=(int)pid,Started=process.StartTime.ToUniversalTime().Ticks,Title=Cut(Title(h),200),App="WXWork"});
                }
            } catch(InvalidOperationException) {} catch(ArgumentException) {} catch(System.ComponentModel.Win32Exception) {}
            return true;
        },IntPtr.Zero);
        return UniqueWeComMain(matches);
    }
    static WindowChoice UniqueWeComMain(List<WindowChoice> matches) {
        if(matches.Count>1)throw new InputNotSent("检测到多个企业微信主窗口，请只保留要操作的账号窗口。");
        return matches.FirstOrDefault();
    }
    public static void CheckWeComWindow(WindowChoice window) {
        if(window==null || !WeComNames.Equals(window.App,"WXWork") || !HasClass(window.Handle,WeComClass))
            throw new InputNotSent("企业微信主窗口已变化，请重新定位。");
    }
    public static async Task<WindowChoice> FocusWeCom(Action check,Action beforeLaunch,Func<Task> waitForIdle,Func<Task> checkLease) {
        check();CheckInputDesktop("企业微信任务");
        var installed=await Task.Run(()=>TrustedWeComFiles());
        try {
            check();
            var target=WeComMainWindow(installed);
            if(target==null) {
                if(installed.Count!=1)throw new InputNotSent("发现多个企业微信安装位置，请先打开要使用的企业微信。");
                string path=installed.Keys.Single();
                await waitForIdle();check();CheckInputDesktop("企业微信任务");beforeLaunch();
                // The official, no-argument startup also asks a running tray instance to show its main window.
                // Do not show arbitrary hidden WeWorkWindow/utility handles.
                using(Process.Start(new ProcessStartInfo(path){UseShellExecute=false,WorkingDirectory=Path.GetDirectoryName(path)})) {}
                for(int i=0;i<60 && target==null;i++) {
                    await Task.Delay(250);await checkLease();check();CheckInputDesktop("企业微信任务");target=WeComMainWindow(installed);
                }
                if(target==null)throw new InputNotSent("已请求打开企业微信，暂未检测到可操作的主窗口。请检查托盘或登录状态。");
            }
            await waitForIdle();check();CheckWeComWindow(target);ValidateWindow(target,false,true);
            if(IsIconic(target.Handle)) {
                ShowWindowAsync(target.Handle,9);
                for(int i=0;i<15 && IsIconic(target.Handle);i++){await Task.Delay(100);check();}
            }
            if(!IsForeground(target))await waitForIdle();
            check();CheckInputDesktop("企业微信任务");ValidateWindow(target,false);
            if(!IsForeground(target))SetForegroundWindow(target.Handle);
            for(int i=0;i<15 && !IsForeground(target);i++){await Task.Delay(100);check();}
            check();CheckInputDesktop("企业微信任务");CheckWeComWindow(target);
            if(!IsForeground(target))throw new InputNotSent("已找到企业微信，Windows 暂未允许切换到其主窗口。请打开任务栏中的企业微信后继续。");
            ValidateWindow(target,true);RefreshTitle(target);
            if(String.IsNullOrWhiteSpace(target.Title))target.Title="企业微信";
            return target;
        } finally {foreach(var file in installed.Values)file.Dispose();}
    }

    public static void CheckWeComAction(Dictionary<string,object> action,bool popup,string inputPurpose="") {
        string kind=S(action,"kind");
        if(kind=="wait")return;
        if(!popup) {
            if(kind=="scroll" || (kind=="click" && S(action,"button")=="left"))return;
            if(kind=="key" && new[]{"ESC","UP","DOWN","LEFT","RIGHT","HOME","END","PAGEUP","PAGEDOWN"}.Contains(S(action,"key")))return;
            if(kind=="type" && (inputPurpose=="search" || inputPurpose=="draft") && !S(action,"text").Any(c=>Char.IsControl(c)||c=='\u2028'||c=='\u2029'))return;
        }
        throw new InputNotSent("企业微信任务只支持主窗口内核验过的单击、导航、滚动和单行输入，发送消息由你完成。");
    }
    static readonly HashSet<string> WeComNavigation = new HashSet<string>(new[]{"搜索","搜索联系人","搜索聊天记录","通讯录","联系人","消息","会话","Search","Contacts","Chats","Messages"},WeComNames);
    static bool WeComInputMatches(string purpose,string identity) {
        if(String.IsNullOrEmpty(purpose))return true;
        if(Regex.IsMatch(identity,@"验证码|密码|账号|帐号|登录|账户|付款|授权|password|login|account|credential|secret|verify",RegexOptions.IgnoreCase))return false;
        bool search=Regex.IsMatch(identity,"搜索|search",RegexOptions.IgnoreCase);
        bool draft=Regex.IsMatch(identity,"输入消息|消息输入|编辑消息|聊天输入|输入聊天|撰写消息|chat.?input|message.?input|message.?edit|chat.?rich.?edit|compose|type a message",RegexOptions.IgnoreCase);
        return purpose=="search"?search && !draft:purpose=="draft" && draft && !search;
    }
    static void CheckWeComControl(WindowChoice window,AutomationElement element,string inputPurpose) {
        bool typing=inputPurpose.Length>0;
        // A custom-drawn pane with an unknown target is never a substitute for a verified edit or contact row.
        bool eligible=false,foundRole=false;int depth=0;
        for(var part=element;part!=null && depth++<24;part=TreeWalker.RawViewWalker.GetParent(part)) {
            var info=part.Current;
            if(info.ProcessId!=window.Pid || info.IsPassword || !info.IsEnabled)break;
            if(info.NativeWindowHandle!=0 && new IntPtr(info.NativeWindowHandle)==window.Handle) {
                if(eligible)return;
                break;
            }
            var role=info.ControlType;string name=(info.Name??"").Trim();
            if(Sensitive.IsMatch(name) || Regex.IsMatch(name,"提交|确认发送|send message|submit",RegexOptions.IgnoreCase))break;
            if(foundRole)continue;
            if(role==ControlType.Edit || (typing && role==ControlType.Document)) {
                object pattern;
                bool hasValue=part.TryGetCurrentPattern(ValuePattern.Pattern,out pattern);
                string identity=name+" "+info.AutomationId+" "+info.ClassName+" "+info.HelpText;
                eligible=(role==ControlType.Edit || hasValue) && (!hasValue || !((ValuePattern)pattern).Current.IsReadOnly) && WeComInputMatches(inputPurpose,identity);
                foundRole=true;
            } else if(role==ControlType.Button || role==ControlType.Hyperlink || role==ControlType.MenuItem ||
                      role==ControlType.TabItem || role==ControlType.ListItem || role==ControlType.TreeItem || role==ControlType.DataItem) {
                eligible=!typing && (WeComNavigation.Contains(name) || (name.Length>0 &&
                    (role==ControlType.ListItem || role==ControlType.TreeItem || role==ControlType.DataItem)));
                foundRole=true;
            }
        }
        throw new InputNotSent(typing ? "无法核验企业微信当前的编辑框，请核对搜索框或聊天草稿。" :
            "无法核验企业微信控件为搜索、联系人或编辑入口；请在主窗口核对目标。");
    }
    public static void WeComSelfTest(string fixture) {
        var path=Path.Combine(fixture,"WXWork.exe");
        if(WeComPath("\""+path+"\",0",true)!=path || WeComPath("\""+path+"\" --help")!=null ||
            WeComPath(@"\\server\share\WXWork.exe")!=null || WeComPath(Path.ChangeExtension(path,"cmd"))!=null)
            throw new Exception("Unsafe WeCom registry candidate accepted");
        using(var input=File.OpenRead(typeof(Native).Assembly.Location))
            if(VerifiedWeComFile(input))throw new Exception("Unrelated application accepted as signed WeCom");
        if(!BlockedApps.Contains("TextInputHost") || !WeComInputMatches("search","SearchEdit") ||
            WeComInputMatches("draft","SearchEdit") || !WeComInputMatches("draft","ChatInputEdit") ||
            WeComInputMatches("draft","Custom Edit") || WeComInputMatches("search","AccountSearch") ||
            WeComInputMatches("draft","发送按钮") || WeComInputMatches("draft","Search ChatInputEdit"))
            throw new Exception("WeCom control purpose or input host validation failed");
        var single=new WindowChoice{App="WXWork"};
        if(UniqueWeComMain(new List<WindowChoice>())!=null || UniqueWeComMain(new List<WindowChoice>{single})!=single)
            throw new Exception("WeCom main window selection failed");
        Action<Action> mustBlock=act=>{try{act();}catch(InputNotSent){return;}throw new Exception("Unsafe WeCom action accepted");};
        mustBlock(()=>UniqueWeComMain(new List<WindowChoice>{single,new WindowChoice()}));
        mustBlock(()=>CheckWeComAction(new Dictionary<string,object>{{"kind","key"},{"key","ENTER"}},false));
        mustBlock(()=>CheckWeComAction(new Dictionary<string,object>{{"kind","type"},{"text","hello\rworld"}},false,"draft"));
        mustBlock(()=>CheckWeComAction(new Dictionary<string,object>{{"kind","type"},{"text","hello"}},false));
        mustBlock(()=>CheckWeComAction(new Dictionary<string,object>{{"kind","switch_window"}},false));
        CheckWeComAction(new Dictionary<string,object>{{"kind","type"},{"text","hello"}},false,"draft");
    }
}
}
