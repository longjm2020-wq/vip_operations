using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

// Loaded by the Windows CI runner only. Use the built XUTI binary, Explorer's
// real selection and its real clipboard owner. No server token or model needed.
public class ExplorerCopySmoke {
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetUserObjectInformation(
        IntPtr handle, int index, out StationFlags value, uint size, out uint needed);
    [StructLayout(LayoutKind.Sequential)] struct StationFlags { public int inherit, reserved, flags; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);

    public static string UnavailableDesktop() {
        if(Process.GetCurrentProcess().SessionId==0)return "runner is in Windows service session 0";
        StationFlags station;uint needed;
        if(!GetUserObjectInformation(GetProcessWindowStation(),1,out station,(uint)Marshal.SizeOf(typeof(StationFlags)),out needed))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if((station.flags&1)==0)return "the runner window station is not interactive";
        var desktop=OpenInputDesktop(0,false,1); // DESKTOP_READOBJECTS
        if(desktop==IntPtr.Zero)return "the runner cannot access the input desktop (Win32 "+Marshal.GetLastWin32Error()+")";
        CloseDesktop(desktop);return null;
    }

    readonly Type native, copyType;
    readonly Action check=delegate {};
    object session;
    public ExplorerCopySmoke(string executable) {
        var assembly=Assembly.LoadFrom(executable);
        native=assembly.GetType("XutiDesktop.Native",true);
        copyType=assembly.GetType("XutiDesktop.Native+ExplorerCopy",true);
    }
    object Call(string name,params object[] arguments) {
        return copyType.GetMethod(name).Invoke(session,arguments);
    }
    object Native(string name,params object[] arguments) {
        return native.GetMethod(name).Invoke(null,arguments);
    }
    async Task Activate(object window) {
        var handle=(IntPtr)window.GetType().GetField("Handle").GetValue(window);
        if(!(bool)Native("IsForeground",window) && !(bool)Native("SetForegroundWindow",handle))
            throw new Exception("Explorer could not bring the approved fixture window to the foreground");
        await Task.Delay(500);
        Native("ValidateWindow",window,true,false);
    }
    async Task Shortcut(object window,string key,string expected) {
        var shot=Native("Capture",window,null);
        if(shot.GetType().GetField("Popup").GetValue(shot)!=null)throw new Exception("Explorer has a popup");
        var evidence=await (Task<string>)Call("Observe",window);
        if(evidence!=expected)throw new Exception("Explorer did not prove file selection/clipboard for "+key);
        shot.GetType().GetField("FileShortcut").SetValue(shot,evidence);
        var action=new Dictionary<string,object>{{"kind","key"},{"key",key},{"description","CI file shortcut"}};
        Call("VerifyOtherAction",action,window);
        await (Task)Native("Execute",window,shot,action,check,null,session);
    }
    async Task Transfer(string fixture,IntPtr own) {
        Console.WriteLine("Interactive session {0}; shell HWND before fixture startup: {1}",
            Process.GetCurrentProcess().SessionId,GetShellWindow());
        if(GetShellWindow()==IntPtr.Zero) {
            // GitHub's disposable interactive logon may start the runner before
            // its normal Explorer shell. Start only the OS-installed default shell.
            var explorer=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe");
            using(Process.Start(new ProcessStartInfo(explorer){UseShellExecute=false})) {}
            var wait=Stopwatch.StartNew();
            while(GetShellWindow()==IntPtr.Zero && wait.ElapsedMilliseconds<20000)await Task.Delay(250);
            Console.WriteLine("Shell HWND after startup: {0}",GetShellWindow());
        }
        var source=Directory.CreateDirectory(Path.Combine(fixture,"source")).FullName;
        var target=Directory.CreateDirectory(Path.Combine(fixture,"target")).FullName;
        var nested=Directory.CreateDirectory(Path.Combine(source,"nested")).FullName;
        File.WriteAllText(Path.Combine(nested,"excluded.txt"),"exclude");
        var files=new Dictionary<string,byte[]> {
            {"first.txt",Guid.NewGuid().ToByteArray()},
            {"second.bin",Guid.NewGuid().ToByteArray()}
        };
        foreach(var pair in files)File.WriteAllBytes(Path.Combine(source,pair.Key),pair.Value);
        var spec=new Dictionary<string,object>{{"selection","files"},{"source",source},{"destination",target}};
        Console.WriteLine("Verifying the disposable local source and target");
        session=Activator.CreateInstance(copyType,new object[]{spec,"copy all files from "+source+" to "+target});
        Console.WriteLine("Opening source and target in Explorer");
        await (Task)Call("Open",own,check);
        var from=copyType.GetProperty("SourceWindow").GetValue(session,null);
        var to=copyType.GetProperty("DestinationWindow").GetValue(session,null);
        Console.WriteLine("Verifying and selecting the source files");
        await Activate(from);
        await (Task)Call("CheckStart",from);
        await (Task)Call("SelectSourceFiles",check);
        Console.WriteLine("Dispatching COPY with verified Explorer selection");
        await Shortcut(from,"COPY","copy");
        var switchAction=new Dictionary<string,object>{{"kind","switch_window"},{"windowId",to.GetType().GetField("Id").GetValue(to)}};
        Call("VerifyOtherAction",switchAction,from);
        Console.WriteLine("Switching to the destination file list");
        await Activate(to);
        await (Task)Call("PrepareSwitchedWindow",to,check);
        Console.WriteLine("Dispatching PASTE with verified clipboard metadata");
        await Shortcut(to,"PASTE","paste");
        foreach(var pair in files) {
            if(!File.ReadAllBytes(Path.Combine(target,pair.Key)).SequenceEqual(pair.Value) ||
                !File.ReadAllBytes(Path.Combine(source,pair.Key)).SequenceEqual(pair.Value))
                throw new Exception("The copied and retained fixture contents must match");
        }
        if(Directory.GetFileSystemEntries(target).Length!=files.Count || !File.Exists(Path.Combine(nested,"excluded.txt")))
            throw new Exception("Explorer copied unexpected items");
    }
    public void Run(string fixture) {
        Exception failure=null;
        using(var owner=new Form {Text="XUTI isolated Explorer fixture"}) {
            owner.Shown+=async delegate {
                try {await Transfer(fixture,owner.Handle);}
                catch(Exception e) {failure=e;}
                finally {owner.Close();}
            };
            Application.Run(owner);
        }
        if(failure!=null)throw new Exception("Actual Explorer shortcut smoke failed",failure);
    }
}
