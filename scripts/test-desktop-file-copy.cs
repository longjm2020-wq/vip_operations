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
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetUserObjectInformation(
        IntPtr handle, int index, out StationFlags value, uint size, out uint needed);
    [StructLayout(LayoutKind.Sequential)] struct StationFlags { public int inherit, reserved, flags; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
    static extern int SHSetKnownFolderPath(ref Guid folder,uint flags,IntPtr token,string path);

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
    // This fixture has no dependency on a desktop or Shell. It exercises
    // the production write handles, collision behavior and partial cleanup.
    public async Task BackgroundExisting(string fixture) {
        var source=Directory.CreateDirectory(Path.Combine(fixture,"background-src")).FullName;
        var target=Directory.CreateDirectory(Path.Combine(fixture,"background-dst")).FullName;
        string file=Path.Combine(source,"large.bin"),final=Path.Combine(target,"large.bin"),receipt=null;
        byte[] data=new byte[524288];new Random(23).NextBytes(data);File.WriteAllBytes(file,data);
        var spec=new Dictionary<string,object>{{"source",file},{"destination",target},{"selection","file"}};
        Func<string> read=()=>receipt;Action<string> write=s=>receipt=s;
        Func<object> fresh=()=>Activator.CreateInstance(copyType,new object[]{spec,"copy "+file+" to "+target,"background-fixture",read,write});
        int ticks=0;
        Func<Task> pause=()=>{if(++ticks==4)throw new OperationCanceledException("fixture pause");return Task.FromResult(true);};
        session=fresh();bool canceled=false;
        try {await (Task)Call("RunBackground",Guid.NewGuid().ToString(),pause,check);}catch(OperationCanceledException){canceled=true;}
        if(!canceled || Directory.GetFileSystemEntries(target).Length!=0)throw new Exception("Stopping exposed a partial file");
        session=fresh();ticks=0;
        Func<Task> collision=()=>{if(++ticks==4)File.WriteAllText(final,"existing");return Task.FromResult(true);};
        bool blocked=false;
        try {await (Task)Call("RunBackground",Guid.NewGuid().ToString(),collision,check);}catch(IOException){blocked=true;}
        if(!blocked || File.ReadAllText(final)!="existing" || Directory.GetFileSystemEntries(target).Length!=1)
            throw new Exception("Concurrent creation was overwritten or staging was leaked");
        File.Delete(final);session=fresh();Func<Task> authorized=()=>Task.FromResult(true);
        await (Task)Call("RunBackground",Guid.NewGuid().ToString(),authorized,check);
        if(!data.SequenceEqual(File.ReadAllBytes(final)))throw new Exception("Existing-target background file copy failed");
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
        var shot=await Task.Run(()=>Native("Capture",window,null,true));
        if(shot.GetType().GetField("Popup").GetValue(shot)!=null)throw new Exception("Explorer has a popup");
        var evidence=await (Task<string>)Call("Observe",window);
        if(evidence!=expected)throw new Exception("Explorer did not prove file selection/clipboard for "+key);
        shot.GetType().GetField("FileShortcut").SetValue(shot,evidence);
        var action=new Dictionary<string,object>{{"kind","key"},{"key",key},{"description","CI file shortcut"}};
        Call("VerifyOtherAction",action,window);
        await (Task)Native("Execute",window,shot,action,check,null,session,check);
    }
    async Task Transfer(string fixture,IntPtr own) {
        await BackgroundExisting(fixture);
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
        await RunShortcuts();
        foreach(var pair in files) {
            if(!File.ReadAllBytes(Path.Combine(target,pair.Key)).SequenceEqual(pair.Value) ||
                !File.ReadAllBytes(Path.Combine(source,pair.Key)).SequenceEqual(pair.Value))
                throw new Exception("The copied and retained fixture contents must match");
        }
        if(Directory.GetFileSystemEntries(target).Length!=files.Count || !File.Exists(Path.Combine(nested,"excluded.txt")))
            throw new Exception("Explorer copied unexpected items");
        await Compound(fixture,own,source);
    }
    async Task RunShortcuts() {
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
    }
    static void MustBlock(Action act,string reason) {
        try {act();}
        catch(Exception error) {if(error.GetBaseException().GetType().Name=="InputNotSent")return;throw;}
        throw new Exception(reason);
    }
    async Task Compound(string fixture,IntPtr own,string source) {
        var redirected=Directory.CreateDirectory(Path.Combine(fixture,"redirected-desktop")).FullName;
        var original=Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var desktopId=new Guid("B4BFCC3A-DB2C-424C-B029-7FE99A87C641");
        Marshal.ThrowExceptionForHR(SHSetKnownFolderPath(ref desktopId,0,IntPtr.Zero,redirected));
        try {
            if(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)!=redirected)
                throw new Exception("The disposable Desktop redirection was not observed");
            string name="自动化112601",dest=Path.Combine(redirected,name),receiptPath=Path.Combine(fixture,"receipt.txt");
            string instruction="在我的电脑桌面新建文件夹\""+name+"\"，并将路径"+source+"下的内容复制进来。";
            var spec=new Dictionary<string,object>{{"selection","contents"},{"source",source},{"destination",name},{"destinationKind","newDesktopFolder"}};
            Func<string> read=()=>File.Exists(receiptPath)?File.ReadAllText(receiptPath):"";
            Action<string> write=value=>File.WriteAllText(receiptPath,value);
            Func<string,object> fresh=scope=>Activator.CreateInstance(copyType,new object[]{spec,instruction,scope,read,write});
            Directory.CreateDirectory(Path.Combine(source,"nested","empty"));
            string hidden=Path.Combine(source,"hidden.txt");File.WriteAllText(hidden,"fixture");
            File.SetAttributes(hidden,FileAttributes.Hidden);
            MustBlock(()=>fresh("A"),"Hidden input was silently omitted");
            File.SetAttributes(hidden,FileAttributes.Normal);File.Delete(hidden);
            if(Directory.Exists(dest))throw new Exception("Invalid source created a desktop folder");
            Directory.CreateDirectory(dest);
            MustBlock(()=>fresh("A"),"Preexisting destination was accepted");
            Directory.Delete(dest);
            session=fresh("A");
            await (Task)Call("Open",own,check);
            if(Directory.Exists(dest))throw new Exception("A destination was created before authorization");
            Console.WriteLine("Creating the verified desktop target after authorization");
            await (Task)Call("PrepareAuthorizedDestination",own,check);
            MustBlock(()=>fresh("other-task"),"Another task adopted a desktop folder");
            Directory.Move(dest,dest+"-saved");Directory.CreateDirectory(dest);
            MustBlock(()=>fresh("A"),"Replacement destination was adopted");
            Directory.Delete(dest);Directory.Move(dest+"-saved",dest);
            Console.WriteLine("Resuming in the original desktop target without another mkdir");
            session=fresh("A");
            await (Task)Call("Open",own,check);
            await (Task)Call("PrepareAuthorizedDestination",own,check);
            await RunShortcuts();
            foreach(var path in Directory.GetFiles(source,"*",SearchOption.AllDirectories)) {
                string relative=path.Substring(source.Length+1);
                if(!File.ReadAllBytes(path).SequenceEqual(File.ReadAllBytes(Path.Combine(dest,relative))))
                    throw new Exception("A nested or root file was not correctly copied");
            }
            if(!Directory.Exists(Path.Combine(dest,"nested","empty")) || Directory.GetFileSystemEntries(redirected).Length!=1)
                throw new Exception("Empty directory missing or duplicate desktop folder");
            MustBlock(()=>fresh("A"),"A paste was replayable after successful transfer");
            Console.WriteLine("Compound desktop file copy passed: redirected Desktop, exclusive create, same-task resume, full tree and no duplicate paste");
            string delayed=Path.Combine(dest,"first.txt"),outside=Path.Combine(fixture,"delayed-file");
            File.Move(delayed,outside);
            string cmd=Guid.NewGuid().ToString();
            object old=copyType.GetMethod("ForVerification").Invoke(null,new object[]{spec,instruction,"A",read,cmd});
            var waiting=(Task)copyType.GetMethod("VerifyPastedFiles").Invoke(old,new object[]{check});
            await Task.Delay(13000);
            if(waiting.IsCompleted)throw new Exception("An incomplete old paste must wait beyond twelve seconds");
            File.Move(outside,delayed);await waiting;
            Console.WriteLine("Restored 1.2.13 paste receipt and verified a delayed file without replay");
            await BackgroundFixture(fixture,own,redirected);
        } finally {Marshal.ThrowExceptionForHR(SHSetKnownFolderPath(ref desktopId,0,IntPtr.Zero,original));}
    }
    async Task BackgroundFixture(string fixture,IntPtr own,string desktop) {
        var source=Directory.CreateDirectory(Path.Combine(fixture,"AI0520")).FullName;
        var child=Directory.CreateDirectory(Path.Combine(source,"samples")).FullName;
        Directory.CreateDirectory(Path.Combine(child,"empty"));
        Directory.CreateDirectory(Path.Combine(source,"catalog"));
        for(int i=0;i<417;i++)File.WriteAllText(Path.Combine(child,"item-"+i+".txt"),Guid.NewGuid().ToString());
        string name="自动化归档",destination=Path.Combine(desktop,name),receipt=null,attempt=Guid.NewGuid().ToString();
        string instruction="在我的电脑桌面新建文件夹\""+name+"\"，并将路径"+source+"下的内容复制进来。";
        var spec=new Dictionary<string,object>{{"selection","contents"},{"source",source},{"destination",name},{"destinationKind","newDesktopFolder"}};
        Func<string> read=()=>receipt;Action<string> write=s=>receipt=s;
        Func<object> fresh=()=>Activator.CreateInstance(copyType,new object[]{spec,instruction,"old-task:original-grant",read,write});
        session=fresh();
        await (Task)Call("Open",own,check);await (Task)Call("PrepareAuthorizedDestination",own,check);
        var old=copyType.GetMethod("ForVerification").Invoke(null,new object[]{spec,instruction,"old-task:original-grant",read,Guid.NewGuid().ToString()});
        if(!(bool)copyType.GetProperty("VerifiedUnsent").GetValue(old,null))throw new Exception("Missing original ready evidence");
        session=fresh();
        using(var typing=new Form{Text="Independent typing window"})
        using(var edit=new TextBox{Dock=DockStyle.Fill}) {
            typing.Controls.Add(edit);typing.Show();typing.Activate();edit.Focus();await Task.Delay(300);
            uint clipboard=GetClipboardSequenceNumber();
            if(GetForegroundWindow()!=typing.Handle)throw new Exception("Independent typing window did not get focus");
            int checks=0;
            Func<Task> lease=()=>{
                if(++checks==30 || checks==120)SendKeys.SendWait("x");
                if(GetForegroundWindow()!=typing.Handle || GetClipboardSequenceNumber()!=clipboard)
                    throw new Exception("Background copy touched foreground or clipboard");
                return Task.FromResult(true);
            };
            await (Task)Call("RunBackground",attempt,lease,check);
            if(edit.Text!="xx" || GetForegroundWindow()!=typing.Handle || GetClipboardSequenceNumber()!=clipboard ||
                Directory.GetFiles(destination,"*",SearchOption.AllDirectories).Length!=417 ||
                !Directory.Exists(Path.Combine(destination,"samples","empty")))throw new Exception("Uninterrupted 420-item copy was not verified");
            var verified=copyType.GetMethod("ForBackgroundVerification").Invoke(null,new object[]{spec,instruction,"old-task:original-grant",read,attempt});
            await (Task)copyType.GetMethod("VerifyPastedFiles").Invoke(verified,new object[]{check});
            string altered=Path.Combine(destination,"samples","item-0.txt");
            var time=File.GetLastWriteTimeUtc(altered);File.WriteAllText(altered,Guid.NewGuid().ToString());File.SetLastWriteTimeUtc(altered,time);
            bool failed=false;
            try {await (Task)copyType.GetMethod("VerifyPastedFiles").Invoke(verified,new object[]{check});}
            catch(InvalidDataException) {failed=true;}
            if(!failed)throw new Exception("Equal size and modification time accepted for different contents");
        }
        Console.WriteLine("Verified 420 background items: typed in independent foreground window, unchanged clipboard, original ready task reused, lost completion recovered, same-size corruption detected");
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
