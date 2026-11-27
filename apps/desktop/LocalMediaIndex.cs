using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
sealed class LocalMediaIndex {
    public const string Route = "/__xuti-local-media/";
    const int MaxEntries = 20000, MaxVisited = 100000, PageSize = 50;
    public const int MaxFileBytes = 100 * 1024 * 1024;
    const int PreviewBytes = 8 * 1024 * 1024, ExcerptBytes = 16 * 1024 * 1024;
    public const string BrowserPath = "/aigc";
    const FileAttributes SkippedAttributes = FileAttributes.ReparsePoint | FileAttributes.Offline | FileAttributes.System | FileAttributes.Hidden;
    static readonly Dictionary<string,string> Formats = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
        {".jpg", "jpeg_pipe"}, {".jpeg", "jpeg_pipe"}, {".png", "png_pipe"}, {".webp", "webp_pipe"}, {".bmp", "bmp_pipe"},
        {".mp4", "mov"}, {".mov", "mov"}, {".m4v", "mov"}, {".webm", "matroska"}, {".mkv", "matroska"}, {".avi", "avi"},
        {".mp3", "mp3"}, {".m4a", "mov"}, {".wav", "wav"}, {".flac", "flac"}, {".aac", "aac"}, {".ogg", "ogg"},
    };
    static readonly HashSet<string> Images = new HashSet<string>(new[]{".jpg", ".jpeg", ".png", ".webp", ".bmp"}, StringComparer.OrdinalIgnoreCase);
    static readonly HashSet<string> Videos = new HashSet<string>(new[]{".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}, StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string,string> MimeTypes = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
        {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".png", "image/png"}, {".webp", "image/webp"}, {".bmp", "image/bmp"},
        {".mp4", "video/mp4"}, {".mov", "video/quicktime"}, {".m4v", "video/mp4"}, {".webm", "video/webm"}, {".mkv", "video/x-matroska"}, {".avi", "video/x-msvideo"},
        {".mp3", "audio/mpeg"}, {".m4a", "audio/mp4"}, {".wav", "audio/wav"}, {".flac", "audio/flac"}, {".aac", "audio/aac"}, {".ogg", "audio/ogg"},
    };

    internal sealed class Entry {
        public readonly string Id = Guid.NewGuid().ToString("N");
        public string Name, Path, Relative, Kind, Extension;
        public long Bytes;
        public DateTime Modified;
        public object Client() { return new { id=Id, name=Name, relativePath=Relative, kind=Kind, bytes=Bytes, modifiedAt=Modified.ToString("o") }; }
    }

    internal sealed class Delivery : IDisposable {
        public readonly string Token = Guid.NewGuid().ToString("N");
        public readonly DateTime Expires = DateTime.UtcNow.AddMinutes(2);
        public FileStream File;
        public byte[] Content;
        public string Name, Mime;
        public long Length { get { return File==null ? Content.LongLength : File.Length; } }
        public Stream Take() {
            if(File==null)return new MemoryStream(Content, false);
            var file=File;File=null;return file;
        }
        public void Dispose() { if(File!=null)File.Dispose(); }
    }

    readonly string id = Guid.NewGuid().ToString("N");
    readonly string folder;
    readonly List<Entry> entries = new List<Entry>();
    Dictionary<string,Entry> lookup;
    int skipped;
    bool truncated;

    LocalMediaIndex(string folder) { this.folder=folder; }

    public static bool IsStudio(string address) {
        return ShellPolicy.Trusted(address) && new Uri(address).AbsolutePath.TrimEnd('/')==BrowserPath;
    }

    static InvalidOperationException Error(string message) { return new InvalidOperationException(message); }

    static void RequireOrdinaryLocal(string path) {
        if(!Regex.IsMatch(path,@"\A[A-Za-z]:\\"))throw Error("请选择本机磁盘上的普通文件夹。");
        var drive=new DriveInfo(Path.GetPathRoot(path));
        if(drive.DriveType!=DriveType.Fixed && drive.DriveType!=DriveType.Removable && drive.DriveType!=DriveType.Ram)
            throw Error("请选择本机磁盘上的普通文件夹。");
        for(string item=path;item!=null;item=Path.GetDirectoryName(item)) {
            if((File.GetAttributes(item)&(FileAttributes.ReparsePoint|FileAttributes.Offline))!=0)
                throw Error("请选择原始文件夹或文件，暂不读取快捷链接与按需云文件。");
        }
    }

    public static LocalMediaIndex Scan(string path, CancellationToken cancellation) {
        string root=Path.GetFullPath(path), prefix=root.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        RequireOrdinaryLocal(root);
        string folderName=Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar));
        var index=new LocalMediaIndex(String.IsNullOrEmpty(folderName)?Path.GetPathRoot(root):folderName);
        var pending=new Stack<string>();
        pending.Push(root);
        int visited=0;
        while(pending.Count>0 && !index.truncated) {
            string directory=pending.Pop();
            try {
                RequireOrdinaryLocal(directory);
                foreach(string child in Directory.EnumerateFileSystemEntries(directory)) {
                    cancellation.ThrowIfCancellationRequested();
                    if(++visited>MaxVisited || index.entries.Count>=MaxEntries){index.truncated=true;break;}
                    try {
                        string source=Path.GetFullPath(child);
                        if(!source.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)){index.skipped++;continue;}
                        var attributes=File.GetAttributes(source);
                        if((attributes&SkippedAttributes)!=0){index.skipped++;continue;}
                        if((attributes&FileAttributes.Directory)!=0){pending.Push(source);continue;}
                        string ext=Path.GetExtension(source), name=Path.GetFileName(source);
                        if(!Formats.ContainsKey(ext))continue;
                        var info=new FileInfo(source);
                        if(info.Length<=0){index.skipped++;continue;}
                        index.entries.Add(new Entry { Name=name, Path=source, Relative=source.Substring(prefix.Length), Extension=ext,
                            Kind=Images.Contains(ext)?"image":Videos.Contains(ext)?"video":"audio", Bytes=info.Length, Modified=info.LastWriteTimeUtc });
                    } catch(IOException) { index.skipped++; } catch(UnauthorizedAccessException) { index.skipped++; }
                }
            } catch(IOException) { index.skipped++; } catch(UnauthorizedAccessException) { index.skipped++; } catch(InvalidOperationException) { index.skipped++; }
        }
        cancellation.ThrowIfCancellationRequested();
        index.entries.Sort((a,b)=>StringComparer.OrdinalIgnoreCase.Compare(a.Relative,b.Relative));
        index.lookup=index.entries.ToDictionary(e=>e.Id);
        return index;
    }

    public object Page(int offset, string search) {
        var matched=String.IsNullOrWhiteSpace(search) ? entries : entries.Where(e=>e.Relative.IndexOf(search.Trim(),StringComparison.OrdinalIgnoreCase)>=0).ToList();
        return new { indexId=id, folderName=folder, total=matched.Count, skipped, truncated,
            items=matched.Skip(offset).Take(PageSize).Select(e=>e.Client()).ToArray() };
    }

    public bool Matches(string indexId) { return indexId==id; }

    public Entry Find(string item) {
        Entry entry;
        if(!lookup.TryGetValue(item,out entry))throw Error("所选素材已失效，请重新选择文件夹。");
        return entry;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint controlCode, IntPtr bytesIn, uint sizeIn, IntPtr bytesOut, uint sizeOut, out uint returned, IntPtr overlapped);

    static FileStream Pin(Entry entry) {
        try {
            RequireOrdinaryLocal(entry.Path);
            var stream=new FileStream(entry.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan);
            try {
                var canonical=new StringBuilder(32768);
                uint size=GetFinalPathNameByHandle(stream.SafeFileHandle,canonical,(uint)canonical.Capacity,0);
                if(size==0 || size>=canonical.Capacity || !String.Equals(canonical.ToString(),@"\\?\"+entry.Path,StringComparison.OrdinalIgnoreCase) ||
                   stream.Length!=entry.Bytes || File.GetLastWriteTimeUtc(entry.Path)!=entry.Modified)
                    throw Error("原文件已发生变化，请重新索引文件夹。");
                return stream;
            } catch { stream.Dispose();throw; }
        } catch(IOException) { throw Error("原文件不可读取，请重新索引文件夹。"); }
          catch(UnauthorizedAccessException) { throw Error("原文件不可读取，请重新索引文件夹。"); }
    }

    public static Delivery Original(Entry entry,int maxBytes) {
        if(entry.Bytes>maxBytes)throw Error("该原片超过上传大小，请改用视频片段或选择更小的素材。");
        return new Delivery { File=Pin(entry), Name=entry.Name, Mime=MimeTypes[entry.Extension] };
    }

    public static Delivery Prepare(Entry entry,double start,bool excerpt,int maxBytes,CancellationToken cancellation) {
        using(var file=Pin(entry)) {
            if(excerpt && entry.Kind!="video")throw Error("只能从视频素材提取片段。");
            if(entry.Kind=="image" && !excerpt && !String.Equals(entry.Extension,".webp",StringComparison.OrdinalIgnoreCase)) {
                if(file.Length>32*1024*1024)throw Error("这张图超过本机预览限制。");
                try {
                    using(var image=Image.FromStream(file,false,true)) {
                        if((long)image.Width*image.Height>36000000)throw Error("这张图的尺寸超过本机预览限制。");
                        double factor=Math.Min(1,360.0/Math.Max(image.Width,image.Height));
                        using(var thumb=new Bitmap(Math.Max(1,(int)(image.Width*factor)),Math.Max(1,(int)(image.Height*factor))))
                        using(var graphics=Graphics.FromImage(thumb))
                        using(var output=new MemoryStream()) {
                            graphics.Clear(Color.White);
                            graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
                            graphics.DrawImage(image,new Rectangle(0,0,thumb.Width,thumb.Height));
                            thumb.Save(output,ImageFormat.Jpeg);
                            return new Delivery { Content=output.ToArray(), Name="preview.jpg", Mime="image/jpeg" };
                        }
                    }
                } catch(ArgumentException) { throw Error("图片无法解码，请选择有效的素材。"); }
            }
            return Encode(entry,start,excerpt,Math.Min(maxBytes,excerpt?ExcerptBytes:PreviewBytes),cancellation);
        }
    }

    static string FindFfmpeg() {
        var candidates=new List<string> { Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"tools","ffmpeg.exe") };
        candidates.AddRange((Environment.GetEnvironmentVariable("PATH")??"").Split(';')
            .Select(p=>p.Trim().Trim('"')).Where(p=>Regex.IsMatch(p,@"\A[A-Za-z]:[\\/]"))
            .Select(p=>Path.Combine(p,"ffmpeg.exe")));
        return candidates.FirstOrDefault(File.Exists);
    }

    static string Quote(string value) {
        string quoted=Regex.Replace(value,@"(\\*)""","$1$1\\\"");
        return "\""+Regex.Replace(quoted,@"(\\+)$","$1$1")+"\"";
    }

    static Delivery Encode(Entry entry,double start,bool excerpt,int maxBytes,CancellationToken cancellation) {
        string ffmpeg=FindFfmpeg();
        if(ffmpeg==null)throw Error("本机未找到 FFmpeg。请安装 FFmpeg 并加入 PATH，再重启小序以生成音视频预览或片段。");
        string ext=entry.Kind=="audio"?".m4a":entry.Kind=="image"?".jpg":".mp4";
        string output=Path.Combine(Path.GetTempPath(),"xuti-media-"+Guid.NewGuid().ToString("N")+ext);
        string mime=MimeTypes[ext];
        int duration=excerpt?10:5;
        var args=new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-filter_threads", "1", "-threads", "1",
            "-max_pixels", "36000000", "-protocol_whitelist", "file", "-f", Formats[entry.Extension], "-ss", start.ToString("0.###",CultureInfo.InvariantCulture), "-i", entry.Path };
        if(entry.Kind=="image")args.AddRange(new[]{ "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=360:360:force_original_aspect_ratio=decrease", "-update", "1" });
        else if(entry.Kind=="video")args.AddRange(new[]{ "-map", "0:v:0", "-map", "0:a:0?", "-t", duration.ToString(), "-vf",
            excerpt?"scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2":"scale=360:480:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-b:v", excerpt?"1800k":"450k", "-threads", "2", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart" });
        else args.AddRange(new[]{ "-map", "0:a:0", "-t", duration.ToString(), "-c:a", "aac", "-b:a", "96k" });
        args.AddRange(new[]{ "-fs", maxBytes.ToString(CultureInfo.InvariantCulture), output });
        try {
            cancellation.ThrowIfCancellationRequested();
            var startInfo=new ProcessStartInfo(ffmpeg,String.Join(" ",args.Select(Quote))) {
                UseShellExecute=false, CreateNoWindow=true, RedirectStandardError=true, RedirectStandardOutput=true, WorkingDirectory=Path.GetTempPath(),
            };
            using(var process=new Process{StartInfo=startInfo}) {
                process.OutputDataReceived+=(s,e)=>{};
                process.ErrorDataReceived+=(s,e)=>{};
                process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
                var timeout=Stopwatch.StartNew();
                try {
                    while(!process.WaitForExit(200)) {
                        cancellation.ThrowIfCancellationRequested();
                        if(timeout.ElapsedMilliseconds>40000)throw Error("本机预览等待超时，请换一段较短的素材。");
                    }
                    cancellation.ThrowIfCancellationRequested();
                    if(process.ExitCode!=0 || !File.Exists(output))throw Error("预览无法生成，请核对素材格式或片段起点。");
                } finally { if(!process.HasExited){process.Kill();process.WaitForExit(2000);} }
            }
            long size=new FileInfo(output).Length;
            if(size<(entry.Kind=="image"?256:1024) || size>=maxBytes)throw Error("生成的片段超过大小限制或没有有效画面，请调整起点。");
            string name=excerpt?Path.GetFileNameWithoutExtension(entry.Name)+"-片段.mp4":"preview"+ext;
            return new Delivery { Content=File.ReadAllBytes(output), Name=name, Mime=mime };
        } finally { if(File.Exists(output))File.Delete(output); }
    }

    public static int Integer(Dictionary<string,object> message,string key,int min,int max) {
        object value;
        if(!message.TryGetValue(key,out value)||!(value is int)||(int)value<min||(int)value>max)throw Error("本机素材请求参数无效。");
        return (int)value;
    }

    public static void ValidateAction(Dictionary<string,object> message,string action,string source,string current) {
        if(!IsStudio(source)||!IsStudio(current))throw Error("请在 AIGC 创作空间中选择本机素材。");
        var keys=new List<string>{"channel","action","id"};
        if(action!="media-index-open") {
            keys.Add("indexId");
            if(!Regex.IsMatch(AssistantForm.S(message,"indexId"),@"\A[a-f0-9]{32}\z"))throw Error("本机素材编号无效。");
            if(action=="media-index-page") {
                keys.AddRange(new[]{"offset","search"});
                Integer(message,"offset",0,MaxEntries);
                object search;
                if(message.TryGetValue("search",out search)&&(!(search is string)||((string)search).Length>128))throw Error("本机素材搜索词无效。");
            } else {
                keys.Add("assetId");
                if(!Regex.IsMatch(AssistantForm.S(message,"assetId"),@"\A[a-f0-9]{32}\z"))throw Error("本机素材编号无效。");
                if(action=="media-index-preview" || action=="media-index-excerpt") {
                    keys.Add("startSeconds");
                    Integer(message,"startSeconds",0,86400);
                }
                if(action=="media-index-file" || action=="media-index-excerpt") {
                    keys.Add("maxBytes");
                    Integer(message,"maxBytes",1,MaxFileBytes);
                }
            }
        }
        if(message.Keys.Any(k=>!keys.Contains(k)))throw Error("本机素材请求参数无效。");
    }

    public static void SelfTest() {
        string temp=Path.Combine(Path.GetTempPath(),"xuti-media-index-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        var folder=Directory.CreateDirectory(Path.Combine(temp,"input"));
        string large=Path.Combine(folder.FullName,"sample.mp4"), imagePath=Path.Combine(folder.FullName,"cover.png");
        try {
            long bytes=65536;
            using(var file=new FileStream(large,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                uint returned;
                if(DeviceIoControl(file.SafeFileHandle,0x900c4,IntPtr.Zero,0,IntPtr.Zero,0,out returned,IntPtr.Zero))bytes=64L*1024*1024*1024;
                file.SetLength(bytes);
            }
            using(var image=new Bitmap(24,32))image.Save(imagePath,ImageFormat.Png);
            File.WriteAllText(Path.Combine(folder.FullName,"ignored.txt"),"unsupported");
            var index=Scan(temp,CancellationToken.None);
            var entry=index.entries.Single(e=>e.Name=="sample.mp4");
            if(index.entries.Count!=2 || entry.Bytes!=bytes || entry.Relative!="input\\sample.mp4" || Directory.GetFiles(folder.FullName).Length!=3)
                throw new Exception("Local media index copied or omitted a source.");
            bool rejected=false;
            try { using(Original(entry,1024)){} } catch(InvalidOperationException) { rejected=true; }
            if(!rejected)throw new Exception("Oversized original entered a transfer.");
            var cover=index.entries.Single(e=>e.Name=="cover.png");
            using(var preview=Prepare(cover,0,false,PreviewBytes,CancellationToken.None)) {
                if(preview.Mime!="image/jpeg" || preview.Length==0)throw new Exception("Local cover preview missing.");
            }
            using(var file=Original(cover,MaxFileBytes))using(var stream=file.Take()) {
                if(file.Mime!="image/png" || stream.ReadByte()!=0x89)throw new Exception("Local selected asset read failed.");
            }
            File.AppendAllText(imagePath,"changed");
            rejected=false;
            try { using(Original(cover,MaxFileBytes)){} } catch(InvalidOperationException) { rejected=true; }
            if(!rejected)throw new Exception("Changed local asset remained selectable.");
        } finally {
            File.Delete(Path.Combine(folder.FullName,"ignored.txt"));File.Delete(imagePath);File.Delete(large);
            Directory.Delete(folder.FullName);Directory.Delete(temp);
        }
    }
}
}
