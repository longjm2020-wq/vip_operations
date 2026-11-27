using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace XutiDesktop {
sealed class DirectorReceipt {
    public string jobId,state="idle",stage="尚未开始",error;
    public int progress,completedShots,totalShots,reusedShots;
}
sealed class DirectorStudio {
    readonly object gate=new object();
    readonly string root;
    readonly Dictionary<string,CancellationTokenSource> active=new Dictionary<string,CancellationTokenSource>();
    string lastGrant;
    DateTime grantUntil;
    bool picking;
    int authorizationEpoch;
    internal int AuthorizationEpoch { get { return authorizationEpoch; } }
    static readonly string[] Actions={"capabilities","pick","import","preview","read-frame","start","status","pause","resume","open"};
    internal DirectorStudio(string isolatedRoot=null) {
        root=isolatedRoot??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktop","director");
    }
    internal static bool DirectorPage(string url) {
        return ShellPolicy.Trusted(url) && new Uri(url).AbsolutePath.TrimEnd('/')=="/my-workspace/director";
    }
    internal static void Fields(Dictionary<string,object> obj,params string[] names) {
        if(obj==null || obj.Keys.Any(k=>!names.Contains(k)))throw DirectorMedia.Error("导演台请求包含不支持的字段。");
    }
    internal static void ValidateMessage(string source,string current,Dictionary<string,object> envelope,string action) {
        if(!DirectorPage(source)||!DirectorPage(current)||!Actions.Contains(action))throw DirectorMedia.Error("请从本机工作台的导演台打开此操作。");
        Fields(envelope,"channel","action","id","payload");DirectorMedia.Uuid(Value(envelope,"id"));
        var p=Value(envelope,"payload") as Dictionary<string,object>;
        if(action=="capabilities"){Fields(p);return;}
        if(action=="pick")Fields(p,"projectId","kind","remaining","knownIds","role");
        else if(action=="import")Fields(p,"projectId","fileId","name");
        else if(action=="preview")Fields(p,"projectId","assetId");
        else if(action=="read-frame")Fields(p,"projectId","assetId","atMs");
        else if(action=="start")Fields(p,"projectId","version","plan");
        else if(action=="open")Fields(p,"projectId","version","artifact");
        else Fields(p,"projectId","version");
        DirectorMedia.Uuid(Value(p,"projectId"));
    }
    internal static object Value(Dictionary<string,object> d,string k) {object v;return d!=null && d.TryGetValue(k,out v)?v:null;}
    internal string Project(string device,object project) {
        string binding=DirectorMedia.Uuid(device)+"/"+DirectorMedia.Uuid(project);
        return Path.Combine(root,DirectorMedia.Hash(DirectorMedia.Utf8.GetBytes(binding)).Substring(0,40));
    }
    internal static string Out(string project,int version) {return Path.Combine(project,"versions",version.ToString(System.Globalization.CultureInfo.InvariantCulture));}
    static string Artifact(string type) {
        switch(type){case "video":return "video.mp4";case "subtitles":return "subtitles.srt";case "storyboard":return "storyboard.txt";case "plan":return "edit-plan.json";default:throw DirectorMedia.Error("未知的导演台交付物。");}
    }
    static DirectorReceipt Load(string output) {
        string state=Path.Combine(output,"job.json");return File.Exists(state)?DirectorMedia.Json().Deserialize<DirectorReceipt>(DirectorMedia.ReadText(state)):new DirectorReceipt();
    }
    static void Save(string output,DirectorReceipt receipt) {DirectorMedia.Save(Path.Combine(output,"job.json"),DirectorMedia.Json().Serialize(receipt));}
    static FileStream Lease(string path,bool create) {
        try{return new FileStream(path,create?FileMode.OpenOrCreate:FileMode.Open,FileAccess.ReadWrite,FileShare.None);}
        catch(FileNotFoundException){return null;}
        catch(IOException e){int code=e.HResult&65535;if(code==32||code==33)return null;throw;}
    }
    internal DirectorReceipt Status(string output) {
        lock(gate) {
            var receipt=Load(output);
            if(receipt.state=="running"&&!active.ContainsKey(output)) {
                using(var probe=Lease(Path.Combine(output,"render.lock"),true))if(probe!=null) {
                    receipt.state="paused";receipt.stage="客户端已重新打开，可从已核验的镜头继续。";Save(output,receipt);
                }
            }
            return receipt;
        }
    }
    internal DirectorReceipt Start(string project,int version,DirectorPlan incoming,string exe,bool resume) {
        string output=Out(project,version),source=Path.Combine(output,"requested-plan.json");
        lock(gate) {
            Directory.CreateDirectory(output);
            var json=DirectorMedia.Json();
            string txt=null;
            if(incoming!=null) {
                incoming.Validate(project);
                txt=DirectorMedia.Canonical(incoming);
                if(File.Exists(source)&&File.ReadAllText(source)!=txt)throw DirectorMedia.Error("同一版本已绑定其他分镜，请保存并创建新版本。");
            }
            var current=Status(output);
            if(current.state=="completed" || current.state=="running" || (!resume && current.state!="idle"))return current;
            if(active.Count>=2)throw DirectorMedia.Error("本机正在生成两个项目，请等待其中一个完成。");
            FileStream projectLease=Lease(Path.Combine(project,"render.lock"),true),versionLease=null;
            try {
                if(projectLease==null)throw DirectorMedia.Error("本项目已有进行中的版本，请查看进度或暂停后再试。");
                versionLease=Lease(Path.Combine(output,"render.lock"),true);
                if(versionLease==null)throw DirectorMedia.Error("此版本正在生成，请查看任务进度。");
                if(File.Exists(source)) {
                    if(txt!=null && txt!=File.ReadAllText(source))throw DirectorMedia.Error("同一版本已绑定其他分镜，请创建新版本。");
                } else if(txt!=null)DirectorMedia.Save(source,txt);
                else throw DirectorMedia.Error("找不到此版本的剪辑计划，请从导演台重新开始。");
                var plan=json.Deserialize<DirectorPlan>(File.ReadAllText(source));plan.Validate(project);
                if(exe==null)throw DirectorMedia.Error("未找到 FFmpeg，请在本机完成安装后继续。");
                var cancel=new CancellationTokenSource();
                current.jobId=current.jobId??Guid.NewGuid().ToString();current.state="running";current.stage="准备后台渲染";current.error=null;current.totalShots=plan.shots.Length;Save(output,current);
                active.Add(output,cancel);
                var engineLease=projectLease;var taskLease=versionLease;
                Task.Run(()=>Execute(project,output,plan,exe,cancel,engineLease,taskLease));
                projectLease=null;versionLease=null;return current;
            } finally {if(versionLease!=null)versionLease.Dispose();if(projectLease!=null)projectLease.Dispose();}
        }
    }
    void Execute(string project,string output,DirectorPlan plan,string exe,CancellationTokenSource cancel,FileStream projectLease,FileStream versionLease) {
        string state,stage,error=null;
        try {
            DirectorRender.Run(project,output,plan,exe,cancel.Token,(done,reuse,phase)=>{
                lock(gate){var r=Load(output);r.completedShots=done;r.reusedShots=reuse;r.progress=Math.Min(96,(int)(done*95.0/plan.shots.Length));r.stage=phase;Save(output,r);}
            });
            state="completed";stage="已导出并核验视频、分镜稿、字幕和剪辑计划";
        } catch(OperationCanceledException){state="paused";stage="已暂停，保留原素材和已完成镜头。";}
          catch(Exception e) {state=cancel.IsCancellationRequested?"paused":"failed";error=state=="failed"?(e is InvalidOperationException?e.Message:"无法读写本机项目或启动媒体工具。请检查磁盘、素材和渲染器后继续。"):null;stage=error??"已暂停，保留已完成镜头。";}
        lock(gate) {
            try{var r=Load(output);r.state=state;r.error=error;r.stage=stage;if(state=="completed")r.progress=100;Save(output,r);}
            finally{versionLease.Dispose();projectLease.Dispose();active.Remove(output);cancel.Dispose();}
        }
    }
    internal DirectorReceipt Pause(string output) {
        lock(gate){CancellationTokenSource c;if(active.TryGetValue(output,out c))c.Cancel();return Status(output);}
    }
    internal void PauseAll() {lock(gate){authorizationEpoch++;lastGrant=null;foreach(var cancel in active.Values)cancel.Cancel();}}
    internal static bool Granted(string json,string project,string device) {
        var wrapper=DirectorMedia.Json().Deserialize<Dictionary<string,object>>(json);
        var data=Value(wrapper,"data") as Dictionary<string,object>;
        return (Value(data,"projectId") as string)==project && (Value(data,"deviceId") as string)==device;
    }
    internal static async Task<string> Session(CoreWebView2 core) {
        var cookies=await core.CookieManager.GetCookiesAsync(ShellPolicy.Origin+"/api/v1/");
        var cookie=cookies.FirstOrDefault(c=>c.Name=="session" && c.IsHttpOnly && c.IsSecure);
        if(cookie==null)throw DirectorMedia.Error("请登录工作台后再使用本机素材。");
        return cookie.Value;
    }
    internal async Task<string> Grant(CoreWebView2 core,string device,Dictionary<string,object> p,Func<bool> authorized,bool polling,string expectedSession=null) {
        if(!authorized())throw DirectorMedia.Error("请先在「我的电脑」配对并授权当前设备。");
        string id=DirectorMedia.Uuid(Value(p,"projectId")),account=await Session(core);
        if(expectedSession!=null && account!=expectedSession)throw DirectorMedia.Error("工作台账号已变化，请重新选择本机素材。");
        var number=Value(p,"version");
        if(number!=null && (!(number is int)||(int)number<=0))throw DirectorMedia.Error("版本编号无效。");
        string address=ShellPolicy.Origin+"/api/v1/my-workspace/director/projects/"+id+"/native-access?deviceId="+DirectorMedia.Uuid(device)+(number==null?"":"&version="+number);
        string key=DirectorMedia.Hash(DirectorMedia.Utf8.GetBytes(account+"|"+address));
        lock(gate)if(polling && lastGrant==key && grantUntil>DateTime.UtcNow && authorized())return account;
        var uri=new Uri(address);
        using(var handler=new HttpClientHandler{AllowAutoRedirect=false,UseCookies=true,CookieContainer=new CookieContainer()})
        using(var http=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(9),MaxResponseContentBufferSize=16384}) {
            handler.CookieContainer.Add(uri,new Cookie("session",account));
            using(var response=await http.GetAsync(uri)) {
                if(!response.IsSuccessStatusCode || !Granted(await response.Content.ReadAsStringAsync(),id,device))throw DirectorMedia.Error("当前账号无权在此电脑使用该导演项目或版本，请检查配对和项目权限。");
            }
        }
        if(!authorized() || account!=await Session(core))throw DirectorMedia.Error("工作台账号或本机授权已变化，请重新打开项目。");
        lock(gate){lastGrant=key;grantUntil=DateTime.UtcNow.AddSeconds(8);}
        return account;
    }
    const int MaxLocalAssets=500;
    static readonly Dictionary<string,string> FolderRoles=new Dictionary<string,string>(StringComparer.Ordinal) {
        {"商品素材","product"},{"授权肖像","portrait"},{"授权音色","voiceSample"},
        {"正式配音","narration"},{"参考片","reference"},{"文字资料","document"}
    };
    static string FolderRole(string path,string inheritedRole) {
        string role;
        return FolderRoles.TryGetValue(new DirectoryInfo(path).Name,out role)?role:inheritedRole;
    }
    static bool FitsRole(string role,string kind) {
        switch(role) {
            case "product":return kind=="image" || kind=="video";
            case "portrait":return kind=="image";
            case "voiceSample":case "narration":return kind=="audio" || kind=="video";
            case "reference":return kind=="video";
            case "document":return kind=="document";
            default:return role==null;
        }
    }
    internal sealed class PickResult {
        public readonly List<object> assets=new List<object>();
        public readonly List<string> problems=new List<string>();
        public int skippedFiles,skippedFolders,duplicates;
        public bool overLimit,cancelled;
        internal void Failure(string path,bool folder,Exception error) {
            if(folder)skippedFolders++;else skippedFiles++;
            if(problems.Count<3)problems.Add(Path.GetFileName(path)+"："+(error is InvalidOperationException?error.Message:"无法读取，请检查本机文件和访问权限。"));
        }
    }
    static bool Skippable(Exception e) {
        return e is IOException || e is UnauthorizedAccessException || e is InvalidOperationException || e is System.Security.SecurityException;
    }
    internal static PickResult ImportSelection(string project,string[] files,string folder,int remaining,
        HashSet<string> known,string ffmpeg,CancellationToken token,Action inspected=null,string selectedRole=null) {
        var result=new PickResult();
        Action<string,string> import=(file,role)=>{
            token.ThrowIfCancellationRequested();
            if(inspected!=null)inspected();
            var ext=Path.GetExtension(file).ToLowerInvariant();
            if(!DirectorMedia.Inputs.Contains(ext) && !DirectorMedia.Documents.Contains(ext)) {
                if(role!=null)result.Failure(file,false,DirectorMedia.Error("该格式不支持导入"));
                else result.skippedFiles++;
                return;
            }
            if(!FitsRole(role,DirectorMedia.Kind(ext))) {
                result.Failure(file,false,DirectorMedia.Error("文件类型与指定用途不符"));
                return;
            }
            // Stop before probing another asset once all available slots have been filled.
            if(result.assets.Count>=remaining){result.overLimit=true;return;}
            try {
                var asset=DirectorMedia.ImportLocal(project,file,ffmpeg,token);
                if(known.Add(asset.id))result.assets.Add(asset.Public(role));else result.duplicates++;
            } catch(Exception e){if(!Skippable(e))throw;result.Failure(file,false,e);}
        };
        foreach(string file in files){import(file,selectedRole);if(result.overLimit)break;}
        if(folder==null)return result;
        DirectorMedia.PlainLocal(folder);
        if(new DriveInfo(Path.GetPathRoot(folder)).DriveType==DriveType.Network)throw DirectorMedia.Error("请选择本机磁盘上的素材文件夹。");

        var directories=new Stack<KeyValuePair<string,string>>();
        directories.Push(new KeyValuePair<string,string>(folder,FolderRole(folder,null)));
        while(directories.Count>0 && !result.overLimit) {
            token.ThrowIfCancellationRequested();
            var directory=directories.Pop();
            var path=directory.Key;
            try {
                DirectorMedia.PlainLocal(path);
                foreach(var entry in new DirectoryInfo(path).EnumerateFileSystemInfos()) {
                    token.ThrowIfCancellationRequested();
                    if((entry.Attributes & FileAttributes.Directory)!=0) {
                        if((entry.Attributes & FileAttributes.ReparsePoint)!=0)result.skippedFolders++;
                        else directories.Push(new KeyValuePair<string,string>(entry.FullName,FolderRole(entry.FullName,directory.Value)));
                    } else {
                        import(entry.FullName,directory.Value);
                        if(result.overLimit)break;
                    }
                }
            } catch(Exception e){if(!Skippable(e))throw;result.Failure(path,true,e);}
        }
        return result;
    }
    internal sealed class PickPaths {
        internal string[] files=new string[0];
        internal string folder;
    }
    internal static PickPaths Choose(Form owner,string kind,string role) {
        if(kind=="folder") {
            using(var picker=new FolderBrowserDialog{Description="导入所选文件夹中的图片、音视频和文档，按用途目录归类",ShowNewFolderButton=false})
                return picker.ShowDialog(owner)==DialogResult.OK?new PickPaths{folder=picker.SelectedPath}:null;
        }
        var extensions=DirectorMedia.Inputs.Concat(DirectorMedia.Documents).Where(ext=>FitsRole(role,DirectorMedia.Kind(ext)));
        using(var picker=new OpenFileDialog{Multiselect=true,CheckFileExists=true,Title="导入导演项目素材",Filter="可用素材|"+String.Join(";",extensions.Select(s=>"*"+s))})
            return picker.ShowDialog(owner)==DialogResult.OK?new PickPaths{files=picker.FileNames}:null;
    }
    internal async Task<PickResult> Pick(string device,Dictionary<string,object> p,Func<bool> stillAuthorized,
        Func<Task<string>> session,Func<string,string,PickPaths> choose,Func<string,Task> grant,Action<int> progress) {
        if(picking)throw DirectorMedia.Error("已有本机素材选择或登记正在进行，请先完成当前选择。");
        picking=true;
        try {
            return await PickAndRegister(device,p,stillAuthorized,session,choose,grant,progress);
        } finally {picking=false;}
    }
    async Task<PickResult> PickAndRegister(string device,Dictionary<string,object> p,Func<bool> stillAuthorized,
        Func<Task<string>> session,Func<string,string,PickPaths> choose,Func<string,Task> grant,Action<int> progress) {
        DirectorMedia.Uuid(device);
        if(!stillAuthorized())throw DirectorMedia.Error("请先在「我的电脑」配对并授权当前设备。");
        object slots=Value(p,"remaining");
        if(slots!=null && (!(slots is int)||(int)slots<1||(int)slots>MaxLocalAssets))throw DirectorMedia.Error("项目的剩余素材数量无效。");
        var ids=Value(p,"knownIds") as object[];
        if(p.ContainsKey("knownIds") && (ids==null || ids.Length>MaxLocalAssets))throw DirectorMedia.Error("项目的已有素材编号无效。");
        var known=new HashSet<string>((ids??new object[0]).Select(DirectorMedia.Uuid),StringComparer.OrdinalIgnoreCase);
        // Web clients predating the remaining-slot field accept at most 80 assets.
        int remaining=Math.Min(slots==null?80:(int)slots,MaxLocalAssets-known.Count);
        string kind=Value(p,"kind") as string;
        if(kind!="files" && kind!="folder")throw DirectorMedia.Error("未知的素材选择方式。");
        string selectedRole=Value(p,"role") as string;
        if(p.ContainsKey("role") && (selectedRole==null || !FolderRoles.ContainsValue(selectedRole) || kind!="files"))
            throw DirectorMedia.Error("请选择有效的素材用途。");
        // Snapshot the local WebView session, then post to its WinForms UI loop
        // so a modal dialog never runs inside a WebView2 event callback.
        string originalAccount=await session();
        await Task.Yield();
        if(!stillAuthorized())throw DirectorMedia.Error("工作台或本机授权已变化，请重新选择本机素材。");
        var selected=choose(kind,selectedRole);
        if(selected==null)return new PickResult{cancelled=true};
        if(!stillAuthorized())throw DirectorMedia.Error("本机授权已变化，请返回导演台重试。");
        if(progress!=null)progress(0);
        await grant(originalAccount);
        if(!stillAuthorized())throw DirectorMedia.Error("本机授权已变化，请返回导演台重试。");
        string project=Project(device,Value(p,"projectId"));
        int processed=0,reported=0;
        // The WebView authorization callback may only run on its owning UI thread.
        using(var stop=new CancellationTokenSource())
        using(var timer=new System.Windows.Forms.Timer{Interval=500}) {
            timer.Tick+=(sender,args)=>{
                if(!stillAuthorized()){timer.Stop();stop.Cancel();return;}
                int count=Volatile.Read(ref processed);
                if(progress!=null && count!=reported){reported=count;progress(count);}
            };
            timer.Start();
            try {
                return await Task.Run(()=>ImportSelection(project,selected.files,selected.folder,remaining,known,
                    DirectorMedia.Ffmpeg(),stop.Token,()=>Interlocked.Increment(ref processed),selectedRole));
            } catch(OperationCanceledException){throw DirectorMedia.Error("本机授权已变化，已停止导入。");}
        }
    }
    async Task<object> Import(string account,string project,string id,string name,Func<bool> stillAuthorized) {
        // Only this fixed same-origin authenticated media endpoint can supply remote bytes.
        var uri=new Uri(ShellPolicy.Origin+"/api/v1/my-workspace/assistant/files/"+id+"/content");
        if(!stillAuthorized())throw DirectorMedia.Error("工作台会话已变化，请重新导入。");
        if(Directory.Exists(DirectorMedia.AssetDir(project,id)))return new{assets=new[]{DirectorMedia.Asset(project,id).Public()}};
        using(var handler=new HttpClientHandler{AllowAutoRedirect=false,UseCookies=true,CookieContainer=new CookieContainer()})
        using(var http=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(100)})
        using(var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(110))) {
            handler.CookieContainer.Add(uri,new Cookie("session",account));
            using(var response=await http.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead,timeout.Token)){
                if(!response.IsSuccessStatusCode || response.Content.Headers.ContentLength>DirectorMedia.MaxBytes)
                    throw DirectorMedia.Error("无法读取本账号的素材，请检查工作台文件和文件大小。");
                if(!stillAuthorized())throw DirectorMedia.Error("工作台会话已变化，请重新导入。");
                using(var stream=await response.Content.ReadAsStreamAsync())
                using(timeout.Token.Register(stream.Dispose)){
                    var item=await Task.Run(()=>DirectorMedia.Import(project,id,name,stream,DirectorMedia.Ffmpeg(),timeout.Token));
                    return new{assets=new[]{item.Public()}};
                }
            }
        }
    }
    internal static object Frame(string project,string id,int atMs,string ffmpeg) {
        var a=DirectorMedia.Asset(project,id);
        if((a.kind!="image" && a.kind!="video") || atMs<0 || (a.durationMs.HasValue && atMs>=a.durationMs.Value))throw DirectorMedia.Error("请选择有效画面和时间点。");
        string file=Path.Combine(project,"frame-"+Guid.NewGuid().ToString("N")+".jpg");
        try {
            var args=DirectorMedia.Begin();
            if(a.kind=="video")args.AddRange(new[]{"-ss",DirectorMedia.Sec(atMs)});
            DirectorMedia.Input(args,DirectorMedia.PathFor(project,a),a.ext);
            args.AddRange(new[]{"-an","-frames:v","1","-vf","scale=640:640:force_original_aspect_ratio=decrease","-q:v","4","-threads","1",file});
            using(DirectorMedia.PinLocal(project,a))
                DirectorMedia.Exec(ffmpeg,args,project,CancellationToken.None,15000);
            if(!File.Exists(file)||new FileInfo(file).Length>512*1024)throw DirectorMedia.Error("指定时间未读到可分析的画面。");
            return new{mime="image/jpeg",base64=Convert.ToBase64String(File.ReadAllBytes(file))};
        } finally {if(File.Exists(file))File.Delete(file);}
    }
    internal async Task<object> Handle(string account,string device,string action,Dictionary<string,object> p,Func<bool> authorized) {
        string ffmpeg=DirectorMedia.Ffmpeg();
        if(action=="capabilities")return await Task.Run(()=>DirectorRender.Capabilities(ffmpeg));
        if(!authorized())throw DirectorMedia.Error("请在「我的电脑」配对此设备并授权，再打开本机导演台。");
        string project=Project(device,Value(p,"projectId"));
        if(action=="import")return await Import(account,project,DirectorMedia.Uuid(Value(p,"fileId")),Value(p,"name") as string,authorized);
        if(action=="preview"||action=="read-frame") {
            string id=DirectorMedia.Uuid(Value(p,"assetId"));var asset=DirectorMedia.Asset(project,id);
            if(action=="preview"){
                if(asset.kind=="document")throw DirectorMedia.Error("本机文档已登记，请在项目的创作要求中填写需要使用的文案。");
                using(DirectorMedia.PinLocal(project,asset))Open(DirectorMedia.PathFor(project,asset));
                return new{opened=true};
            }
            var ms=Value(p,"atMs");
            if(ms!=null&&!(ms is int))throw DirectorMedia.Error("帧时间无效。");
            return await Task.Run(()=>Frame(project,id,ms==null?0:(int)ms,ffmpeg));
        }
        var number=Value(p,"version");
        if(!(number is int)||(int)number<=0)throw DirectorMedia.Error("版本编号无效。");
        int version=(int)number;string output=Out(project,version);
        if(action=="start"){
            var obj=Value(p,"plan") as Dictionary<string,object>;Fields(obj,"aspect","shots");
            var shots=Value(obj,"shots") as object[];
            if(shots==null || shots.Length>100)throw DirectorMedia.Error("剪辑时间线无效。");
            foreach(var item in shots)Fields(item as Dictionary<string,object>,"id","visualId","audioId","startMs","audioStartMs","durationMs","caption","effect","effectText","title","script","purpose","framing","direction","evidence","voice","presenter","template");
            return Start(project,version,DirectorMedia.Json().ConvertToType<DirectorPlan>(obj),ffmpeg,false);
        }
        if(action=="status")return Status(output);
        if(action=="resume")return Start(project,version,null,ffmpeg,true);
        if(action=="pause")return Pause(output);
        if(action=="open"){
            if(Status(output).state!="completed")throw DirectorMedia.Error("此版本尚未完成。");
            string artifact=Value(p,"artifact") as string;
            if(artifact=="folder")Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe"),DirectorMedia.Quote(output)){UseShellExecute=false});
            else Open(Path.Combine(output,Artifact(artifact)));
            return new{opened=true};
        }
        throw DirectorMedia.Error("不支持的导演台操作。");
    }
    static void Open(string path) {
        if(!File.Exists(path))throw DirectorMedia.Error("本机找不到该文件。");
        Process.Start(new ProcessStartInfo(path){UseShellExecute=true});
    }
}
}
