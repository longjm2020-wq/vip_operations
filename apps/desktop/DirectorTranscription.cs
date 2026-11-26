using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace XutiDesktop {
sealed class DirectorCue {
    public string text;
    public int start,end;
}
sealed class DirectorTranscription {
    internal string exe, model="base",language="zh";
    internal static DirectorTranscription Load() {
        var t=new DirectorTranscription();
        string config=Environment.GetEnvironmentVariable("XUTI_DIRECTOR_MEDIA_CONFIG")??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktop","director-media.json");
        if(!File.Exists(config))return t;
        var cfg=DirectorMedia.Json().Deserialize<Dictionary<string,object>>(File.ReadAllText(config));
        var path=DirectorStudio.Value(cfg,"autoSubs") as string;
        if(String.IsNullOrWhiteSpace(path))return t;
        if(!Regex.IsMatch(path,@"^[A-Za-z]:[\\/]") || !String.Equals(Path.GetFileName(path),"autosubs.exe",StringComparison.OrdinalIgnoreCase)||!File.Exists(path))
            throw DirectorMedia.Error("AutoSubs 配置路径无效，请在本机设置 autoSubs 为已安装的 autosubs.exe。");
        t.exe=Path.GetFullPath(path);
        t.model=DirectorStudio.Value(cfg,"autoSubsModel") as string??"base";
        t.language=DirectorStudio.Value(cfg,"autoSubsLanguage") as string??"zh";
        if(!new[]{"tiny","base","small","medium","large-v3"}.Contains(t.model) || !Regex.IsMatch(t.language,@"^(?:auto|[a-z]{2,3})$"))
            throw DirectorMedia.Error("请核对本机 AutoSubs 的 Whisper 模型与语言设置。");
        return t;
    }
    internal string Stamp() {return exe==null?"no-autosubs":exe+"|"+File.GetLastWriteTimeUtc(exe).Ticks+"|"+model+"|"+language;}
    internal bool CanStart() {
        if(exe==null)return false;
        uint code;
        var help=DirectorProcess.Run(exe,new[]{"--help"},Path.GetDirectoryName(exe),CancellationToken.None,6000,out code);
        return code==0 && help.Contains("--model") && help.Contains("--lang");
    }
    static int Milliseconds(Match m,string key) {
        var g=m.Groups[key].Value.Replace('.',',');
        TimeSpan t;
        if(!TimeSpan.TryParseExact(g,@"hh\:mm\:ss\,fff",CultureInfo.InvariantCulture,out t))
            throw DirectorMedia.Error("AutoSubs 返回了无效的 SRT 时间码。");
        return checked((int)t.TotalMilliseconds);
    }
    internal static List<DirectorCue> Parse(string srt,int limit) {
        if(srt==null || srt.Length>512*1024)throw DirectorMedia.Error("本地转写字幕为空或过大。");
        var cues=new List<DirectorCue>();
        foreach(var block in Regex.Split(srt.Trim().TrimStart('\uFEFF'),@"\r?\n[ \t]*\r?\n")) {
            if(String.IsNullOrWhiteSpace(block))continue;
            var lines=Regex.Split(block.Trim(),@"\r?\n");
            int header=Regex.IsMatch(lines[0],@"^\d+$")?1:0;
            if(header+1>=lines.Length)throw DirectorMedia.Error("AutoSubs 返回了无效的 SRT 分段。");
            var m=Regex.Match(lines[header],@"^\s*(?<start>\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(?<end>\d{2}:\d{2}:\d{2}[,.]\d{3})\s*$");
            if(!m.Success)throw DirectorMedia.Error("AutoSubs 返回了无效的 SRT 时间码。");
            int start=Milliseconds(m,"start"),end=Milliseconds(m,"end");
            if(start>=limit || end<=start)continue;
            if(cues.Count>0)start=Math.Max(start,cues.Last().end);
            end=Math.Min(limit,end);
            string text=String.Join("\n",lines.Skip(header+1)).Trim();
            if(end<=start||text.Length==0)continue;
            if(text.Length>3600||cues.Count>=2000)throw DirectorMedia.Error("本镜的自动字幕过长，请缩短音频片段。");
            cues.Add(new DirectorCue{text=text,start=start,end=end});
        }
        if(cues.Count==0)throw DirectorMedia.Error("AutoSubs 没有在本镜录音中识别到语音，请检查录音入点或填写字幕。");
        return cues;
    }
    internal List<DirectorCue> Run(string ffmpeg,string audio,string ext,int from,int duration,string job,string cache,string audioHash,CancellationToken stop) {
        string cacheKey=DirectorMedia.Hash(DirectorMedia.Utf8.GetBytes("asr-v1|"+audioHash+"|"+from+"|"+duration+"|"+Stamp()));
        string cached=Path.Combine(cache,cacheKey+".srt");
        if(File.Exists(cached))return Parse(DirectorMedia.ReadText(cached),duration);
        string wav=Path.Combine(job,"narration.wav"),srt=Path.Combine(job,"speech.srt");
        var trim=DirectorMedia.Begin();trim.AddRange(new[]{"-ss",DirectorMedia.Sec(from)});DirectorMedia.Input(trim,audio,ext);
        trim.AddRange(new[]{"-map","0:a:0","-vn","-t",DirectorMedia.Sec(duration),"-ac","1","-ar","16000","-c:a","pcm_s16le",wav});
        DirectorMedia.Exec(ffmpeg,trim,job,stop);
        var args=new List<string>{wav,"--model",model,"--no-gpu","-f","srt","-o",srt};
        if(language!="auto")args.AddRange(new[]{"--lang",language});
        uint exit;
        DirectorProcess.Run(exe,args.ToArray(),Path.GetDirectoryName(exe),stop,3900000,out exit);
        if(exit!=0 || !File.Exists(srt))throw DirectorMedia.Error("本机 AutoSubs 转写失败。请检查 Whisper 模型是否已下载，或在镜头中手动填写字幕。");
        if(new FileInfo(srt).Length>512*1024)throw DirectorMedia.Error("本镜的转写结果过大。");
        string content=DirectorMedia.ReadText(srt);
        var cues=Parse(content,duration);
        DirectorMedia.Save(cached,content);
        return cues;
    }
    internal static List<DirectorCue> Coverage(List<DirectorCue> cues,int duration) {
        var all=new List<DirectorCue>();int last=0;
        foreach(var cue in cues){
            if(cue.start>last)all.Add(new DirectorCue{text="",start=last,end=cue.start});
            all.Add(cue);last=cue.end;
        }
        if(last<duration)all.Add(new DirectorCue{text="",start=last,end=duration});
        return all;
    }
}
}
