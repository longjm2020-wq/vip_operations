using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
static partial class Native {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);

    static void CheckBatchEntryName(SafeFileHandle handle,string path) {
        var actual=new StringBuilder(1024);
        uint length=GetFinalPathNameByHandleW(handle,actual,(uint)actual.Capacity,0);
        if(length==0 || length>=actual.Capacity || !SameFolder(actual.ToString(),@"\\?\"+path))
            throw new IOException("目标名称指向其他位置或别名，请核对。");
    }

    static string FolderSegment(object value) {
        var name=value as string;
        if(String.IsNullOrEmpty(name) || name.Length>100 || name!=name.Trim() || name.StartsWith(".") || name.EndsWith(".") ||
           name.IndexOfAny(Path.GetInvalidFileNameChars())>=0 ||
           Regex.IsMatch(name,@"[\p{Cc}\p{Cf}]") ||
           Regex.IsMatch(name.Split('.')[0].TrimEnd(),@"^(?:CON|NUL|PRN|AUX|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant))
            throw new IOException("文件夹名称必须是普通的 Windows 名称，请核对任务。");
        return name;
    }

    // Open the entry itself, including junctions. Deny writes and renames until the
    // whole batch is verified, so a checked parent cannot be redirected between steps.
    static SafeFileHandle PinBatchDirectory(string path, bool allowMissing, bool userNamed) {
        var handle=ExplorerCopy.OpenDirectoryHandle(path,1);
        if(handle.IsInvalid) {
            int error=Marshal.GetLastWin32Error();
            handle.Dispose();
            if(allowMissing && error==2)return null;
            throw new IOException("无法核对目录 "+Path.GetFileName(path)+"（Windows "+error+"）。");
        }
        try {
            ExplorerCopy.FolderId(handle);
            if(userNamed) {
                CheckBatchEntryName(handle,path);
                if((File.GetAttributes(path)&(FileAttributes.System|FileAttributes.Hidden|FileAttributes.Offline))!=0)
                    throw new IOException("指定名称指向别名、隐藏项目或非本机普通目录，请核对。");
            }
            return handle;
        } catch {handle.Dispose();throw;}
    }

    static SafeFileHandle CreateBatchDirectory(string path) {
        if(!ExplorerCopy.CreateDirectoryW(path,IntPtr.Zero)) {
            int error=Marshal.GetLastWin32Error();
            if(error!=183 && error!=80)throw new IOException("无法创建文件夹 "+Path.GetFileName(path)+"（Windows "+error+"）。");
        }
        return PinBatchDirectory(path,false,true);
    }

    // CREATE_NEW never truncates an existing file. If another process wins the create
    // race, open its entry for metadata only, with the same checks as during preflight.
    static SafeFileHandle PinBatchNote(string path,bool create) {
        var handle=ExplorerCopy.CreateFileW(path,0x80,1,IntPtr.Zero,create?1u:3u,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid) {
            int error=Marshal.GetLastWin32Error();
            handle.Dispose();
            if(!create && error==2)return null;
            if(create && (error==183 || error==80)) {
                var existing=PinBatchNote(path,false);
                if(existing!=null)return existing;
            }
            throw new IOException("无法创建或核对 "+Path.GetFileName(path)+"（Windows "+error+"）。");
        }
        try {
            CheckBatchEntryName(handle,path);
            ExplorerCopy.VerifyBatchNote(handle,create);
            return handle;
        } catch { handle.Dispose();throw; }
    }

    public static Task<int> CreateDesktopFolders(Dictionary<string,object> plan,Func<Task> checkpoint,bool notes) {
        return EnsureFolderBatch(UserDesktop(),plan,checkpoint,notes);
    }

    static async Task<int> EnsureFolderBatch(string desktop,Dictionary<string,object> plan,Func<Task> checkpoint,bool notes=false) {
        object parentValue,childrenValue;
        plan.TryGetValue("parentName",out parentValue);
        plan.TryGetValue("folderNames",out childrenValue);
        string parentName=FolderSegment(parentValue);
        var children=childrenValue as object[];
        if(children==null || children.Length<1 || children.Length>100)throw new IOException("一次建目录需要 1 至 100 个子目录名称。");
        string[] names=children.Select(FolderSegment).ToArray();
        if(names.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=names.Length)throw new IOException("子目录名称重复，请核对任务。");
        if(desktop==null || desktop.Length<=3 || new DriveInfo(Path.GetPathRoot(desktop)).DriveType!=DriveType.Fixed)
            throw new IOException("Windows 桌面需要位于本机固定磁盘。");

        string parent=Path.Combine(desktop,parentName);
        var held=new List<SafeFileHandle>();
        var slots=new SafeFileHandle[names.Length];
        try {
            var ancestors=new Stack<string>();
            for(var dir=new DirectoryInfo(desktop);dir.Parent!=null;dir=dir.Parent)ancestors.Push(dir.FullName);
            foreach(string ancestor in ancestors)held.Add(PinBatchDirectory(ancestor,false,false));
            await checkpoint();
            var parentHandle=PinBatchDirectory(parent,!notes,true);
            if(parentHandle!=null) {
                held.Add(parentHandle);
                // Detect a conflicting file or link before adding missing siblings.
                for(int i=0;i<names.Length;i++) {
                    await checkpoint();
                    slots[i]=PinBatchDirectory(Path.Combine(parent,names[i]),!notes,true);
                    if(slots[i]!=null)held.Add(slots[i]);
                }
            } else {
                await checkpoint();
                held.Add(CreateBatchDirectory(parent));
            }
            if(notes) {
                // All folders in the completed parent task must exist. Preflight all
                // existing files before writing any of the missing ones.
                var paths=names.Select(name=>Path.Combine(parent,name,name+".txt")).ToArray();
                for(int i=0;i<paths.Length;i++) {
                    await checkpoint();
                    slots[i]=PinBatchNote(paths[i],false);
                    if(slots[i]!=null)held.Add(slots[i]);
                }
                for(int i=0;i<paths.Length;i++) {
                    await checkpoint();
                    if(slots[i]!=null)continue;
                    slots[i]=PinBatchNote(paths[i],true);
                    held.Add(slots[i]);
                }
                await checkpoint();
                foreach(var note in slots)ExplorerCopy.VerifyBatchNote(note,false);
                return slots.Length;
            }
            for(int i=0;i<names.Length;i++) {
                await checkpoint();
                if(slots[i]==null) {
                    slots[i]=CreateBatchDirectory(Path.Combine(parent,names[i]));
                    held.Add(slots[i]);
                }
            }
            await checkpoint();
            foreach(var slot in slots)ExplorerCopy.FolderId(slot);
            return slots.Length;
        } finally {foreach(var handle in held)handle.Dispose();}
    }

    public static void FolderCreationSelfTest(string fixture) {
        string desktop=Directory.CreateDirectory(Path.Combine(fixture,"batch-desktop")).FullName;
        string parent=Path.Combine(desktop,"测试自动化999");
        var names=Enumerable.Range(1,10).Select(i=>"XUTI-"+i.ToString("00")).ToArray();
        try { TestFolderBatch(desktop,parent,names); }
        finally {
            File.Delete(Path.Combine(parent,"keep.txt"));
            foreach(string name in names.Concat(new[]{"resume-a","resume-b","missing"})) {
                string nested=Path.Combine(parent,name);
                if(Directory.Exists(nested))Directory.Delete(nested);
            }
            if(Directory.Exists(parent))Directory.Delete(parent);
            Directory.Delete(desktop);
        }
    }

    static void TestFolderBatch(string desktop,string parent,string[] names) {
        var plan=new Dictionary<string,object>{{"parentName","测试自动化999"},{"folderNames",names}};
        Func<int> run=()=>EnsureFolderBatch(desktop,plan,()=>Task.FromResult(0)).GetAwaiter().GetResult();
        Action invalid=()=>{try {run();} catch(IOException){return;} catch(InputNotSent){return;} throw new Exception("Invalid folder batch succeeded");};
        if(run()!=10 || run()!=10 || Directory.GetDirectories(parent).Length!=10)throw new Exception("Folder batch or retry failed");
        TestFolderNotes(desktop,parent,names);
        string existing=Path.Combine(parent,"keep.txt");
        File.WriteAllText(existing,"original");
        plan["folderNames"]=new[]{"missing","keep.txt"};invalid();
        if(Directory.Exists(Path.Combine(parent,"missing")) || File.ReadAllText(existing)!="original")throw new Exception("Folder conflict changed the destination");
        foreach(string invalidName in new[]{@"..\outside",@"C:\outside","CON.txt","NUL .txt","tail.","x/y",".hidden","NUL","x\u0001x"}) {
            plan["folderNames"]=new[]{"missing",invalidName};invalid();
        }
        plan["folderNames"]=new[]{"x","X"};invalid();
        if(Directory.Exists(Path.Combine(parent,"missing")))throw new Exception("Malformed batch created a partial result");
        plan["folderNames"]=new[]{"resume-a","resume-b"};
        try {
            EnsureFolderBatch(desktop,plan,()=>{
                if(Directory.Exists(Path.Combine(parent,"resume-a")))throw new OperationCanceledException();
                return Task.FromResult(0);
            }).GetAwaiter().GetResult();
            throw new Exception("Cancellation was ignored");
        } catch(OperationCanceledException) {}
        if(Directory.Exists(Path.Combine(parent,"resume-b")) || run()!=2)throw new Exception("Folder batch did not resume");
    }

    static void TestFolderNotes(string desktop,string parent,string[] names) {
        string[] paths=names.Select(n=>Path.Combine(parent,n,n+".txt")).ToArray();
        var plan=new Dictionary<string,object>{{"parentName",Path.GetFileName(parent)},{"folderNames",names}};
        Func<int> run=()=>EnsureFolderBatch(desktop,plan,()=>Task.FromResult(0),true).GetAwaiter().GetResult();
        Action invalid=()=>{try{run();}catch(IOException){return;}catch(InputNotSent){return;}throw new Exception("Accepted a conflicting batch of text files");};
        try {
            plan["folderNames"]=new[]{names[0],"missing"};
            invalid();
            if(Directory.Exists(Path.Combine(parent,"missing")) || File.Exists(paths[0]))throw new Exception("Notes recreated a missing source directory");
            plan["folderNames"]=names;
            Directory.CreateDirectory(paths[2]);
            try {invalid();if(File.Exists(paths[0]))throw new Exception("Conflict was discovered only after writing another note");}
            finally {Directory.Delete(paths[2]);}
            File.WriteAllText(paths[1],"original content");
            try {
                EnsureFolderBatch(desktop,plan,()=>{
                    if(File.Exists(paths[0]))throw new OperationCanceledException();
                    return Task.FromResult(0);
                },true).GetAwaiter().GetResult();
                throw new Exception("Background note creation ignored cancellation");
            } catch(OperationCanceledException) {}
            if(File.Exists(paths[2]) || run()!=names.Length || run()!=names.Length ||
                File.ReadAllText(paths[1])!="original content" || paths.Where(p=>p!=paths[1]).Any(p=>!File.Exists(p)||new FileInfo(p).Length!=0))
                throw new Exception("Text notes were lost, modified or not verified after resuming");
        } finally {foreach(string path in paths)File.Delete(path);}
    }
}
}
