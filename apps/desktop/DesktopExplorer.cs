using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace XutiDesktop {
static partial class Native {
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    static readonly string systemExplorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
    static readonly object shellScanLock = new object();
    static Task<Dictionary<IntPtr,string>> activeShellScan;

    static bool HasClass(IntPtr handle, string name) {
        var buffer = new StringBuilder(128);
        return GetClassName(handle,buffer,buffer.Capacity)>0 && buffer.ToString()==name;
    }
    static bool IsExplorerFolderWindow(IntPtr handle) {
        if (!HasClass(handle,"CabinetWClass") && !HasClass(handle,"ExploreWClass")) return false;
        uint pid;
        if (GetWindowThreadProcessId(handle,out pid)==0) return false;
        try {
            using (var process=Process.GetProcessById((int)pid))
                return String.Equals(process.MainModule.FileName,systemExplorer,StringComparison.OrdinalIgnoreCase);
        } catch { return false; }
    }
    static string LocalFolder(string path) {
        if (String.IsNullOrEmpty(path) || path.Length<3 || !Char.IsLetter(path[0]) ||
            path[1]!=':' || path[2]!='\\') return null;
        try {
            string full=Path.GetFullPath(path);
            return full.Length>3 ? full.TrimEnd('\\') : full;
        } catch { return null; }
    }
    static string UserDesktop() {
        return LocalFolder(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
    }
    static bool SameFolder(string left,string right) {
        return left!=null && right!=null && String.Equals(left,right,StringComparison.OrdinalIgnoreCase);
    }
    static void ReleaseShellObject(object value) {
        if (value!=null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }

    // Only query folder windows belonging to the system Explorer process. A
    // multi-tab HWND with differing locations cannot prove which tab is visible.
    static Dictionary<IntPtr,string> ReadShellFolders() {
        var result=new Dictionary<IntPtr,string>();
        dynamic shell=null,windows=null;
        try {
            shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application",true));
            windows=shell.Windows();
            int count=windows.Count;
            if(count>96)return result;
            for(int i=0;i<count;i++) {
                dynamic view=null,document=null,folder=null,item=null;
                IntPtr handle=IntPtr.Zero;
                try {
                    view=windows.Item(i);
                    if(view==null)continue;
                    handle=new IntPtr((long)view.HWND);
                    if(!IsExplorerFolderWindow(handle))continue;
                    string location=view.LocationURL as string, path=null;
                    Uri uri;
                    if(!String.IsNullOrEmpty(location)) {
                        if(Uri.TryCreate(location,UriKind.Absolute,out uri) && uri.IsFile && !uri.IsUnc) path=uri.LocalPath;
                    } else {
                        document=view.Document;
                        folder=document.Folder;
                        item=folder.Self;
                        path=item.Path as string;
                    }
                    NoteShellLocation(result,handle,LocalFolder(path));
                } catch {
                    if(handle!=IntPtr.Zero)result[handle]=null;
                } finally {
                    ReleaseShellObject((object)item);ReleaseShellObject((object)folder);
                    ReleaseShellObject((object)document);ReleaseShellObject((object)view);
                }
            }
            return result;
        } finally {ReleaseShellObject((object)windows);ReleaseShellObject((object)shell);}
    }
    static void NoteShellLocation(Dictionary<IntPtr,string> views,IntPtr handle,string path) {
        string previous;
        views[handle]=views.TryGetValue(handle,out previous) && !SameFolder(previous,path) ? null : path;
    }
    static async Task<Dictionary<IntPtr,string>> ShellFolders(int waitMs=2500) {
        Task<Dictionary<IntPtr,string>> scan;
        lock(shellScanLock) {
            if(activeShellScan==null || activeShellScan.IsCompleted)
                activeShellScan=Task.Run((Func<Dictionary<IntPtr,string>>)ReadShellFolders);
            scan=activeShellScan;
        }
        if(await Task.WhenAny(scan,Task.Delay(waitMs))!=scan)
            throw new Exception("资源管理器未及时返回目录。请打开指定的文件夹后继续任务。");
        try {return await scan;}
        catch {throw new Exception("无法核对资源管理器中的桌面目录。请在本机选择目标文件夹窗口后继续。");}
    }
    static WindowChoice SelectExplorer(IntPtr own,Dictionary<IntPtr,string> folders,string target) {
        return InitialWindow(Windows(own).Where(w=>{
            string path;
            return folders.TryGetValue(w.Handle,out path) && SameFolder(path,target);
        }));
    }
    public static async Task<WindowChoice> OpenDesktopExplorer(IntPtr own, Action check) {
        check(); CheckInputDesktop();
        string desktop=UserDesktop();
        if(desktop==null || !Directory.Exists(desktop))throw new Exception("本机的桌面目录不可用，请打开目标文件夹并手动选择资源管理器窗口。");
        return await OpenExplorerDirectory(own,desktop,check);
    }
    public static async Task<WindowChoice> OpenExplorerDirectory(IntPtr own,string directory,Action check) {
        check();CheckInputDesktop();
        // A fresh Windows session can have no folder window and an uninitialized
        // Shell automation server. Launch the requested folder before querying COM.
        WindowChoice target=null;
        if(Windows(own).Any(w=>IsExplorerFolderWindow(w.Handle)))
            target=SelectExplorer(own,await ShellFolders(12000),directory);
        if(target==null) {
            check(); CheckInputDesktop();
            // Callers supply only the Windows desktop or an explicitly requested, verified physical folder.
            string argument=directory.EndsWith("\\",StringComparison.Ordinal) ? directory+"." : directory;
            using(Process.Start(new ProcessStartInfo(systemExplorer,"/n,\""+argument+"\""){UseShellExecute=false})) {}
            var elapsed=Stopwatch.StartNew();
            while(elapsed.ElapsedMilliseconds<20000 && target==null) {
                await Task.Delay(250);check();
                if(Windows(own).Any(w=>IsExplorerFolderWindow(w.Handle)))
                    target=SelectExplorer(own,await ShellFolders(12000),directory);
            }
        }
        check();CheckInputDesktop();
        if(target==null)throw new Exception("尚未核验到指定目录的资源管理器窗口。请在本机打开该目录后继续。");
        ValidateWindow(target,false);
        return target;
    }
    public static async Task<string> ExplorerLocation(WindowChoice window) {
        if(window==null || !IsExplorerFolderWindow(window.Handle))return null;
        string path;
        var folders=await ShellFolders();
        return folders.TryGetValue(window.Handle,out path) ? path : null;
    }
    public static async Task CheckDesktopExplorerStart(WindowChoice window) {
        if(!SameFolder(await ExplorerLocation(window),UserDesktop()))
            throw new Exception("资源管理器已切换目录。请回到桌面目录，再继续原任务。");
    }
    // A junction nested under Desktop could lead outside the intended folder.
    public static bool IsDesktopTree(string desktop,string path) {
        desktop=LocalFolder(desktop);
        path=LocalFolder(path);
        if(SameFolder(desktop,path))return true;
        if(desktop==null || path==null || !path.StartsWith(desktop.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))return false;
        try {
            string current=desktop;
            foreach(string component in path.Substring(desktop.TrimEnd('\\').Length+1).Split('\\')) {
                current=Path.Combine(current,component);
                if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)return false;
            }
            return true;
        } catch {return false;}
    }
    public static bool ExplorerListFocused(WindowChoice w) {
        if(!IsForeground(w) || !IsExplorerFolderWindow(w.Handle))return false;
        var info=new GuiThreadInfo{size=Marshal.SizeOf(typeof(GuiThreadInfo))};uint pid;
        if(!GetGUIThreadInfo(GetWindowThreadProcessId(w.Handle,out pid),ref info) || (info.flags&30)!=0 || info.focus==IntPtr.Zero || GetAncestor(info.focus,2)!=w.Handle)return false;
        for(IntPtr h=info.focus;h!=IntPtr.Zero && h!=w.Handle;h=GetParent(h)) {
            if(HasClass(h,"Edit") || HasClass(h,"RichEditD2DPT"))return false;
            if(HasClass(h,"SHELLDLL_DefView"))return true;
        }
        return false;
    }
    public static async Task<string> DesktopExplorerListLocation(WindowChoice window) {
        if(!ExplorerListFocused(window))return null;
        string location=await ExplorerLocation(window);
        return IsDesktopTree(UserDesktop(),location) && ExplorerListFocused(window) ? location : null;
    }
    public static async Task CheckNewFolderShortcut(WindowChoice w,string observedLocation) {
        if(observedLocation==null || !SameFolder(observedLocation,await DesktopExplorerListLocation(w)))
            throw new Exception("新建文件夹前未核验到原桌面目录的文件列表，请核对窗口后继续。");
    }
    public static void DesktopExplorerSelfTest(string fixture) {
        // The self-test uses the existing isolated fixture, never opens Explorer.
        string desktop=Directory.CreateDirectory(Path.Combine(fixture,"desktop")).FullName;
        string first=Directory.CreateDirectory(Path.Combine(desktop,"first")).FullName;
        string other=Directory.CreateDirectory(Path.Combine(fixture,"desktop-other")).FullName;
        try {
        if(!IsDesktopTree(desktop,first) || !IsDesktopTree(desktop,desktop) ||
            IsDesktopTree(desktop,other) || IsDesktopTree(desktop,Path.Combine(desktop,"..","desktop-other")) ||
            IsDesktopTree(desktop,Path.Combine(desktop,"missing")) || IsDesktopTree(null,null))
            throw new Exception("Explorer directory scope was not constrained to the selected folder");
        var views=new Dictionary<IntPtr,string>();
        var handle=new IntPtr(123);
        NoteShellLocation(views,handle,first);
        NoteShellLocation(views,handle,first.ToUpperInvariant());
        if(!SameFolder(views[handle],first))throw new Exception("The current Explorer folder was lost");
        NoteShellLocation(views,handle,other);
        NoteShellLocation(views,handle,first);
        if(views[handle]!=null)throw new Exception("An ambiguous multi-tab window retained eligibility");
        } finally {
            Directory.Delete(first);
            Directory.Delete(desktop);
            Directory.Delete(other);
        }
    }
}
}
