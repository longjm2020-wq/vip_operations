using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
// Launch suspended so neither a renderer nor a model can start descendants outside the cancelable job.
static class DirectorProcess {
    [StructLayout(LayoutKind.Sequential)] struct Security {internal int length;internal IntPtr descriptor;internal int inherit;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        internal int cb;internal IntPtr reserved,desktop,title;internal int x,y,xSize,ySize,xChars,yChars,fill,flags;
        internal short show,cbReserved;internal IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {internal Startup baseInfo;internal IntPtr attributes;}
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {internal IntPtr process,thread;internal int pid,tid;}
    [DllImport("kernel32",SetLastError=true)] static extern bool CreatePipe(out SafeFileHandle read,out SafeFileHandle write,ref Security security,int size);
    [DllImport("kernel32",SetLastError=true)] static extern bool SetHandleInformation(SafeFileHandle handle,uint mask,uint flags);
    [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr old,IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(SafeFileHandle process,uint milliseconds);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(SafeFileHandle process,out uint code);
    [DllImport("kernel32")] static extern bool TerminateProcess(SafeFileHandle process,uint code);

    static string Read(SafeFileHandle pipe) {
        using(var stream=new FileStream(pipe,FileAccess.Read,8192,false))
        using(var reader=new StreamReader(stream,DirectorMedia.Utf8,false,8192)) {
            var tail=new StringBuilder();char[] buffer=new char[2048];int n;
            while((n=reader.Read(buffer,0,buffer.Length))>0) {
                tail.Append(buffer,0,n);if(tail.Length>65536)tail.Remove(0,tail.Length-32768);
            }
            return tail.ToString();
        }
    }
    internal static string Run(string exe,string[] arguments,string cwd,CancellationToken stop,int timeout,out uint exit) {
        stop.ThrowIfCancellationRequested();
        var security=new Security{length=Marshal.SizeOf(typeof(Security)),inherit=1};
        SafeFileHandle read,write;
        if(!CreatePipe(out read,out write,ref security,0))throw DirectorMedia.Error("无法建立后台媒体管道。");
        using(read)using(write)using(var input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero))
        using(var job=FilePlanRunner.WorkerJob()){
            if(input.IsInvalid || !SetHandleInformation(read,1,0))throw DirectorMedia.Error("无法隔离后台媒体输入。");
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if(size==IntPtr.Zero)throw DirectorMedia.Error("无法配置后台进程描述符。");
            IntPtr attrs=Marshal.AllocHGlobal(size),handles=Marshal.AllocHGlobal(2*IntPtr.Size);
            bool initialized=false;
            try {
                initialized=InitializeProcThreadAttributeList(attrs,1,0,ref size);
                Marshal.WriteIntPtr(handles,input.DangerousGetHandle());
                Marshal.WriteIntPtr(handles,IntPtr.Size,write.DangerousGetHandle());
                if(!initialized || !UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(2*IntPtr.Size),IntPtr.Zero,IntPtr.Zero))
                    throw DirectorMedia.Error("无法限定媒体进程继承的句柄。");
                var si=new StartupEx{baseInfo=new Startup{cb=Marshal.SizeOf(typeof(StartupEx)),flags=0x100,input=input.DangerousGetHandle(),output=write.DangerousGetHandle(),error=write.DangerousGetHandle()},attributes=attrs};
                var cmd=new StringBuilder(DirectorMedia.Quote(exe)+" "+String.Join(" ",arguments.Select(DirectorMedia.Quote)));
                ProcessInfo pi;
                if(!CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref si,out pi))throw DirectorMedia.Error("无法启动本机媒体工具，请核对程序安装路径。");
                using(var process=new SafeFileHandle(pi.process,true))using(var thread=new SafeFileHandle(pi.thread,true)) {
                    try {
                        if(!FilePlanRunner.AssignProcessToJobObject(job,pi.process))throw DirectorMedia.Error("无法约束后台媒体进程树。");
                        using(stop.Register(job.Dispose)) {
                            stop.ThrowIfCancellationRequested();
                            if(ResumeThread(thread)==UInt32.MaxValue)throw DirectorMedia.Error("无法开始后台渲染进程。");
                            write.Dispose();
                            var capture=Task.Run(()=>Read(read));
                            try {
                                if(WaitForSingleObject(process,(uint)timeout)!=0)throw DirectorMedia.Error("本机媒体工具超时，请检查输入素材或模型配置。");
                                stop.ThrowIfCancellationRequested();
                                if(!GetExitCodeProcess(process,out exit))throw DirectorMedia.Error("无法读取后台媒体工具的结果。");
                            } finally {
                                job.Dispose(); // Also closes the inherited writers of any remaining descendants.
                                if(!capture.Wait(5000))throw DirectorMedia.Error("后台媒体工具未正常关闭输出管道。");
                            }
                            return capture.Result;
                        }
                    } finally {
                        if(WaitForSingleObject(process,0)!=0){TerminateProcess(process,1);WaitForSingleObject(process,3000);}
                    }
                }
            } finally {
                if(initialized)DeleteProcThreadAttributeList(attrs);
                Marshal.FreeHGlobal(handles);Marshal.FreeHGlobal(attrs);
            }
        }
    }
}
}
