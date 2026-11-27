using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
sealed class DirectorAsset {
    public string id, name, kind, ext, hash, localPath;
    public long bytes;
    public int? durationMs;
    public bool hasAudio;
    public object Public(string folderRole=null) {
        var data=new Dictionary<string,object>{{"id",id},{"name",name},{"kind",kind},{"bytes",bytes}};
        if(durationMs.HasValue)data["durationMs"]=durationMs.Value;
        if(folderRole!=null)data["folderRole"]=folderRole;
        return data;
    }
}
// Hold the actual file and its ancestor directories while another process reads it
// by name. A renamed file, replaced junction or concurrent writer cannot redirect it.
sealed class DirectorLocalSource : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInfo { public long created,accessed,written,changed; public uint attributes; }
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out BasicInfo info,uint length);
    readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    internal readonly string path, fingerprint;
    internal readonly long bytes;

    internal DirectorLocalSource(string file) {
        path=Path.GetFullPath(file);
        if(!Regex.IsMatch(file,@"^[A-Za-z]:[\\/]") || path.IndexOf(':',2)>=0 ||
           new DriveInfo(Path.GetPathRoot(path)).DriveType==DriveType.Network)
            throw DirectorMedia.Error("请选择本机磁盘上的素材原文件。");
        var parents=new Stack<string>();
        for(var dir=new DirectoryInfo(Path.GetDirectoryName(path));dir.Parent!=null;dir=dir.Parent)parents.Push(dir.FullName);
        try {
            foreach(string parent in parents) {
                var directory=Native.ExplorerCopy.OpenDirectoryHandle(parent,3);
                handles.Add(directory);
                Native.ExplorerCopy.HandleInfo info;
                if(directory.IsInvalid || !Native.ExplorerCopy.GetFileInformationByHandle(directory,out info) ||
                   (info.attributes & (uint)(FileAttributes.Directory|FileAttributes.ReparsePoint))!=(uint)FileAttributes.Directory)
                    throw new IOException();
            }
            var handle=Native.ExplorerCopy.CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
            handles.Add(handle);
            Native.ExplorerCopy.HandleInfo stamp;
            BasicInfo times;
            if(handle.IsInvalid || !Native.ExplorerCopy.GetFileInformationByHandle(handle,out stamp) ||
               (stamp.attributes & (uint)(FileAttributes.Directory|FileAttributes.Device|FileAttributes.ReparsePoint|FileAttributes.Offline))!=0 ||
               !GetFileInformationByHandleEx(handle,0,out times,(uint)Marshal.SizeOf(typeof(BasicInfo))))throw new IOException();
            Native.CheckBatchEntryName(handle,path);
            bytes=((long)stamp.sizeHigh<<32)|stamp.sizeLow;
            if(bytes<=0)throw DirectorMedia.Error("素材是空文件。");
            fingerprint=String.Format(CultureInfo.InvariantCulture,"{0:x}-{1:x}-{2:x}-{3:x}-{4:x}-{5:x}-{6:x}",
                stamp.volume,stamp.indexHigh,stamp.indexLow,times.created,times.written,times.changed,bytes);
        } catch(IOException) {
            Dispose();throw DirectorMedia.Error("无法读取素材原文件，请核对其是否被移动、替换、占用或改为链接，再重新导入。");
        } catch {Dispose();throw;}
    }
    public void Dispose(){for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();handles.Clear();}
}
static class DirectorMedia {
    internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    internal const long MaxBytes = 512L * 1024 * 1024;
    internal static JavaScriptSerializer Json() { return new JavaScriptSerializer {MaxJsonLength=512*1024,RecursionLimit=16}; }
    static object Ordered(object value) {
        var map=value as Dictionary<string,object>;
        if(map!=null)return new SortedDictionary<string,object>(map.ToDictionary(x=>x.Key,x=>Ordered(x.Value)),StringComparer.Ordinal);
        var list=value as object[];return list==null?value:list.Select(Ordered).ToArray();
    }
    internal static string Canonical(object value) {
        var j=Json();return j.Serialize(Ordered(j.DeserializeObject(j.Serialize(value))));
    }
    internal static string Hash(byte[] bytes) { using(var sha=SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
    internal static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant(); }
    internal static string Uuid(object value) {
        Guid id;
        if (!(value is string) || !Guid.TryParseExact((string)value,"D",out id) || id==Guid.Empty)
            throw Error("项目或素材编号无效。");
        return id.ToString("D");
    }
    internal static InvalidOperationException Error(string text) { return new InvalidOperationException(text); }
    internal static string[] Inputs = {".jpg",".jpeg",".png",".webp",".bmp",".mp4",".mov",".m4v",".webm",".mkv",".avi",".wav",".mp3",".m4a",".aac",".flac",".ogg"};
    internal static readonly string[] Documents={".txt",".md",".srt",".pdf",".docx",".pptx",".xlsx"};
    internal static string Format(string ext) {
        switch(ext) {
            case ".jpg": case ".jpeg": return "jpeg_pipe";
            case ".png": return "png_pipe"; case ".webp":return "webp_pipe"; case ".bmp": return "bmp_pipe";
            case ".mp4":case ".mov":case ".m4v":case ".m4a": return "mov";
            case ".webm":case ".mkv":return "matroska";
            case ".avi": return "avi"; case ".wav": return "wav"; case ".mp3": return "mp3";
            case ".aac": return "aac"; case ".flac": return "flac"; case ".ogg":return "ogg";
            default: throw Error("请选择支持的图片、视频或音频。");
        }
    }
    internal static string Kind(string ext) {
        if(Documents.Contains(ext))return "document";
        return new[]{".jpg",".jpeg",".png",".webp",".bmp"}.Contains(ext)?"image":
            new[]{".mp4",".mov",".m4v",".webm",".mkv",".avi"}.Contains(ext)?"video":"audio";
    }
    internal static string FindProgram(string env, string filename, params string[] candidates) {
        string configured=Environment.GetEnvironmentVariable(env);
        var paths=new List<string>();
        if(!String.IsNullOrWhiteSpace(configured))paths.Add(configured);
        paths.AddRange(candidates);
        foreach(var dir in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')) {
            string full=dir.Trim().Trim('"');
            if(full.Length>2 && Path.IsPathRooted(full) && !full.StartsWith(@"\\"))paths.Add(Path.Combine(full,filename));
        }
        foreach(string path in paths) {
            if(String.IsNullOrWhiteSpace(path) || !Regex.IsMatch(path,@"^[A-Za-z]:[\\/]") || !String.Equals(Path.GetFileName(path),filename,StringComparison.OrdinalIgnoreCase))continue;
            if(File.Exists(path))return Path.GetFullPath(path);
        }
        return null;
    }
    internal static string Ffmpeg() {
        return FindProgram("XUTI_DIRECTOR_FFMPEG","ffmpeg.exe",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktop","tools","ffmpeg.exe"),Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"tools","ffmpeg.exe"));
    }
    internal static string Python() { return FindProgram("XUTI_DIRECTOR_PYTHON","python.exe"); }
    internal static string Quote(string value) {
        if(value.IndexOf('\0')>=0)throw Error("无效的后台参数。");
        // CommandLineToArgvW quoting for a direct executable. No shell parses this string.
        var quoted=Regex.Replace(value,@"(\\*)""","$1$1\\\"");
        return "\""+Regex.Replace(quoted,@"(\\+)$","$1$1")+"\"";
    }
    internal static string Exec(string exe,IEnumerable<string> args,string dir,CancellationToken stop,int timeoutMs=900000,bool allowFailure=false) {
        if(exe==null)throw Error("未找到 FFmpeg，请安装支持 H.264、AAC 和字幕滤镜的 Windows 版本，再重启小序。");
        uint code;
        string result=DirectorProcess.Run(exe,args.ToArray(),dir,stop,timeoutMs,out code);
        if(code!=0 && !allowFailure) {
            if(result.IndexOf("Unknown encoder",StringComparison.OrdinalIgnoreCase)>=0)throw Error("FFmpeg 缺少所需编码器，请安装含 libx264 和 AAC 的构建。");
            if(result.IndexOf("No space left",StringComparison.OrdinalIgnoreCase)>=0)throw Error("渲染磁盘空间不足，请清理空间后继续。");
            bool adapter=String.Equals(Path.GetFileName(exe),"python.exe",StringComparison.OrdinalIgnoreCase);
            throw Error(adapter?"本镜的本机模型或模板未完成生成，请核对适配器配置、输入素材和模型依赖。":"媒体处理失败，请核对素材能否解码以及 FFmpeg 编码器配置。");
        }
        return result;
    }
    internal static string Sec(int ms) { return (ms/1000.0).ToString("0.###",CultureInfo.InvariantCulture); }
    internal static List<string> Begin() {
        return new List<string>{"-hide_banner","-nostdin","-loglevel","error","-y","-filter_complex_threads","2","-filter_threads","2"};
    }
    internal static void Input(List<string> args,string path,string ext) {
        args.AddRange(new[]{"-threads","2","-protocol_whitelist","file","-f",Format(ext),"-i",path});
    }
    internal static void PublishFile(string temp,string dest) {
        if(File.Exists(dest))File.Replace(temp,dest,null);
        else File.Move(temp,dest);
    }
    internal static void Save(string path,string content) {
        var temp=Path.Combine(Path.GetDirectoryName(path),Path.GetRandomFileName());
        try {File.WriteAllText(temp,content,Utf8);PublishFile(temp,path);} finally{if(File.Exists(temp))File.Delete(temp);}
    }
    internal static string ReadText(string path) {
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
        using(var reader=new StreamReader(file,Utf8,true))return reader.ReadToEnd();
    }
    internal static void PlainLocal(string file) {
        var path=Path.GetFullPath(file);
        if(!Regex.IsMatch(path,@"^[A-Za-z]:\\"))throw Error("请选择本地磁盘上的普通文件或目录。");
        for(var item=path;item!=null;item=Path.GetDirectoryName(item)) {
            if((File.GetAttributes(item)&FileAttributes.ReparsePoint)!=0)throw Error("所选素材或目录是链接，请选择原始文件。");
        }
    }
    internal static string AssetDir(string project,string id) {return Path.Combine(project,"assets",Uuid(id));}
    internal static DirectorAsset Asset(string project,string id) {
        var dir=AssetDir(project,id);var meta=Path.Combine(dir,"asset.json");
        if(!File.Exists(meta))throw Error("此版本引用的本机素材不可用，请在这台电脑重新导入。");
        var a=Json().Deserialize<DirectorAsset>(File.ReadAllText(meta));
        if(a.id!=id || a.kind!=Kind(a.ext) || (!Inputs.Contains(a.ext) && !(a.localPath!=null && Documents.Contains(a.ext))))throw Error("本机素材不完整，请重新导入。");
        if(a.localPath==null) {
            if(!File.Exists(Path.Combine(dir,"source"+a.ext)))throw Error("本机素材不完整，请重新导入。");
        } else {
            using(PinLocal(project,a)){}
        }
        return a;
    }
    internal static string PathFor(string project,DirectorAsset a) {return a.localPath??Path.Combine(AssetDir(project,a.id),"source"+a.ext);}
    static string LocalHash(string project,DirectorLocalSource source) {
        return Hash(Utf8.GetBytes("local-v1\n"+project.ToUpperInvariant()+"\n"+source.path.ToUpperInvariant()+"\n"+source.fingerprint));
    }
    static string LocalId(string hash) {
        return Guid.ParseExact(hash.Substring(0,12)+"5"+hash.Substring(13,3)+"a"+hash.Substring(17,15),"N").ToString();
    }
    internal static IDisposable PinLocal(string project,DirectorAsset a) {
        if(a.localPath==null)return null;
        var source=new DirectorLocalSource(a.localPath);
        string hash=LocalHash(project,source);
        if(hash!=a.hash || LocalId(hash)!=a.id || !String.Equals(Path.GetExtension(source.path),a.ext,StringComparison.OrdinalIgnoreCase) ||
           Path.GetFileName(source.path)!=a.name) {
            source.Dispose();throw Error("素材原文件已变化，请重新导入并更新分镜中的引用。");
        }
        return source;
    }
    internal static DirectorAsset ImportLocal(string project,string file,string ffmpeg,CancellationToken stop) {
        stop.ThrowIfCancellationRequested();
        string name=Path.GetFileName(file),ext=Path.GetExtension(name).ToLowerInvariant();
        if(!Documents.Contains(ext))Format(ext);
        if(name.Length>220 || name.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw Error("素材名称无效。");
        using(var source=new DirectorLocalSource(file)) {
            string hash=LocalHash(project,source),id=LocalId(hash),dest=AssetDir(project,id);
            if(Directory.Exists(dest))return Asset(project,id);
            var a=new DirectorAsset{id=id,name=name,kind=Kind(ext),ext=ext,hash=hash,localPath=source.path,bytes=source.bytes};
            string parent=Path.GetDirectoryName(dest);Directory.CreateDirectory(parent);
            string temp=Directory.CreateDirectory(Path.Combine(parent,"import-"+Guid.NewGuid().ToString("N"))).FullName;
            try {
                if(a.kind!="document")Probe(a,source.path,ffmpeg,temp,stop);
                if(a.durationMs>86400000)throw Error("单份音视频时长超过 24 小时，请按片段导入。");
                return PublishAsset(project,temp,dest,a);
            } finally {if(Directory.Exists(temp))Directory.Delete(temp,true);}
        }
    }
    static DirectorAsset PublishAsset(string project,string temp,string dest,DirectorAsset a) {
        Save(Path.Combine(temp,"asset.json"),Json().Serialize(a));
        try {Directory.Move(temp,dest);}catch(IOException){if(!Directory.Exists(dest))throw;return Asset(project,a.id);}
        return a;
    }
    static void Probe(DirectorAsset a,string input,string ffmpeg,string temp,CancellationToken stop) {
        if(ffmpeg==null) {
            if(a.kind!="image")throw Error("请先安装 FFmpeg，再导入音频或视频以核对时长。");
            return;
        }
        var args=Begin();args.AddRange(new[]{"-loglevel","info"});Input(args,input,a.ext);
        args.AddRange(new[]{"-map",a.kind=="audio"?"0:a:0":"0:v:0","-t","0.05","-f","null","-"});
        string info=Exec(ffmpeg,args,temp,stop,45000);
        var duration=Regex.Match(info,@"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)");
        if(duration.Success)a.durationMs=(int)Math.Min(Int32.MaxValue,1000*(Double.Parse(duration.Groups[1].Value,CultureInfo.InvariantCulture)*3600+Int32.Parse(duration.Groups[2].Value)*60+Double.Parse(duration.Groups[3].Value,CultureInfo.InvariantCulture)));
        a.hasAudio=Regex.IsMatch(info,@"Stream #0:\d+(?:\[[^\]]+\])?(?:\([^\)]+\))?: Audio:");
    }
    internal static DirectorAsset Import(string project,string id,string name,Stream source,string ffmpeg,CancellationToken stop) {
        if(name==null || name.Length==0 || name.Length>220 || Path.GetFileName(name)!=name || name.IndexOfAny(Path.GetInvalidFileNameChars())>=0)throw Error("素材名称无效。");
        string ext=Path.GetExtension(name).ToLowerInvariant();Format(ext);
        var dest=AssetDir(project,id);
        if(Directory.Exists(dest))return Asset(project,id);
        var parent=Path.GetDirectoryName(dest);Directory.CreateDirectory(parent);
        string temp=Directory.CreateDirectory(Path.Combine(parent,"import-"+Guid.NewGuid().ToString("N"))).FullName;
        try {
            var a=new DirectorAsset{id=id,name=name,kind=Kind(ext),ext=ext};
            var input=Path.Combine(temp,"source"+ext);
            using(var sha=SHA256.Create())
            using(var output=new FileStream(input,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                byte[] block=new byte[131072];int read;
                while((read=source.Read(block,0,block.Length))>0) {
                    stop.ThrowIfCancellationRequested();a.bytes+=read;
                    if(a.bytes>MaxBytes)throw Error("单份本机素材不能超过 512 MiB。");
                    output.Write(block,0,read);sha.TransformBlock(block,0,read,block,0);
                }
                sha.TransformFinalBlock(block,0,0);a.hash=Hex(sha.Hash);
            }
            if(a.bytes==0)throw Error("素材是空文件。");
            Probe(a,input,ffmpeg,temp,stop);
            return PublishAsset(project,temp,dest,a);
        } finally {if(Directory.Exists(temp))Directory.Delete(temp,true);}
    }
}
}
