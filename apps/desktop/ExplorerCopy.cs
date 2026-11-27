using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
static partial class Native {
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);

    // Clipboard checks use only local metadata. Never open the clipboard, extract its
    // contents, or accept a paste from a previous task, resume, or user copy operation.
    public sealed class ExplorerCopy {
        const int maxFiles=512;
        readonly string source, destination, sourceFolder;
        readonly bool oneFile, contents, newDesktopFolder;
        readonly Dictionary<string,FileStamp> expected;
        readonly string[] topLevel;
        readonly string scope, fingerprint;
        readonly Func<string> readReceipt;
        readonly Action<string> writeReceipt;
        string destinationId;
        public WindowChoice SourceWindow {get;private set;}
        public WindowChoice DestinationWindow {get;private set;}
        uint copiedSequence;
        uint? clipboardAtSelection;
        bool pasteSent;
        public bool PasteIssued { get {return pasteSent;} }
        readonly bool verificationOnly;
        public bool VerifiedUnsent {get;private set;}
        public string PasteCommandId { get;set; }
        struct FileStamp {
            public bool Directory;
            public long Size,Modified;
            public FileStamp(FileSystemInfo info) { Directory=info is DirectoryInfo;Size=Directory?0:((FileInfo)info).Length;Modified=info.LastWriteTimeUtc.Ticks; }
        }
        static readonly StringComparer names=StringComparer.OrdinalIgnoreCase;
        static InputNotSent Block(string reason) {return new InputNotSent(reason);}

        public ExplorerCopy(Dictionary<string,object> spec,string instruction) : this(spec,instruction,null,null,null) {}
        public ExplorerCopy(Dictionary<string,object> spec,string instruction,string scope,Func<string> readReceipt,Action<string> writeReceipt)
            : this(spec,instruction,scope,readReceipt,writeReceipt,null) {}
        public static ExplorerCopy ForVerification(Dictionary<string,object> spec,string instruction,string scope,Func<string> readReceipt,string commandId) {
            Guid parsed;
            if(!Guid.TryParse(commandId,out parsed))throw Block("未找到原任务的粘贴指令编号。");
            return new ExplorerCopy(spec,instruction,scope,readReceipt,null,commandId);
        }
        public static ExplorerCopy ForBackgroundVerification(Dictionary<string,object> spec,string instruction,string scope,Func<string> readReceipt,string attempt) {
            Guid parsed;
            if(!Guid.TryParse(attempt,out parsed))throw Block("后台复制缺少原尝试编号。");
            return new ExplorerCopy(spec,instruction,scope,readReceipt,null,attempt,true);
        }
        ExplorerCopy(Dictionary<string,object> spec,string instruction,string scope,Func<string> readReceipt,Action<string> writeReceipt,string commandId,bool background=false) {
            verificationOnly=commandId!=null;
            string selection=S(spec,"selection");
            string kind=S(spec,"destinationKind");
            newDesktopFolder=kind=="newDesktopFolder";
            contents=selection=="contents";
            if((kind!="" && !newDesktopFolder) || (newDesktopFolder && selection!="files" && !contents) ||
                (!newDesktopFolder && selection!="files" && selection!="file"))throw Block("本机无法核对本次复制的文件范围。");
            this.scope=scope;this.readReceipt=readReceipt;this.writeReceipt=writeReceipt;
            oneFile=selection=="file";
            source=ExplicitPath(S(spec,"source"),instruction);
            sourceFolder=oneFile?Path.GetDirectoryName(source):source;
            CheckDirectory(sourceFolder);
            expected=ReadSource();
            topLevel=expected.Keys.Where(k=>k.IndexOf('\\')<0).ToArray();
            if(scope!=null) {
                // Preserve the 1.2.13 fingerprint representation for recovery of an original command.
                using(var hash=SHA256.Create()) {
                    var rows=expected.OrderBy(x=>x.Key,StringComparer.OrdinalIgnoreCase).Select(x=>x.Key+"\t"+(x.Value.Directory?"d":"f")+"\t"+x.Value.Size+"\t"+x.Value.Modified);
                    fingerprint=Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(source+"\n"+String.Join("\n",rows))));
                }
            }
            if(newDesktopFolder) {
                if(String.IsNullOrEmpty(scope) || readReceipt==null || (!verificationOnly && writeReceipt==null))throw Block("桌面新目录只能由已授权的原任务创建。");
                string desktop=UserDesktop(),name=S(spec,"destination");
                CheckDirectory(desktop);
                CheckDesktopName(name,instruction);
                destination=Path.Combine(desktop,name);
                if(SameFolder(sourceFolder,destination) || destination.StartsWith(sourceFolder+"\\",StringComparison.OrdinalIgnoreCase))
                    throw Block("不能把目标目录建在复制来源内，请选择其他目录。");
                if(!verificationOnly)CheckNewFolder();
            } else {
                destination=ExplicitPath(S(spec,"destination"),instruction);
                CheckDirectory(destination);
                if(SameFolder(sourceFolder,destination))throw Block("请指定两个不同的本地目录。");
                if(!verificationOnly)CheckVacant(destination,topLevel);
            }
            if(verificationOnly) {
                string[] saved=(readReceipt()??"").Split('\n');
                // 1.2.13 issued a five-field receipt only for new Desktop folders.
                bool commandMatches=saved.Length==6?saved[5]==commandId:saved.Length==5 && newDesktopFolder;
                if(!commandMatches || saved[0]!=scope || (background ? saved.Length!=6 || saved[4]!="background" : saved[4]!="paste" && saved[4]!="ready") || !SameFolder(saved[1],destination))
                    throw Block("缺少绑定到这次粘贴的本机回执，不能自动确认。");
                if(saved[3]!=fingerprint)throw Block("复制来源的文件清单或属性已改变，不能确认原任务。");
                CheckDirectory(destination);
                destinationId=FolderId(destination);
                if(saved[2]!=destinationId)throw Block("原目标目录已被替换，不能确认原任务。");
                PasteCommandId=commandId;
                if(saved[4]=="ready") {
                    if(!newDesktopFolder || saved.Length!=5 || Directory.EnumerateFileSystemEntries(destination).Any())
                        throw Block("原粘贴未执行，但目标目录已有内容，无法安全续办。");
                    VerifiedUnsent=true;
                } else pasteSent=true;
            }
        }
        static void CheckDesktopName(string name,string instruction) {
            string quoted=Regex.Escape(name);
            if(name.Length==0 || name.Length>100 || name!=name.Trim() || name.StartsWith(".") || name.EndsWith(".") ||
                name.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || Regex.IsMatch(name,@"[\p{Cc}\p{Cf}]|^(?:CON|NUL|PRN|AUX|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)",RegexOptions.IgnoreCase) ||
                !Regex.IsMatch(instruction,@"(?:新建|创建)(?:一个)?(?:新的)?文件夹\s*(?:(?:命名|取名)(?:为|叫)?|叫作?|名为)?\s*(?:"+
                    "\"" +quoted+ "\"|“"+quoted+"”|「"+quoted+"」|'"+quoted+"'|‘"+quoted+"’|"+quoted+
                    @")\s*[，,、；;]?\s*(?:并且?|然后|再|接着)\s*(?:将|把|从)"))
                throw Block("请为桌面新文件夹指定一个完整名称；名称不能包含路径、保留设备名或特殊字符。");
        }
        static string ExplicitPath(string value,string instruction) {
            string path=value.Replace('/','\\').TrimEnd('\\');
            string canonical=LocalFolder(path);
            if(path.Length<=3 || canonical==null || !SameFolder(canonical,path) ||
                path.IndexOf(':',2)>=0 || path.IndexOfAny(new[]{'"','*','?','\r','\n','<','>','|'})>=0 ||
                path.Split('\\').Skip(1).Any(s=>s.Length==0 || s.EndsWith(".") || s.EndsWith(" ")) ||
                !InstructionNamesPath(instruction,path))
                throw Block("请在指令中写明文件来源和目标目录的完整本地路径。");
            return canonical;
        }
        static bool InstructionNamesPath(string instruction,string path) {
            var text=instruction.Replace('/','\\');
            int start=0;
            while(start<text.Length) {
                int pos=text.IndexOf(path,start,StringComparison.OrdinalIgnoreCase);
                if(pos<0)return false;
                int end=pos+path.Length;
                if(end<text.Length && text[end]=='\\')end++;
                if(end==text.Length || Char.IsWhiteSpace(text[end]) ||
                    "\"'”’」,，。!！".Contains(text[end]) ||
                    Regex.IsMatch(text.Substring(end),@"^(?:[下内里中]面?的?\s*(?:全部|所有|各个)?(?:普通)?(?:文件|内容)\s*)?(?:复制|拷贝|到|至)"))return true;
                start=pos+1;
            }
            return false;
        }
        static void CheckDirectory(string path) {
            if(path==null || path.Length<=3 || !Directory.Exists(path) ||
                new DriveInfo(Path.GetPathRoot(path)).DriveType!=DriveType.Fixed)
                throw Block("复制需要已经存在的本机普通目录。网络位置和磁盘根目录请手动处理。");
            for(var current=new DirectoryInfo(path);current.Parent!=null;current=current.Parent) {
                if((current.Attributes & (FileAttributes.ReparsePoint|FileAttributes.System|FileAttributes.Hidden))!=0 ||
                    current.Name.StartsWith(".",StringComparison.Ordinal) ||
                    SameFolder(current.FullName,Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ||
                    SameFolder(current.FullName,Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)) ||
                    SameFolder(current.FullName,Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)))
                    throw Block("此目录包含系统、隐藏或链接位置，请手动核对。");
            }
        }
        static Dictionary<string,FileStamp> ReadFiles(string path,bool single) {
            var result=new Dictionary<string,FileStamp>(names);
            var files=single?new[]{path}.AsEnumerable():Directory.EnumerateFiles(path);
            foreach(string file in files) {
                var info=new FileInfo(file);
                if(!info.Exists)throw Block("源文件已不存在，请核对后继续。");
                if((info.Attributes&(FileAttributes.Hidden|FileAttributes.System))!=0 || info.Name.StartsWith(".",StringComparison.Ordinal)) {
                    if(single)throw Block("此文件是隐藏或系统文件，请手动处理。");
                    continue;
                }
                if((info.Attributes&FileAttributes.ReparsePoint)!=0 || result.Count>=maxFiles)
                    throw Block("复制仅支持一次最多 512 个本地普通文件。链接或云占位文件请手动核对。");
                result.Add(info.Name,new FileStamp(info));
            }
            if(result.Count==0)throw Block("来源中没有可复制的普通文件。");
            return result;
        }
        Dictionary<string,FileStamp> ReadSource() {
            if(!contents)return ReadFiles(source,oneFile);
            var result=ReadTree(source);
            if(result.Count==0)throw Block("源目录为空，没有可复制的内容。");
            return result;
        }
        static Dictionary<string,FileStamp> ReadTree(string folder) {
            var result=new Dictionary<string,FileStamp>(names);
            var directories=new Stack<string>();directories.Push(folder);
            while(directories.Count>0) {
                var directory=new DirectoryInfo(directories.Pop());
                if((directory.Attributes&FileAttributes.ReparsePoint)!=0)throw Block("目录已变为链接，请重新核对。");
                foreach(var item in directory.EnumerateFileSystemInfos()) {
                    if((item.Attributes&(FileAttributes.ReparsePoint|FileAttributes.System|FileAttributes.Hidden|FileAttributes.Offline))!=0 ||
                        item.Name.StartsWith(".",StringComparison.Ordinal))
                        throw Block("目录中包含隐藏、系统、链接或脱机项，无法完整复制，请先核对源目录。");
                    if(result.Count>=maxFiles)throw Block("一次最多核对 512 个文件和子目录，请分批复制。");
                    var relative=item.FullName.Substring(folder.Length+1);
                    if(result.ContainsKey(relative))throw Block("存在仅大小写不同的同名项目，无法完整复制。");
                    result.Add(relative,new FileStamp(item));
                    if(item is DirectoryInfo)directories.Push(item.FullName);
                }
            }
            return result;
        }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
        internal static extern bool CreateDirectoryW(string path,IntPtr security);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
        internal static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
        [StructLayout(LayoutKind.Sequential)] internal struct HandleInfo {
            public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
        }
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetFileInformationByHandle(SafeFileHandle handle,out HandleInfo info);
        internal static void VerifyBatchNote(SafeFileHandle handle,bool justCreated) {
            HandleInfo info;
            var excluded=FileAttributes.Directory|FileAttributes.ReparsePoint|FileAttributes.System|FileAttributes.Hidden|FileAttributes.Offline|FileAttributes.Device;
            if(handle.IsInvalid || !GetFileInformationByHandle(handle,out info) ||
                (info.attributes&(uint)excluded)!=0 || info.links!=1 || (justCreated && (info.sizeHigh!=0 || info.sizeLow!=0)))
                throw new IOException("目标文本文件不是普通本地文件，或文件存在链接，请核对后继续。");
        }
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,IntPtr data,uint size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileTime(SafeFileHandle handle,IntPtr created,IntPtr accessed,ref long lastWrite);
        internal static void PublishFile(SafeFileHandle handle,string path) {
            byte[] name=Encoding.Unicode.GetBytes(path);
            int lengthOffset=IntPtr.Size*2,header=lengthOffset+4;
            var rename=new byte[header+name.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(name.Length),0,rename,lengthOffset,4);
            Buffer.BlockCopy(name,0,rename,header,name.Length);
            var pinned=GCHandle.Alloc(rename,GCHandleType.Pinned);
            try {
                if(!SetFileInformationByHandle(handle,3,pinned.AddrOfPinnedObject(),(uint)rename.Length))
                    throw new IOException("目标已出现同名项目或无法保存（Windows "+Marshal.GetLastWin32Error()+"）："+Path.GetFileName(path));
            } finally {pinned.Free();}
        }
        static void RemoveUnpublishedFile(SafeFileHandle handle) {
            var flag=GCHandle.Alloc(new byte[]{1},GCHandleType.Pinned);
            try {SetFileInformationByHandle(handle,4,flag.AddrOfPinnedObject(),1);}
            finally {flag.Free();}
        }
        internal static void StagingDisposition(SafeFileHandle handle,bool delete) {
            var flag=GCHandle.Alloc(new byte[]{delete?(byte)1:(byte)0},GCHandleType.Pinned);
            try {
                if(!SetFileInformationByHandle(handle,4,flag.AddrOfPinnedObject(),1))
                    throw new IOException("无法保护附件的临时文件（Windows "+Marshal.GetLastWin32Error()+"）。");
            } finally {flag.Free();}
        }
        internal static SafeFileHandle OpenDirectoryHandle(string path,uint share) {
            return CreateFileW(path,0x80,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        }
        internal static string FolderId(SafeFileHandle handle) {
            HandleInfo info;
            if(handle.IsInvalid || !GetFileInformationByHandle(handle,out info) || (info.attributes&0x410)!=0x10 ||
                (info.indexHigh==0 && info.indexLow==0))throw Block("本机无法核对桌面文件夹的身份，已停止创建或粘贴。");
            return String.Format("{0:x}:{1:x}:{2:x}:{3:x}:{4:x}",info.volume,info.indexHigh,info.indexLow,info.creationHigh,info.creationLow);
        }
        static string FolderId(string path) {
            using(var handle=OpenDirectoryHandle(path,7))return FolderId(handle);
        }
        string Receipt(string phase) {
            var receipt=String.Join("\n",new[]{scope,destination,destinationId,fingerprint,phase});
            return (phase=="paste" || phase=="background") && !String.IsNullOrEmpty(PasteCommandId)?receipt+"\n"+PasteCommandId:receipt;
        }
        bool CheckNewFolder() {
            if(!SameFolder(UserDesktop(),Path.GetDirectoryName(destination)))throw Block("Windows 桌面的位置已经更改，请核对原任务。");
            string receipt=readReceipt()??"";
            var parts=receipt.Split('\n');
            if(parts[0]!=scope) {
                try {File.GetAttributes(destination);}
                catch(FileNotFoundException) {return false;}
                throw Block("桌面已经有同名项目。请另取名称，已有目录不会合并或覆盖。");
            }
            if((parts.Length!=5 && parts.Length!=6) || !SameFolder(parts[1],destination) || !Directory.Exists(destination) ||
                !String.Equals(parts[2],FolderId(destination),StringComparison.Ordinal) || parts[3]!=fingerprint)
                throw Block("原任务的来源内容或已建目录身份发生变化，请核对后处理。");
            destinationId=parts[2];
            if(parts[4]=="paste") {
                throw Block("上次任务已发出粘贴，结果尚未全部核验。请查看原目录中的复制进度，避免重复。");
            }
            if(parts[4]!="ready" || Directory.EnumerateFileSystemEntries(destination).Any())
                throw Block("原任务建立的目标目录已变化，请核对后处理，不会合并已有内容。");
            return true;
        }
        void EnsureNewFolder(Action check) {
            CheckDirectory(sourceFolder);CheckDirectory(Path.GetDirectoryName(destination));
            if(!SameSource())throw Block("来源已变化，请先核对内容，再创建目标目录。");
            if(!CheckNewFolder()) {
                FolderId(Path.GetDirectoryName(destination)); // require a filesystem with stable directory IDs
                check();
                if(!CreateDirectoryW(destination,IntPtr.Zero)) {
                    int error=Marshal.GetLastWin32Error();
                    throw Block(error==183 || error==80?"桌面已经有同名项目，未合并或覆盖。":"无法创建指定的桌面文件夹（Windows "+error+"），请核对后继续。");
                }
                destinationId=FolderId(destination);
                writeReceipt(Receipt("ready"));
            }
            CheckNewFolder();check();
        }
        public async Task PrepareAuthorizedDestination(IntPtr own,Action check) {
            if(verificationOnly)throw Block("复核任务只读取已复制的结果。");
            if(!newDesktopFolder)return;
            await CheckStart(SourceWindow);check();
            EnsureNewFolder(check);
            DestinationWindow=await OpenExplorerDirectory(own,destination,check);
            if(SourceWindow.Handle==DestinationWindow.Handle)throw Block("请分别打开源目录与桌面新目录。");
        }
        static void CheckVacant(string folder,IEnumerable<string> files) {
            foreach(string name in files) {
                try {
                    File.GetAttributes(Path.Combine(folder,name));
                    throw Block("目标目录已有同名文件或文件夹，请核对。为保留现有文件，未执行粘贴。");
                } catch(FileNotFoundException) { }
            }
        }
        bool SameSource() {
            var current=ReadSource();
            return current.Count==expected.Count && expected.All(e=>{
                FileStamp stamp;return current.TryGetValue(e.Key,out stamp) && stamp.Directory==e.Value.Directory && stamp.Size==e.Value.Size && stamp.Modified==e.Value.Modified;
            });
        }
        public async Task Open(IntPtr own,Action check) {
            if(verificationOnly)throw Block("复核任务只读取已复制的结果。");
            if(!newDesktopFolder)DestinationWindow=await OpenExplorerDirectory(own,destination,check);
            SourceWindow=await OpenExplorerDirectory(own,sourceFolder,check);
            if(DestinationWindow!=null && SourceWindow.Handle==DestinationWindow.Handle)throw Block("源目录和目标目录需要分别在可核验的资源管理器窗口中打开。");
        }
        public List<WindowChoice> Windows(WindowChoice current) {
            var second=current.Handle==SourceWindow.Handle?DestinationWindow:SourceWindow;
            ValidateWindow(second,false);RefreshTitle(second);
            return new List<WindowChoice>{current,second};
        }
        bool SameWindow(WindowChoice actual,WindowChoice expectedWindow) {
            return actual!=null && expectedWindow!=null && actual.Handle==expectedWindow.Handle &&
                actual.Pid==expectedWindow.Pid && actual.Started==expectedWindow.Started;
        }
        public async Task CheckStart(WindowChoice window) {
            if(!SameWindow(window,SourceWindow) || !SameFolder(await ExplorerLocation(window),sourceFolder))
                throw Block("原任务的复制来源窗口已变化，请重新核对。");
        }
        public async Task CheckLocation(WindowChoice window) {
            string folder=SameWindow(window,SourceWindow)?sourceFolder:SameWindow(window,DestinationWindow)?destination:null;
            if(folder==null || !SameFolder(await ExplorerLocation(window),folder))throw Block("复制任务的资源管理器目录已切换，请回到指定目录后继续。");
        }
        // Inspect selected Explorer items, not file contents or the clipboard. Multiple
        // shell views sharing an HWND cannot establish which tab owns the selection.
        static object UniqueView(WindowChoice target) {
            dynamic shell=null,windows=null;
            object match=null;
            try {
                shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application",true));
                windows=shell.Windows();
                int count=windows.Count;
                if(count>96)return null;
                for(int i=0;i<count;i++) {
                    dynamic view=null;
                    try {
                        view=windows.Item(i);
                        if(view==null || new IntPtr((long)view.HWND)!=target.Handle)continue;
                        if(match!=null)return null;
                        match=(object)view;view=null;
                    } finally {ReleaseShellObject((object)view);}
                }
                var result=match;match=null;return result;
            } finally {ReleaseShellObject(match);ReleaseShellObject((object)windows);ReleaseShellObject((object)shell);}
        }
        static string[] QuerySelection(WindowChoice target,string requiredFolder) {
            dynamic view=null,doc=null,folder=null,self=null,items=null;
            try {
                view=UniqueView(target);
                if(view==null)return null;
                doc=view.Document;folder=doc.Folder;self=folder.Self;
                if(!SameFolder(LocalFolder(self.Path as string),requiredFolder))return null;
                items=doc.SelectedItems();
                int count=items.Count;
                if(count>maxFiles)return null;
                var selection=new List<string>();
                for(int j=0;j<count;j++) {
                    dynamic item=null;
                    try {
                        item=items.Item(j);
                        string path=LocalFolder(item.Path as string);
                        if(path==null || !SameFolder(Path.GetDirectoryName(path),requiredFolder))return null;
                        selection.Add(path);
                    } finally {ReleaseShellObject((object)item);}
                }
                return selection.ToArray();
            } finally {
                ReleaseShellObject((object)items);ReleaseShellObject((object)self);ReleaseShellObject((object)folder);
                ReleaseShellObject((object)doc);ReleaseShellObject((object)view);
            }
        }
        static void FocusFileList(WindowChoice target,Action check) {
            check();ValidateWindow(target,true);
            if(ExplorerListFocused(target))return;
            var visible=new List<IntPtr>();
            EnumChildWindows(target.Handle,(hwnd,unused)=>{
                if(IsWindowVisible(hwnd) && HasClass(hwnd,"SHELLDLL_DefView"))visible.Add(hwnd);
                return true;
            },IntPtr.Zero);
            if(visible.Count==1) {
                var view=AutomationElement.FromHandle(visible[0]);
                var list=view.FindFirst(TreeScope.Descendants,new AndCondition(
                    new OrCondition(new PropertyCondition(AutomationElement.ClassNameProperty,"UIItemsView"),
                        new PropertyCondition(AutomationElement.ClassNameProperty,"SysListView32")),
                    new PropertyCondition(AutomationElement.IsKeyboardFocusableProperty,true),
                    new PropertyCondition(AutomationElement.IsOffscreenProperty,false)));
                if(list!=null) {
                    check();ValidateWindow(target,true);
                    list.SetFocus();
                }
            }
            if(!ExplorerListFocused(target))throw Block("请点击指定资源管理器目录的文件列表空白处，再继续任务。");
        }
        // Highlight exactly the user's named files after the device has claimed the task.
        // This only sets Explorer's visible selection; COPY independently observes it and
        // needs its own server permit. Release COM proxies on the same thread.
        public async Task SelectSourceFiles(Action check) {
            check();ValidateWindow(SourceWindow,true);
            if(!clipboardAtSelection.HasValue)clipboardAtSelection=GetClipboardSequenceNumber();
            dynamic view=null,doc=null,folder=null,self=null;
            try {
                view=UniqueView(SourceWindow);
                if(view==null)throw Block("无法唯一确认来源文件标签，请打开独立的资源管理器窗口。");
                doc=view.Document;folder=doc.Folder;self=folder.Self;
                if(!SameFolder(LocalFolder(self.Path as string),sourceFolder) || !SameSource())
                    throw Block("复制的源目录或文件列表已变化，请重新核对。");
                FocusFileList(SourceWindow,check);
                int count=0;
                foreach(string name in topLevel) {
                    if(count%8==0)await Task.Delay(1);
                    check();ValidateWindow(SourceWindow,true);
                    dynamic item=null;
                    try {
                        item=folder.ParseName(name);
                        if(item==null || !SameFolder(LocalFolder(item.Path as string),Path.Combine(sourceFolder,name)))
                            throw Block("来源中有文件无法在资源管理器里核对。");
                        // SVSI_SELECT; the first item also clears prior selection, focuses
                        // the item and brings it into view.
                        doc.SelectItem(item,count==0?29:1);
                        count++;
                    } finally {ReleaseShellObject((object)item);}
                }
            } finally {
                ReleaseShellObject((object)self);ReleaseShellObject((object)folder);
                ReleaseShellObject((object)doc);ReleaseShellObject((object)view);
            }
        }
        public async Task PrepareSwitchedWindow(WindowChoice target,Action check) {
            await CheckLocation(target);check();
            if(!SameWindow(target,DestinationWindow))return;
            dynamic view=null,doc=null,folder=null,self=null,items=null,first=null;
            try {
                view=UniqueView(target);
                if(view==null)throw Block("无法核对目标窗口的活动标签，请打开独立窗口。");
                doc=view.Document;folder=doc.Folder;self=folder.Self;
                if(!SameFolder(LocalFolder(self.Path as string),destination))throw Block("目标目录已变化，请重新核对。");
                FocusFileList(target,check);
                items=doc.SelectedItems();
                if((int)items.Count>0) {
                    first=items.Item(0);
                    check();ValidateWindow(target,true);
                    doc.SelectItem(first,4); // SVSI_DESELECTOTHERS and deselect the specified item.
                }
            } finally {
                ReleaseShellObject((object)first);ReleaseShellObject((object)items);ReleaseShellObject((object)self);
                ReleaseShellObject((object)folder);ReleaseShellObject((object)doc);ReleaseShellObject((object)view);
            }
        }
        async Task<string[]> Selection(WindowChoice target,string folder) {
            var read=Task.Run(()=>QuerySelection(target,folder));
            if(await Task.WhenAny(read,Task.Delay(3000))!=read)throw Block("资源管理器未及时返回选中项，请核对窗口后继续。");
            return await read;
        }
        static bool AcceptClipboard(uint sequence,uint before,uint after,bool fileFormat,int expectedPid,uint ownerPid) {
            return sequence!=0 && before==sequence && after==sequence && fileFormat && expectedPid>0 && ownerPid==(uint)expectedPid;
        }
        static bool ClipboardMatches(uint sequence,int expectedPid) {
            uint before=GetClipboardSequenceNumber(),pid=0;
            bool fileFormat=IsClipboardFormatAvailable(15); // CF_HDROP
            IntPtr owner=GetClipboardOwner();
            if(owner!=IntPtr.Zero)GetWindowThreadProcessId(owner,out pid);
            return AcceptClipboard(sequence,before,GetClipboardSequenceNumber(),fileFormat,expectedPid,pid);
        }
        static bool ExactSelection(string[] selected,string folder,IEnumerable<string> files) {
            var paths=new HashSet<string>(files.Select(name=>Path.Combine(folder,name)),names);
            return selected.Length==paths.Count && paths.SetEquals(selected);
        }
        static bool ModifiersReleased() {
            return new[]{16,17,18,91,92}.All(k=>(GetAsyncKeyState(k)&0x8000)==0);
        }
        public async Task<string> Observe(WindowChoice window) {
            if(pasteSent || !ExplorerListFocused(window))return null;
            bool atSource=SameWindow(window,SourceWindow);
            if(!atSource && !SameWindow(window,DestinationWindow))return null;
            if(atSource!=(copiedSequence==0))return null;
            CheckDirectory(sourceFolder);CheckDirectory(destination);
            if(newDesktopFolder && !CheckNewFolder())throw Block("原任务创建的目标目录已不在原位。");
            if(!SameSource())throw Block("源文件列表或文件属性已变化，请重新核对复制范围。");
            var selection=await Selection(window,atSource?sourceFolder:destination);
            if(selection==null || !ExplorerListFocused(window))return null;
            if(atSource) {
                if(!ExactSelection(selection,sourceFolder,topLevel))return null;
                return "copy";
            }
            // A selected folder, link or archive may redirect Shell paste into the child.
            if(selection.Length!=0)return null;
            if(!ClipboardMatches(copiedSequence,SourceWindow.Pid))throw Block("本次复制的剪贴板已变化，请从原任务重新复制。");
            CheckVacant(destination,topLevel);
            return "paste";
        }
        public async Task<string> WaitForEvidence(WindowChoice window,Action check) {
            bool sourceReady=SameWindow(window,SourceWindow) && copiedSequence==0;
            bool targetReady=SameWindow(window,DestinationWindow) && copiedSequence!=0 && !pasteSent;
            if(!sourceReady && !targetReady)return null; // server now switches from COPY to the approved destination
            var wait=Stopwatch.StartNew();
            do {
                check();
                string evidence=await Observe(window);
                if(evidence!=null)return evidence;
                await Task.Delay(180);
            } while(wait.ElapsedMilliseconds<2400);
            return null;
        }
        public void CheckDispatch(WindowChoice window,string key,string evidence) {
            if(key!="COPY" && key!="PASTE")throw Block("此文件快捷键无效。");
            bool copy=key=="COPY";
            if(copy && (!clipboardAtSelection.HasValue || GetClipboardSequenceNumber()!=clipboardAtSelection.Value))
                throw Block("选定文件后系统剪贴板被更新，为保留你的新复制内容，本步没有按 Ctrl+C。");
            if(pasteSent || evidence!=(copy?"copy":"paste") || !ExplorerListFocused(window) || !ModifiersReleased() ||
                !SameWindow(window,copy?SourceWindow:DestinationWindow) ||
                (copy?copiedSequence!=0:!ClipboardMatches(copiedSequence,SourceWindow.Pid)))
                throw Block("文件快捷键的窗口、按键或剪贴板状态已变化，本步未发送。");
        }
        public async Task Execute(WindowChoice window,string key,string evidence,Action check,Action checkVerification) {
            if(verificationOnly)throw Block("复核任务不会发送桌面按键。");
            if(evidence!=await Observe(window))throw Block("来源选中项或目标目录已变化，本步未发送。");
            check();CheckDispatch(window,key,evidence);
            if(key=="COPY") {
                uint before=GetClipboardSequenceNumber();
                SendChord(Keys[key]);
                for(int i=0;i<30;i++) {
                    await Task.Delay(50);check();
                    uint now=GetClipboardSequenceNumber();
                    if(now!=before && ClipboardMatches(now,SourceWindow.Pid)){copiedSequence=now;return;}
                }
                throw new Exception("已发送复制快捷键，未能确认来源文件进入剪贴板，请核对后继续。");
            }
            // Deny delete sharing on the owned directory until the actual Shell
            // transfer has been verified. Contents can still be created normally.
            using(var held=OpenDirectoryHandle(destination,3)) {
                CheckVacant(destination,topLevel);
                check();CheckDispatch(window,key,evidence);
                if(newDesktopFolder) {
                    if(FolderId(held)!=destinationId || !CheckNewFolder())throw Block("目标目录已变化，请核对。");
                } else destinationId=FolderId(held);
                if(writeReceipt!=null) {
                    writeReceipt(Receipt("paste"));
                    check();CheckDispatch(window,key,evidence);
                }
                pasteSent=true;
                SendChord(Keys[key]);
                await VerifyPastedFiles(checkVerification);
            }
        }
        sealed class OutputProbe {
            public int count;
            public long bytes;
            public string pending;
        }
        OutputProbe InspectOutput(CancellationToken cancel) {
            var result=new OutputProbe();
            if(FolderId(destination)!=destinationId)throw new IOException("目标目录已被替换，不能核验原任务。");
            CheckDirectory(sourceFolder);CheckDirectory(destination);
            var current=newDesktopFolder?ReadTree(destination):null;
            if(current!=null && current.Keys.Any(k=>!expected.ContainsKey(k)))
                throw new IOException("目标中出现原清单以外的项目，已停止核验，请核对目录。");
            foreach(var pair in expected) {
                cancel.ThrowIfCancellationRequested();
                var path=Path.Combine(destination,pair.Key);
                FileSystemInfo info=pair.Value.Directory?(FileSystemInfo)new DirectoryInfo(path):new FileInfo(path);
                if(!info.Exists) {
                    if(File.Exists(path) || Directory.Exists(path))throw new IOException("目标中的文件和目录类型冲突："+pair.Key);
                    if(result.pending==null)result.pending="尚未出现："+pair.Key;
                    continue;
                }
                if((info.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("目标出现链接，无法核验："+pair.Key);
                if(!pair.Value.Directory) {
                    long size=((FileInfo)info).Length;
                    result.bytes+=size;
                    if(size!=pair.Value.Size) {
                        if(result.pending==null)result.pending="大小尚未与来源一致："+pair.Key;
                        continue;
                    }
                }
                result.count++;
            }
            if(result.pending!=null)return result;
            if(!SameSource())throw new IOException("复制期间来源清单或文件属性已变化，不能核验原任务。");
            byte[] left=new byte[65536],right=new byte[left.Length];
            foreach(var pair in expected.Where(p=>!p.Value.Directory)) {
                cancel.ThrowIfCancellationRequested();
                string sourcePath=Path.Combine(sourceFolder,pair.Key),targetPath=Path.Combine(destination,pair.Key);
                try {
                    using(var src=File.Open(sourcePath,FileMode.Open,FileAccess.Read,FileShare.Read))
                    using(var dst=File.Open(targetPath,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                        if(!EqualStreams(src,dst,left,right,cancel))throw new InvalidDataException("源与目标文件的内容不同："+pair.Key);
                    }
                } catch(IOException e) {
                    int code=e.HResult&0xffff;
                    if(code!=32 && code!=33 && code!=2 && code!=3)throw;
                    result.pending="仍在复制或文件被占用："+pair.Key;return result;
                }
            }
            // A different name must not have appeared during the final byte comparison.
            if(!SameSource() || (newDesktopFolder && !new HashSet<string>(ReadTree(destination).Keys,names).SetEquals(expected.Keys)))
                throw new IOException("核验期间来源或目标清单已变化，请查看原目录。");
            return result;
        }
        static bool EqualStreams(Stream a,Stream b,byte[] left,byte[] right,CancellationToken cancel) {
            if(a.Length!=b.Length)return false;
            int read;
            while((read=a.Read(left,0,left.Length))>0) {
                cancel.ThrowIfCancellationRequested();
                int filled=0;
                while(filled<read) {int n=b.Read(right,filled,read-filled);if(n==0)return false;filled+=n;}
                for(int i=0;i<read;i++)if(left[i]!=right[i])return false;
            }
            return b.ReadByte()==-1;
        }
        public async Task VerifyPastedFiles(Action check) {
            if(!pasteSent || String.IsNullOrEmpty(destinationId))throw Block("未确认原粘贴阶段，不能核验文件结果。");
            var idle=Stopwatch.StartNew();var total=Stopwatch.StartNew();
            int lastCount=-1;long lastSize=-1;
            using(var handle=OpenDirectoryHandle(destination,3))
            using(var cancel=new CancellationTokenSource()) {
                if(FolderId(handle)!=destinationId)throw new IOException("目标目录已被替换，不能核验原任务。");
                try {
                    for(;;) {
                        check();
                        var probe=Task.Run(()=>InspectOutput(cancel.Token));
                        while(await Task.WhenAny(probe,Task.Delay(200))!=probe)check();
                        var result=await probe;check();
                        if(result.pending==null)return;
                        if(result.count!=lastCount || result.bytes!=lastSize) {
                            lastCount=result.count;lastSize=result.bytes;idle.Restart();
                        }
                        if(idle.Elapsed.TotalSeconds>=60 || total.Elapsed.TotalMinutes>=15)
                            throw new IOException("目标已就绪 "+result.count+"/"+expected.Count+" 项，"+result.pending+"。已停止核验，请检查原目录的复制进度。");
                        await Task.Delay(total.ElapsedMilliseconds<2000?200:1200);
                    }
                } finally {cancel.Cancel();}
            }
        }
        // Called only after the server has granted the one-time write permit
        // for this task/attempt. No Shell, clipboard, window, or input APIs.
        public async Task RunBackground(string attempt,Func<Task> lease,Action check) {
            Guid parsed;
            if(verificationOnly || !Guid.TryParse(attempt,out parsed) || readReceipt==null || writeReceipt==null)
                throw Block("后台复制需要原任务的有效尝试和本机回执。");
            await lease();check();
            if(!SameSource())throw Block("后台复制前来源已改变，请核对原任务。");
            var held=new Dictionary<string,SafeFileHandle>(names);
            try {
                HoldPath(sourceFolder,held);
                if(newDesktopFolder) {
                    HoldPath(Path.GetDirectoryName(destination),held);
                    EnsureNewFolder(check);
                }
                HoldPath(destination,held);
                string actual=FolderId(held[destination]);
                if(newDesktopFolder && actual!=destinationId)throw Block("已创建的桌面目标被替换。");
                destinationId=actual;
                CheckVacant(destination,topLevel);
                PasteCommandId=attempt;writeReceipt(Receipt("background"));
                foreach(var e in expected.Where(p=>p.Value.Directory).OrderBy(p=>p.Key.Length)) {
                    await lease();check();
                    HoldPath(Path.Combine(sourceFolder,e.Key),held);
                    var dir=Path.Combine(destination,e.Key);
                    if(!CreateDirectoryW(dir,IntPtr.Zero))throw new IOException("目标子目录已存在或无法排他创建："+e.Key);
                    HoldPath(dir,held);await Task.Yield();
                }
                byte[] buffer=new byte[131072];
                foreach(var e in expected.Where(p=>!p.Value.Directory)) {
                    await lease();check();
                    string path=Path.Combine(sourceFolder,e.Key),target=Path.Combine(destination,e.Key);
                    string stage=Path.Combine(Path.GetDirectoryName(target),".xuti-copy-"+Guid.NewGuid().ToString("N")+".tmp");
                    using(var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x40200000,IntPtr.Zero)) {
                            HandleInfo info;
                            if(handle.IsInvalid || !GetFileInformationByHandle(handle,out info) ||
                                (info.attributes&0x1416)!=0)throw Block("源文件已变化、被占用或无法读取："+e.Key);
                            using(var from=new FileStream(handle,FileAccess.Read,buffer.Length,true))
                            using(var staging=CreateFileW(stage,0x40010000,0,IntPtr.Zero,1,0x40000080,IntPtr.Zero)) {
                                if(staging.IsInvalid)throw new IOException("无法在目标目录创建临时文件："+e.Key);
                                using(var to=new FileStream(staging,FileAccess.Write,buffer.Length,true)) {
                                    bool published=false;
                                    try {
                                        if(from.Length!=e.Value.Size)throw new IOException("源文件大小已改变："+e.Key);
                                        int n;
                                        while((n=await from.ReadAsync(buffer,0,buffer.Length))>0) {
                                            await lease();check();
                                            await to.WriteAsync(buffer,0,n);
                                        }
                                        await to.FlushAsync();await lease();check();
                                        long time=new DateTime(e.Value.Modified,DateTimeKind.Utc).ToFileTimeUtc();
                                        if(!SetFileTime(staging,IntPtr.Zero,IntPtr.Zero,ref time))throw new IOException("无法保存目标文件时间："+e.Key);
                                        PublishFile(staging,target);published=true;
                                    } finally {if(!published)RemoveUnpublishedFile(staging);}
                                }
                            }
                    }
                    await Task.Yield();
                }
                pasteSent=true;
                await VerifyPastedFiles(check);
            } finally {foreach(var handle in held.Values)handle.Dispose();}
        }
        static void HoldPath(string directory,Dictionary<string,SafeFileHandle> held) {
            if(held.ContainsKey(directory) || directory.Length<=3)return;
            HoldPath(Path.GetDirectoryName(directory),held);
            var handle=OpenDirectoryHandle(directory,3);
            try {FolderId(handle);held.Add(directory,handle);}
            catch {handle.Dispose();throw;}
        }
        static bool CopiedFilesVisible(string folder,Dictionary<string,FileStamp> expected) {
            return expected.All(e=>{
                if(e.Value.Directory) {
                    var sub=new DirectoryInfo(Path.Combine(folder,e.Key));
                    return sub.Exists && (sub.Attributes&FileAttributes.ReparsePoint)==0;
                }
                var item=new FileInfo(Path.Combine(folder,e.Key));
                if(!item.Exists || (item.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0 ||
                    item.Length!=e.Value.Size || item.LastWriteTimeUtc.Ticks!=e.Value.Modified)return false;
                // A Shell transfer may preallocate the full size before the writer finishes.
                // Open without write sharing; the verifier never reads file contents.
                try {using(item.Open(FileMode.Open,FileAccess.Read,FileShare.Read))return true;}
                catch(IOException) {return false;}
            });
        }
        public void VerifyOtherAction(Dictionary<string,object> action,WindowChoice window) {
            string kind=S(action,"kind"), key=S(action,"key");
            if(kind=="key" && (key=="COPY" || key=="PASTE"))return;
            if(kind=="switch_window" && copiedSequence!=0 && !pasteSent && SameWindow(window,SourceWindow) &&
                S(action,"windowId")==DestinationWindow.Id)return;
            throw Block("此任务只允许在已核验的来源复制文件、切换至指定目标目录并粘贴。");
        }
        public static void SelfTest(string fixture) {
            string folder=Directory.CreateDirectory(Path.Combine(fixture,"shortcut-files")).FullName;
            string target=Directory.CreateDirectory(Path.Combine(fixture,"shortcut-target")).FullName;
            string first=Path.Combine(folder,"样品.txt"), copy=Path.Combine(target,"样品.txt");
            string sub=Directory.CreateDirectory(Path.Combine(folder,"sub")).FullName;
            try {
                File.WriteAllText(first,"native shortcut fixture");
                var grouped=ReadFiles(folder,false);
                if(grouped.Count!=1 || !ReadFiles(first,true).ContainsKey("样品.txt") ||
                    CopiedFilesVisible(target,grouped))throw new Exception("Wrong ordinary-file selection");
                CheckVacant(target,grouped.Keys);
                File.Copy(first,copy);
                if(!CopiedFilesVisible(target,grouped))throw new Exception("Destination files were not verified");
                bool blocked=false;
                try {CheckVacant(target,grouped.Keys);} catch(InputNotSent) {blocked=true;}
                if(!blocked)throw new Exception("Existing destination file accepted");
                blocked=false;
                try {ExplicitPath(@"D:\private",@"复制 D:\demo 到 D:\other");} catch(InputNotSent) {blocked=true;}
                if(!blocked)throw new Exception("Unrequested path accepted");
                if(InstructionNamesPath(@"复制 D:\demo123 到 D:\other",@"D:\demo") ||
                    InstructionNamesPath(@"复制 D:\demo\private 到 D:\other",@"D:\demo") ||
                    !InstructionNamesPath(@"将 D:\样品 下的文件复制到 D:\目标",@"D:\样品") ||
                    !ExactSelection(new[]{first},folder,grouped.Keys) ||
                    ExactSelection(new[]{copy},folder,grouped.Keys) ||
                    ExactSelection(new[]{first,first},folder,grouped.Keys))
                    throw new Exception("File scope or selection did not match the instruction");
                if(!AcceptClipboard(4,4,4,true,123,123) || AcceptClipboard(0,0,0,true,123,123) ||
                    AcceptClipboard(4,3,4,true,123,123) || AcceptClipboard(4,4,5,true,123,123) ||
                    AcceptClipboard(4,4,4,false,123,123) || AcceptClipboard(4,4,4,true,123,456) ||
                    AcceptClipboard(4,4,4,true,123,0) || !Keys["COPY"].SequenceEqual(new ushort[]{17,67}) ||
                    !Keys["PASTE"].SequenceEqual(new ushort[]{17,86}) || Keys.ContainsKey("CTRL_V") || Keys.ContainsKey("CTRL_C"))
                    throw new Exception("Unverified clipboard state or raw shortcut accepted");
                File.SetLastWriteTimeUtc(copy,File.GetLastWriteTimeUtc(copy).AddMinutes(-1));
                if(CopiedFilesVisible(target,grouped))throw new Exception("A different file was accepted as delivered");
            } finally {
                File.Delete(first);File.Delete(copy);Directory.Delete(sub);Directory.Delete(folder);Directory.Delete(target);
            }
        }
    }
}
}
