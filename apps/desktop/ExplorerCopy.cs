using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Automation;

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
        readonly bool oneFile;
        readonly Dictionary<string,FileStamp> expected;
        public WindowChoice SourceWindow {get;private set;}
        public WindowChoice DestinationWindow {get;private set;}
        uint copiedSequence;
        bool pasteSent;
        struct FileStamp {
            public long Size,Modified;
            public FileStamp(FileInfo info) {Size=info.Length;Modified=info.LastWriteTimeUtc.Ticks;}
        }
        static readonly StringComparer names=StringComparer.OrdinalIgnoreCase;
        static InputNotSent Block(string reason) {return new InputNotSent(reason);}

        public ExplorerCopy(Dictionary<string,object> spec,string instruction) {
            string selection=S(spec,"selection");
            if(selection!="file" && selection!="files")throw Block("本机无法核对本次复制的文件范围。");
            oneFile=selection=="file";
            source=ExplicitPath(S(spec,"source"),instruction);
            destination=ExplicitPath(S(spec,"destination"),instruction);
            sourceFolder=oneFile?Path.GetDirectoryName(source):source;
            CheckDirectory(sourceFolder);CheckDirectory(destination);
            if(SameFolder(sourceFolder,destination))throw Block("请指定两个不同的本地目录。");
            expected=ReadFiles(source,oneFile);
            CheckVacant(destination,expected.Keys);
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
                    Regex.IsMatch(text.Substring(end),@"^(?:[下内里中]的?(?:全部|所有|各个)?(?:普通)?文件\s*)?(?:复制到|复制至|拷贝到|拷贝至|到|至)"))return true;
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
        static void CheckVacant(string folder,IEnumerable<string> files) {
            foreach(string name in files) {
                try {
                    File.GetAttributes(Path.Combine(folder,name));
                    throw Block("目标目录已有同名文件或文件夹，请核对。为保留现有文件，未执行粘贴。");
                } catch(FileNotFoundException) { }
            }
        }
        bool SameSource() {
            var current=ReadFiles(source,oneFile);
            return current.Count==expected.Count && expected.All(e=>{
                FileStamp stamp;return current.TryGetValue(e.Key,out stamp) && stamp.Size==e.Value.Size && stamp.Modified==e.Value.Modified;
            });
        }
        public async Task Open(IntPtr own,Action check) {
            DestinationWindow=await OpenExplorerDirectory(own,destination,check);
            SourceWindow=await OpenExplorerDirectory(own,sourceFolder,check);
            if(SourceWindow.Handle==DestinationWindow.Handle)throw Block("源目录和目标目录需要分别在可核验的资源管理器窗口中打开。");
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
            dynamic view=null,doc=null,folder=null,self=null;
            try {
                view=UniqueView(SourceWindow);
                if(view==null)throw Block("无法唯一确认来源文件标签，请打开独立的资源管理器窗口。");
                doc=view.Document;folder=doc.Folder;self=folder.Self;
                if(!SameFolder(LocalFolder(self.Path as string),sourceFolder) || !SameSource())
                    throw Block("复制的源目录或文件列表已变化，请重新核对。");
                FocusFileList(SourceWindow,check);
                int count=0;
                foreach(string name in expected.Keys) {
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
            if(!SameSource())throw Block("源文件列表或文件属性已变化，请重新核对复制范围。");
            var selection=await Selection(window,atSource?sourceFolder:destination);
            if(selection==null || !ExplorerListFocused(window))return null;
            if(atSource) {
                if(!ExactSelection(selection,sourceFolder,expected.Keys))return null;
                return "copy";
            }
            // A selected folder, link or archive may redirect Shell paste into the child.
            if(selection.Length!=0)return null;
            if(!ClipboardMatches(copiedSequence,SourceWindow.Pid))throw Block("本次复制的剪贴板已变化，请从原任务重新复制。");
            CheckVacant(destination,expected.Keys);
            return "paste";
        }
        public void CheckDispatch(WindowChoice window,string key,string evidence) {
            if(key!="COPY" && key!="PASTE")throw Block("此文件快捷键无效。");
            bool copy=key=="COPY";
            if(pasteSent || evidence!=(copy?"copy":"paste") || !ExplorerListFocused(window) || !ModifiersReleased() ||
                !SameWindow(window,copy?SourceWindow:DestinationWindow) ||
                (copy?copiedSequence!=0:!ClipboardMatches(copiedSequence,SourceWindow.Pid)))
                throw Block("文件快捷键的窗口、按键或剪贴板状态已变化，本步未发送。");
        }
        public async Task Execute(WindowChoice window,string key,string evidence,Action check) {
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
            CheckVacant(destination,expected.Keys);
            check();CheckDispatch(window,key,evidence);
            pasteSent=true;
            SendChord(Keys[key]);
            for(int i=0;i<60;i++) {
                await Task.Delay(200);check();
                if(CopiedFilesVisible(destination,expected))return;
            }
            throw new Exception("已发送粘贴快捷键，目标文件还未全部核验。请查看复制进度，避免重复粘贴。");
        }
        static bool CopiedFilesVisible(string folder,Dictionary<string,FileStamp> expected) {
            return expected.All(e=>{
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
