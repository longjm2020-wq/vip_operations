using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
static class FilePlanRunner {
    const int MaxBytes=96*1024, MaxSeconds=120;
    const byte Permit=1;
    static readonly UTF8Encoding utf8=new UTF8Encoding(false,true);
    static JavaScriptSerializer Serializer() {return new JavaScriptSerializer{MaxJsonLength=MaxBytes,RecursionLimit=8};}
    internal static string[] ReadSteps(object raw) {
        var array=raw as object[];
        if(array==null || array.Length<2 || array.Length>3 || array.Any(item=>!(item is string)))
            throw new IOException("任务缺少完整的文件执行脚本。");
        return array.Cast<string>().ToArray();
    }

    // A closed supervisor handle kills its child, including a parent crash during a
    // filesystem operation. The helper cannot receive the script until it is in the job.
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime,jobTime; public uint flags; public UIntPtr minSet,maxSet;
        public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic;
        public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
        public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern SafeFileHandle CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool SetInformationJobObject(SafeFileHandle job,int kind,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);

    static SafeFileHandle WorkerJob() {
        var job=CreateJobObject(IntPtr.Zero,null);
        var limits=new ExtendedLimits{basic=new BasicLimits{flags=0x2000}}; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if(!job.IsInvalid && SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))return job;
        job.Dispose();throw new IOException("无法建立受控的后台脚本进程。");
    }
    static Process Start(bool fixture) {
        return Process.Start(new ProcessStartInfo(Application.ExecutablePath,fixture?"--self-test-file-plan":"--run-file-plan"){
            UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
            RedirectStandardInput=true,RedirectStandardOutput=true,StandardOutputEncoding=utf8
        });
    }
    static void SendScript(Process child,Dictionary<string,object> plan,string[] steps,string fixture,Native.FolderAttachment[] sources=null) {
        var script=new Dictionary<string,object>{{"steps",steps},{"plan",plan},{"fixture",fixture}};
        if(sources!=null) {
            if(steps.Contains("copy_attachment"))script["attachment"]=sources.Single().Descriptor;
            else script["attachments"]=sources.Select(a=>a.Descriptor).ToArray();
        }
        var bytes=utf8.GetBytes(Serializer().Serialize(script));
        if(bytes.Length>MaxBytes)throw new IOException("文件执行脚本过长。");
        var pipe=child.StandardInput.BaseStream;
        byte[] length=BitConverter.GetBytes(bytes.Length);
        pipe.Write(length,0,length.Length);pipe.Write(bytes,0,bytes.Length);pipe.Flush();
    }

    // The diagnostics mode only operates in a GUID-named test directory inside TEMP.
    static string FixtureRoot(string fixture) {
        Guid id;
        if(!Guid.TryParseExact(fixture,"N",out id))throw new IOException("无效的隔离测试目录标识。");
        return Path.Combine(Path.GetTempPath(),"xuti-file-plan-"+id.ToString("N"));
    }
    internal static int ChildMain(bool fixtureMode) {
        using(var output=new StreamWriter(Console.OpenStandardOutput(),utf8){AutoFlush=true}) {
            try {
                using(var input=new BinaryReader(Console.OpenStandardInput(),utf8)) {
                    int size=input.ReadInt32();
                    if(size<=0 || size>MaxBytes)throw new IOException("文件执行脚本长度无效。");
                    byte[] bytes=input.ReadBytes(size);
                    if(bytes.Length!=size)throw new EndOfStreamException();
                    var message=AssistantForm.D(Serializer().DeserializeObject(utf8.GetString(bytes)));
                    string[] steps=ReadSteps(message["steps"]);
                    var plan=AssistantForm.D(message["plan"]);
                    Native.FolderAttachment[] sources=null;
                    bool single=message.ContainsKey("attachment") && message["attachment"]!=null;
                    bool multiple=message.ContainsKey("attachments") && message["attachments"]!=null;
                    if(single!=steps.Contains("copy_attachment") || multiple!=steps.Contains("copy_attachments") || (single && multiple))
                        throw new IOException("脚本操作与附件清单不一致。");
                    if(single)sources=new[]{new Native.FolderAttachment(AssistantForm.D(message["attachment"]))};
                    if(multiple)sources=Native.FolderAttachment.ReadList(message["attachments"]);
                    if(sources!=null)foreach(var source in sources)source.SetContent(input.ReadBytes(source.Length));
                    string fixture=AssistantForm.S(message,"fixture");
                    if(!fixtureMode && fixture.Length!=0)throw new IOException("脚本只允许操作本机桌面。");
                    string root=fixtureMode?FixtureRoot(fixture):Native.UserDesktop();
                    var permits=new BlockingCollection<byte>(3);
                    var closed=new CancellationTokenSource();
                    var inputThread=new Thread(()=>{
                        try {
                            while(input.ReadByte()==Permit)if(!permits.TryAdd(Permit))break;
                        } catch(IOException) {} catch(ObjectDisposedException) {}
                        finally {closed.Cancel();permits.CompleteAdding();}
                    }){IsBackground=true};
                    inputThread.Start();
                    var elapsed=Stopwatch.StartNew();
                    Func<Task> check=()=>{
                        closed.Token.ThrowIfCancellationRequested();
                        if(elapsed.Elapsed.TotalSeconds>=(sources==null?MaxSeconds:1800))throw new TimeoutException("后台脚本执行超时。");
                        return Task.FromResult(0);
                    };
                    int count=Native.ExecuteFilePlan(root,plan,steps,check,op=>{
                        output.WriteLine("STEP "+op);
                        byte permit;
                        if(!permits.TryTake(out permit,15000,closed.Token))throw new TimeoutException("等待本机任务授权超时。");
                        closed.Token.ThrowIfCancellationRequested();
                    },sources).GetAwaiter().GetResult();
                    output.WriteLine("DONE "+count.ToString(CultureInfo.InvariantCulture));
                }
                return 0;
            } catch(Exception e) {
                string reason=e is OperationCanceledException || e is EndOfStreamException?"上级任务已停止。":e.Message;
                try{output.WriteLine("ERROR "+Serializer().Serialize(reason.Substring(0,Math.Min(300,reason.Length))));}catch(IOException){}
                return 1;
            }
        }
    }

    internal static async Task<int> Run(Dictionary<string,object> plan,string[] steps,Func<Task> check,CancellationToken stop,string fixture=null,Native.FolderAttachment[] sources=null) {
        stop.ThrowIfCancellationRequested();await check();
        using(var job=WorkerJob())
        using(var child=Start(fixture!=null)) {
            try {
                if(!AssignProcessToJobObject(job,child.Handle))throw new IOException("无法约束后台脚本进程，已停止任务。");
                using(stop.Register(job.Dispose)) {
                    stop.ThrowIfCancellationRequested();
                    SendScript(child,plan,steps,fixture,sources);
                    if(sources!=null) {
                        var pipe=child.StandardInput.BaseStream;
                        foreach(var source in sources) {
                            await check();
                            await pipe.WriteAsync(source.Content,0,source.Length,stop);
                        }
                        await pipe.FlushAsync(stop);
                    }
                    var elapsed=Stopwatch.StartNew();
                    Func<Task> checkpoint=async()=>{
                        stop.ThrowIfCancellationRequested();
                        if(elapsed.Elapsed.TotalSeconds>=(sources==null?MaxSeconds:1800))throw new TimeoutException("后台脚本执行超时。");
                        await check();
                    };
                    int next=0;
                    while(true) {
                        var read=child.StandardOutput.ReadLineAsync();
                        while(await Task.WhenAny(read,Task.Delay(100))!=read)await checkpoint();
                        string line=await read;
                        await checkpoint();
                        if(line!=null && line.StartsWith("ERROR ",StringComparison.Ordinal))
                            throw new IOException(Serializer().Deserialize<string>(line.Substring(6)));
                        if(next<steps.Length && line=="STEP "+steps[next]) {
                            child.StandardInput.BaseStream.WriteByte(Permit);child.StandardInput.BaseStream.Flush();
                            next++;continue;
                        }
                        int verified;
                        var names=plan.ContainsKey("folderNames")?plan["folderNames"] as object[]:null;
                        if(next==steps.Length && line!=null && line.StartsWith("DONE ",StringComparison.Ordinal) &&
                            Int32.TryParse(line.Substring(5),NumberStyles.None,CultureInfo.InvariantCulture,out verified) &&
                            names!=null && verified==names.Length && verified>=1 && verified<=100) {
                            child.StandardInput.Close();
                            while(!child.HasExited){await Task.Delay(20);await checkpoint();}
                            if(child.ExitCode!=0)throw new IOException("后台文件脚本异常退出，无法确认结果。");
                            return verified;
                        }
                        throw new IOException("后台脚本返回的执行回执不完整。");
                    }
                }
            } finally {
                // Covers failed job assignment and ensures that no helper survives a canceled task.
                try{if(!child.HasExited)child.Kill();child.WaitForExit(3000);}catch(InvalidOperationException){}
            }
        }
    }

    internal static void SelfTest() {
        string fixture=Guid.NewGuid().ToString("N"),root=Directory.CreateDirectory(FixtureRoot(fixture)).FullName;
        string[] names={"T-01","T-02"};
        var plan=new Dictionary<string,object>{{"parentName","short"},{"folderNames",names}};
        Func<string[],int> run=steps=>Run(plan,steps,()=>Task.FromResult(0),CancellationToken.None,fixture).GetAwaiter().GetResult();
        try {
            if(run(Native.FolderSteps(Native.CreateFolders))!=2 || File.Exists(Path.Combine(root,"short","T-01","T-01.txt")))
                throw new Exception("A shorter directory script executed the text instruction");
            if(run(Native.FolderSteps(Native.CreateNotes))!=2)throw new Exception("Text-only file script failed");
            plan["parentName"]="compound";
            if(run(Native.FolderSteps(Native.CreateFoldersWithNotes))!=2 ||
                names.Any(n=>!File.Exists(Path.Combine(root,"compound",n,n+".txt"))))throw new Exception("Compound script did not produce the verified pairs");
            TestAttachmentScript(root,fixture,plan,names);
            TestAttachmentSet(root,fixture);
            plan["parentName"]="invalid";
            try{run(new[]{"ensure_directories","unknown","verify"});throw new Exception("Unknown instruction was accepted");}
            catch(IOException){}
            if(Directory.Exists(Path.Combine(root,"invalid")))throw new Exception("Invalid program wrote before validation");
            plan["parentName"]="disconnect";
            using(var child=Start(true)) {
                try {
                    SendScript(child,plan,Native.FolderSteps(Native.CreateFoldersWithNotes),fixture);
                    Func<string> readStep=()=>{
                        var read=child.StandardOutput.ReadLineAsync();
                        if(!read.Wait(8000))throw new Exception("Fixture helper did not request the next instruction");
                        return read.Result;
                    };
                    if(readStep()!="STEP ensure_directories")throw new Exception("Unexpected first instruction");
                    child.StandardInput.BaseStream.WriteByte(Permit);child.StandardInput.BaseStream.Flush();
                    if(readStep()!="STEP ensure_same_name_text")throw new Exception("Unexpected second instruction");
                    child.StandardInput.Close();
                    if(!child.WaitForExit(8000) || child.ExitCode==0 ||
                        names.Any(n=>!Directory.Exists(Path.Combine(root,"disconnect",n)) || File.Exists(Path.Combine(root,"disconnect",n,n+".txt"))))
                        throw new Exception("Orphaned helper executed the next instruction after losing its parent pipe");
                } finally {if(!child.HasExited){child.Kill();child.WaitForExit(3000);}}
            }
        } finally {
            foreach(string parent in new[]{"short","compound","invalid","disconnect"}) {
                string folder=Path.Combine(root,parent);
                if(!Directory.Exists(folder))continue;
                foreach(string n in names) {
                    string dir=Path.Combine(folder,n);
                    if(Directory.Exists(dir)){File.Delete(Path.Combine(dir,n+".txt"));Directory.Delete(dir);}
                }
                Directory.Delete(folder);
            }
            Directory.Delete(root);
        }
    }

    static void TestAttachmentSet(string root,string fixture) {
        var first=new Dictionary<string,object>{{"id",Guid.NewGuid().ToString()},{"name","First 文件.txt"},{"bytes",3},{"sha256","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}};
        var second=new Dictionary<string,object>{{"id",Guid.NewGuid().ToString()},{"name","Second.csv"},{"bytes",4},{"sha256","88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589"}};
        var rows=new object[]{first,second};
        var invalid=new Dictionary<string,object>(second);invalid["name"]="FIRST 文件.txt";
        try{Native.FolderAttachment.ReadList(new object[]{first,invalid});throw new Exception("Case-insensitive duplicate accepted");}catch(IOException){}
        invalid=new Dictionary<string,object>(second);invalid["id"]=first["id"];
        try{Native.FolderAttachment.ReadList(new object[]{first,invalid});throw new Exception("Repeated bound file ID accepted");}catch(IOException){}
        var big=new Dictionary<string,object>(first);big["bytes"]=64*1024*1024;
        invalid=new Dictionary<string,object>(second);invalid["bytes"]=17*1024*1024;
        try{Native.FolderAttachment.ReadList(new object[]{big,invalid});throw new Exception("Over-limit batch accepted");}catch(IOException){}
        var sources=Native.FolderAttachment.ReadList(rows);
        sources[0].SetContent(Encoding.ASCII.GetBytes("abc"));sources[1].SetContent(Encoding.ASCII.GetBytes("abcd"));
        var plan=new Dictionary<string,object>{{"parentName","multi"},{"folderNames",new[]{"A","B"}}};
        string parent=Path.Combine(root,"multi"),a=Path.Combine(parent,"A"),b=Path.Combine(parent,"B");
        Func<string,int> run=action=>Run(plan,Native.FolderSteps(action),()=>Task.FromResult(0),CancellationToken.None,fixture,sources).GetAwaiter().GetResult();
        try {
            try{run(Native.CopyAttachments);throw new Exception("Copy-only created absent targets");}catch(IOException){}
            if(Directory.Exists(parent))throw new Exception("Copy-only task created its parent");
            Directory.CreateDirectory(b);
            string conflict=Path.Combine(b,sources[1].Name);
            File.WriteAllText(conflict,"xxxx");
            try{run(Native.CreateFoldersWithAttachments);throw new Exception("Late file collision was ignored");}catch(IOException){}
            if(Directory.Exists(a) || File.ReadAllText(conflict)!="xxxx" || Directory.GetFiles(b).Length!=1)throw new Exception("Compound preflight wrote before resolving all file collisions");
            File.Delete(conflict);
            var steps=Native.FolderSteps(Native.CreateFoldersWithAttachments);
            try {
                Native.ExecuteFilePlan(root,plan,steps,()=>{
                    if(File.Exists(Path.Combine(a,sources[0].Name)))throw new OperationCanceledException();
                    return Task.FromResult(0);
                },op=>{},sources).GetAwaiter().GetResult();
                throw new Exception("Compound distribution ignored stop");
            } catch(OperationCanceledException){}
            string saved=Path.Combine(a,sources[0].Name);
            var stamp=File.GetLastWriteTimeUtc(saved);
            if(File.Exists(Path.Combine(a,sources[1].Name)) || run(Native.CreateFoldersWithAttachments)!=2 || run(Native.CopyAttachments)!=2 ||
                File.GetLastWriteTimeUtc(saved)!=stamp)throw new Exception("Compound retries lost completed files");
            foreach(var folder in new[]{a,b})foreach(var source in sources)
                if(!File.ReadAllBytes(Path.Combine(folder,source.Name)).SequenceEqual(source.Content))throw new Exception("Wrong member content copied");
        } finally {
            foreach(string folder in new[]{a,b})if(Directory.Exists(folder)) {
                foreach(var source in sources)File.Delete(Path.Combine(folder,source.Name));
                Directory.Delete(folder);
            }
            if(Directory.Exists(parent))Directory.Delete(parent);
        }
    }

    static void TestAttachmentScript(string root,string fixture,Dictionary<string,object> plan,string[] names) {
        var source=new Native.FolderAttachment(new Dictionary<string,object>{{"name","测试附件.txt"},{"bytes",3},{"sha256","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}});
        try{source.SetContent(Encoding.ASCII.GetBytes("bad"));throw new Exception("Incorrect source hash accepted");}catch(IOException){}
        source.SetContent(Encoding.ASCII.GetBytes("abc"));
        string[] files=names.Select(n=>Path.Combine(root,"compound",n,source.Name)).ToArray();
        string[] steps=Native.FolderSteps(Native.CopyAttachment);
        Func<int> run=()=>Run(plan,steps,()=>Task.FromResult(0),CancellationToken.None,fixture,new[]{source}).GetAwaiter().GetResult();
        try {
            plan["folderNames"]=new[]{names[0],"absent"};
            try{run();throw new Exception("Created a missing attachment destination");}catch(IOException){}
            if(File.Exists(files[0]) || Directory.Exists(Path.Combine(root,"compound","absent")))throw new Exception("Missing directory changed a sibling");
            plan["folderNames"]=names;
            File.WriteAllText(files[1],"old");
            try{run();throw new Exception("Different same-size content accepted");}catch(IOException){}
            if(File.Exists(files[0]) || File.ReadAllText(files[1])!="old")throw new Exception("Attachment preflight overwrote or partially populated target");
            File.Delete(files[1]);
            string phase="";int writes=0;
            try {
                Native.ExecuteFilePlan(root,plan,steps,()=>{
                    if(phase=="copy_attachment" && ++writes==4)throw new OperationCanceledException();
                    return Task.FromResult(0);
                },op=>phase=op,new[]{source}).GetAwaiter().GetResult();
                throw new Exception("Attachment cancellation ignored");
            } catch(OperationCanceledException) {}
            if(files.Any(File.Exists) || names.Any(n=>Directory.GetFiles(Path.Combine(root,"compound",n),".xuti-attachment-*.tmp").Length!=0))
                throw new Exception("An interrupted attachment left temporary or partial data");
            if(run()!=names.Length || files.Any(p=>!File.ReadAllBytes(p).SequenceEqual(source.Content)))throw new Exception("Bad file attachment copy");
            DateTime stamp=File.GetLastWriteTimeUtc(files[0]);
            if(run()!=names.Length || File.GetLastWriteTimeUtc(files[0])!=stamp)throw new Exception("Retry rewrote an existing attachment");
        } finally {plan["folderNames"]=names;foreach(string file in files)File.Delete(file);}
    }
}
}
