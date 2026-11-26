using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace XutiDesktop {
sealed class DirectorAsset {
    public string id, name, kind, ext, hash;
    public long bytes;
    public int? durationMs;
    public bool hasAudio;
    public object Public() {
        var data=new Dictionary<string,object>{{"id",id},{"name",name},{"kind",kind},{"bytes",bytes}};
        if(durationMs.HasValue)data["durationMs"]=durationMs.Value;
        return data;
    }
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
        if(a.id!=id || !Inputs.Contains(a.ext) || !File.Exists(Path.Combine(dir,"source"+a.ext)))throw Error("本机素材不完整，请重新导入。");
        return a;
    }
    internal static string PathFor(string project,DirectorAsset a) {return Path.Combine(AssetDir(project,a.id),"source"+a.ext);}
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
            if(ffmpeg!=null) {
                var args=Begin();args.AddRange(new[]{"-loglevel","info"});Input(args,input,ext);
                args.AddRange(new[]{"-map",a.kind=="audio"?"0:a:0":"0:v:0","-t","0.05","-f","null","-"});
                string info=Exec(ffmpeg,args,temp,stop,45000);
                var duration=Regex.Match(info,@"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)");
                if(duration.Success)a.durationMs=(int)Math.Min(Int32.MaxValue,1000*(Int32.Parse(duration.Groups[1].Value)*3600+Int32.Parse(duration.Groups[2].Value)*60+Double.Parse(duration.Groups[3].Value,CultureInfo.InvariantCulture)));
                a.hasAudio=Regex.IsMatch(info,@"Stream #0:\d+(?:\[[^\]]+\])?(?:\([^\)]+\))?: Audio:");
            } else if(a.kind!="image")throw Error("请先安装 FFmpeg，再导入音频或视频以核对时长。");
            Save(Path.Combine(temp,"asset.json"),Json().Serialize(a));
            try {Directory.Move(temp,dest);}catch(IOException){if(!Directory.Exists(dest))throw;return Asset(project,id);}
            return a;
        } finally {if(Directory.Exists(temp))Directory.Delete(temp,true);}
    }
}
}
