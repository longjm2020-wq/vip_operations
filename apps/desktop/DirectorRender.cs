using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace XutiDesktop {
sealed class DirectorVoice {
    public string sampleId {get;set;}
    public string text {get;set;}
    public string referenceText {get;set;}
    public bool authorized {get;set;}
}
sealed class DirectorPresenter {
    public string portraitId {get;set;}
}
sealed class DirectorTemplate {
    public string kind {get;set;}
    public string templateId {get;set;}
    public string imageId {get;set;}
    public Dictionary<string,string> fields {get;set;}
}
sealed class DirectorShot {
    public string id {get;set;}
    public string visualId {get;set;}
    public string audioId {get;set;}
    public string caption {get;set;}
    public string effect {get;set;}
    public string effectText {get;set;}
    public string title {get;set;}
    public string script {get;set;}
    public string purpose {get;set;}
    public string framing {get;set;}
    public string direction {get;set;}
    public string evidence {get;set;}
    public int startMs {get;set;}
    public int audioStartMs {get;set;}
    public int durationMs {get;set;}
    public DirectorVoice voice {get;set;}
    public DirectorPresenter presenter {get;set;}
    public DirectorTemplate template {get;set;}
}
sealed class DirectorPlan {
    public string aspect; public DirectorShot[] shots;
    internal void Validate(string project) {
        if(!new[]{"9:16","16:9","1:1"}.Contains(aspect) || shots==null || shots.Length<1 || shots.Length>100)
            throw DirectorMedia.Error("画幅或镜头数量无效。");
        var ids=new HashSet<string>();long length=0;
        foreach(var s in shots) {
            if(s==null || !ids.Add(DirectorMedia.Uuid(s.id)) || s.durationMs<100 || s.durationMs>600000 ||
               s.startMs<0 || s.startMs>86400000 || s.audioStartMs<0 || s.audioStartMs>86400000 ||
               !new[]{"none","fade","push-in","callout","size-card"}.Contains(s.effect) ||
               new[]{s.caption,s.effectText,s.title,s.script,s.purpose,s.framing,s.direction,s.evidence}.Any(t=>t!=null&&(t.Length>3600 || t.IndexOf('\0')>=0)))
                throw DirectorMedia.Error("分镜的时长、文案或动效无效。");
            var visual=DirectorMedia.Asset(project,DirectorMedia.Uuid(s.visualId));
            if(visual.kind=="audio" || (visual.durationMs.HasValue && visual.kind=="video" && s.startMs>=visual.durationMs.Value))
                throw DirectorMedia.Error("分镜画面或源片入点无效。");
            if(s.audioId!=null) {
                var a=DirectorMedia.Asset(project,DirectorMedia.Uuid(s.audioId));
                if(!a.hasAudio || (a.durationMs.HasValue && s.audioStartMs>=a.durationMs.Value))throw DirectorMedia.Error("所选音轨或音频入点无效。");
            }
            if(s.voice!=null) {
                if(!s.voice.authorized || String.IsNullOrWhiteSpace(s.voice.text) || s.voice.text.Length>3600 ||
                   (s.voice.referenceText??"").Length>3600 || !DirectorMedia.Asset(project,DirectorMedia.Uuid(s.voice.sampleId)).hasAudio)
                    throw DirectorMedia.Error("请绑定获得授权的声音样本和本镜台词。");
                if(s.audioId!=null)throw DirectorMedia.Error("每镜请选择正式录音或生成配音其中一项。");
            }
            if(s.presenter!=null && (DirectorMedia.Asset(project,DirectorMedia.Uuid(s.presenter.portraitId)).kind!="image" || (s.voice==null && s.audioId==null)))throw DirectorMedia.Error("主播镜头需要单张肖像和本镜配音。");
            if(s.template!=null) {
                var t=s.template;
                if(!new[]{"ae_template","lottie","pag"}.Contains(t.kind) || !Regex.IsMatch(t.templateId??"",@"^[a-zA-Z0-9_-]{1,80}$") ||
                   (t.fields!=null && t.fields.Any(x=>!new[]{"title","subtitle","product"}.Contains(x.Key) || x.Value==null || x.Value.Length>3600)) ||
                   (t.imageId!=null && DirectorMedia.Asset(project,DirectorMedia.Uuid(t.imageId)).kind!="image"))
                    throw DirectorMedia.Error("动效模板或替换字段无效。");
            }
            length+=s.durationMs;
        }
        if(length>600000)throw DirectorMedia.Error("单条短片的计划时长最多为 10 分钟。");
    }
}
sealed class DirectorClip {
    public string file,sha256,captionSource; public int durationMs;
    public List<DirectorCue> cues;
}
static class DirectorRender {
    internal const int Fps=25;
    internal static string Stamp(int ms) {
        return TimeSpan.FromMilliseconds(ms).ToString(@"hh\:mm\:ss\,fff",CultureInfo.InvariantCulture);
    }
    static List<DirectorCue> Cues(string caption,int duration) {
        var words=new List<string>();
        var part=new StringBuilder();int count=0;
        var letters=StringInfo.GetTextElementEnumerator((caption??"").Trim());
        while(letters.MoveNext()) {
            string c=letters.GetTextElement();
            if(c!="\r"&&c!="\n")part.Append(c);
            if(++count>=32 || "。！？!?；;\n".Contains(c)) {
                if(part.ToString().Trim().Length>0)words.Add(part.ToString().Trim());
                part.Clear();count=0;
            }
        }
        if(part.ToString().Trim().Length>0)words.Add(part.ToString().Trim());
        int frames=duration/40,weight=words.Sum(w=>w.Length),consumed=0,initial=0;
        var result=new List<DirectorCue>();
        foreach(var text in words) {
            consumed+=text.Length;
            int end=(int)Math.Round(frames*consumed/(double)weight)*40;
            if(end==initial && result.Count>0){result.Last().text+=text;continue;}
            result.Add(new DirectorCue{text=text,start=initial,end=end});initial=end;
        }
        while(result.Count>1 && result[0].end==0){result[1].text=result[0].text+result[1].text;result.RemoveAt(0);}
        return result;
    }
    static void Overlay(string path,int w,int h,DirectorShot s,string caption) {
        using(var image=new Bitmap(w,h,PixelFormat.Format32bppArgb))
        using(var g=Graphics.FromImage(image)) {
            g.SmoothingMode=SmoothingMode.AntiAlias; g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using(var font=new Font("Microsoft YaHei",Math.Max(18,w/23),FontStyle.Bold,GraphicsUnit.Pixel))
            using(var backing=new SolidBrush(Color.FromArgb(184,16,20,29)))
            using(var fmt=new StringFormat{Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center,Trimming=StringTrimming.EllipsisCharacter}) {
                if(caption.Length>0) {
                    int width=(int)(w*.86),height=Math.Min(h/2,Math.Max((int)font.Height+18,(int)g.MeasureString(caption,font,width-24).Height+22));
                    var box=new Rectangle((w-width)/2,h-height-h/12,width,height);
                    g.FillRectangle(backing,box);g.DrawString(caption,font,Brushes.White,new RectangleF(box.X+10,box.Y+4,box.Width-20,box.Height-8),fmt);
                }
                string label=(s.effectText??s.title??"").Trim();
                if((s.effect=="size-card" || s.effect=="callout")&&label.Length>0) {
                    int x=w/15,y=h/8,width=s.effect=="size-card"?w*3/4:w*2/3;
                    int height=Math.Min(h/3,(int)g.MeasureString(label,font,width-28).Height+32);
                    using(var card=new SolidBrush(s.effect=="size-card"?Color.FromArgb(236,242,235,223):Color.FromArgb(220,29,72,86))) {
                        g.FillRectangle(card,x,y,width,height);
                        g.DrawString(label,font,s.effect=="size-card"?Brushes.Black:Brushes.White,new RectangleF(x+12,y+5,width-24,height-10),fmt);
                    }
                }
            }
            image.Save(path,ImageFormat.Png);
        }
    }
    internal static string FileHash(string path) {
        using(var f=File.OpenRead(path))using(var h=System.Security.Cryptography.SHA256.Create())return DirectorMedia.Hex(h.ComputeHash(f));
    }
    static string SidecarPath() {return Path.Combine(Path.GetDirectoryName(typeof(DirectorRender).Assembly.Location),"director-media","director_media.py");}
    static string ConfigPath() {
        return Environment.GetEnvironmentVariable("XUTI_DIRECTOR_MEDIA_CONFIG")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XutiDesktop","director-media.json");
    }
    static string ProviderStamp(string templateId) {
        string script=SidecarPath(),config=ConfigPath(),dir=Path.GetDirectoryName(script);
        var files=new List<string>{script,config,Path.Combine(dir,"motion.cjs")};
        if(templateId!=null) {
            string registered=templateId=="product-title"?Path.Combine(dir,"lower-third.json"):null;
            if(File.Exists(config)){
                var cfg=DirectorMedia.Json().Deserialize<Dictionary<string,object>>(File.ReadAllText(config));
                var templates=DirectorStudio.Value(cfg,"templates") as Dictionary<string,object>;
                var binding=DirectorStudio.Value(templates,templateId) as Dictionary<string,object>;
                var selected=DirectorStudio.Value(binding,"path") as string;
                if(selected!=null && Path.IsPathRooted(selected))registered=selected;
            }
            if(registered!=null)files.Add(registered);
        }
        return String.Join("|",files.Select(path=>File.Exists(path)?FileHash(path):"missing"));
    }
    internal static Dictionary<string,object> Capabilities(string exe) {
        var ret=new Dictionary<string,object>{{"ffmpeg",false},{"installation","从 ffmpeg.org/download.html 的 Windows 构建安装包含 libx264、AAC 的 FFmpeg，将 bin 加入 PATH，或设置 XUTI_DIRECTOR_FFMPEG 为 ffmpeg.exe 的完整路径，然后重启小序。"},{"voice_clone",false},{"talking_head",false},{"templates",new object[0]}};
        if(exe!=null)try {
            var enc=DirectorMedia.Exec(exe,new[]{"-hide_banner","-encoders"},Path.GetDirectoryName(exe),CancellationToken.None,7000);
            ret["ffmpeg"]=Regex.IsMatch(enc,@"\blibx264\s") && Regex.IsMatch(enc,@"\baac\s");
        }catch(InvalidOperationException){}
        var python=DirectorMedia.Python();
        if(python!=null && File.Exists(SidecarPath()) && File.Exists(ConfigPath()))try {
            var output=DirectorMedia.Exec(python,new[]{SidecarPath(),"--capabilities"},Path.GetDirectoryName(SidecarPath()),CancellationToken.None,50000);
            var caps=DirectorMedia.Json().Deserialize<Dictionary<string,object>>(output);
            foreach(string k in new[]{"voice_clone","talking_head","templates"})if(caps.ContainsKey(k))ret[k]=caps[k];
        }catch(Exception){}
        ret["autoSubs"]=false;
        try{var speech=DirectorTranscription.Load();ret["autoSubs"]=speech.CanStart();if(speech.exe!=null)ret["autoSubsModel"]=speech.model;}catch(InvalidOperationException){}
        return ret;
    }
    static string Generate(string jobDir,Dictionary<string,object> config,string output,CancellationToken stop) {
        string python=DirectorMedia.Python(),script=SidecarPath();
        if(python==null || !File.Exists(script))throw DirectorMedia.Error("该镜头需要本机媒体适配器，请配置 Python、模型或已登记模板。");
        string job=Path.Combine(jobDir,"media-"+Guid.NewGuid().ToString("N")+".json"),result=Path.Combine(jobDir,output);
        var cacheInputs=new SortedDictionary<string,object>(config);
        foreach(var name in new[]{"samplePath","portraitPath","audioPath","imagePath"}) {
            object value;if(cacheInputs.TryGetValue(name,out value) && value is string)cacheInputs[name]=FileHash((string)value);
        }
        string key=DirectorMedia.Hash(DirectorMedia.Utf8.GetBytes(DirectorMedia.Canonical(cacheInputs)+ProviderStamp(DirectorStudio.Value(config,"templateId") as string)));
        string cached=Path.Combine(Path.GetDirectoryName(jobDir),key+Path.GetExtension(output)),meta=cached+".sha256";
        if(File.Exists(cached) && File.Exists(meta) && FileHash(cached)==File.ReadAllText(meta))return cached;
        DirectorMedia.Save(job,DirectorMedia.Json().Serialize(config));
        DirectorMedia.Exec(python,new[]{script,"--job",job,"--output",result},jobDir,stop,3900000);
        if(!File.Exists(result)||new FileInfo(result).Length<32)throw DirectorMedia.Error("媒体适配器未生成镜头文件。");
        string digest=FileHash(result);DirectorMedia.PublishFile(result,cached);DirectorMedia.Save(meta,digest);return cached;
    }
    internal static int AudioMs(string ffmpeg,string path,string ext,string dir,CancellationToken stop) {
        var args=DirectorMedia.Begin();args.AddRange(new[]{"-loglevel","info"});DirectorMedia.Input(args,path,ext);
        args.AddRange(new[]{"-map","0:a:0","-t","0.02","-f","null","-"});
        var m=Regex.Match(DirectorMedia.Exec(ffmpeg,args,dir,stop),@"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)");
        if(!m.Success)throw DirectorMedia.Error("无法测量生成配音的实际时长。");
        return (int)Math.Ceiling(1000*(Int32.Parse(m.Groups[1].Value)*3600+Int32.Parse(m.Groups[2].Value)*60+Double.Parse(m.Groups[3].Value,CultureInfo.InvariantCulture)));
    }
    static DirectorClip RenderShot(string project,string cache,string ffmpeg,int w,int h,DirectorShot s,CancellationToken stop,out bool reused) {
        reused=false;
        Func<string,DirectorAsset> asset=id=>DirectorMedia.Asset(project,id);
        Func<string,string> source=id=>DirectorMedia.PathFor(project,asset(id));
        var visual=asset(s.visualId);
        var refs=new[]{s.visualId,s.audioId,s.voice==null?null:s.voice.sampleId,s.presenter==null?null:s.presenter.portraitId,s.template==null?null:s.template.imageId}.Where(id=>id!=null).Select(id=>asset(id).hash);
        bool speechSubtitles=s.audioId!=null && String.IsNullOrWhiteSpace(s.caption);
        var speech=speechSubtitles?DirectorTranscription.Load():null;
        var settings=DirectorMedia.Canonical(new{s.visualId,s.audioId,s.caption,s.effect,s.effectText,cardTitle=s.effectText==null?s.title:null,s.startMs,s.audioStartMs,s.durationMs,s.voice,s.presenter,s.template,
            fallback=speechSubtitles && speech.exe==null?s.script:null,transcription=speechSubtitles?speech.Stamp():null});
        string sidecarFingerprint="";
        if(s.voice!=null||s.presenter!=null||s.template!=null) {
            sidecarFingerprint=ProviderStamp(s.template==null?null:s.template.templateId);
        }
        string key=DirectorMedia.Hash(DirectorMedia.Utf8.GetBytes("v3|"+w+"x"+h+"|"+Fps+"|"+File.GetLastWriteTimeUtc(ffmpeg).Ticks+"|"+settings+"|"+String.Join("|",refs)+"|"+sidecarFingerprint));
        string dest=Path.Combine(cache,key+".mp4"),meta=Path.Combine(cache,key+".json");
        if(File.Exists(dest)&&File.Exists(meta)) {
            var clip=DirectorMedia.Json().Deserialize<DirectorClip>(File.ReadAllText(meta));
            if(clip.durationMs>0 && clip.cues!=null && FileHash(dest)==clip.sha256){reused=true;clip.file=dest;return clip;}
        }
        string job=Directory.CreateDirectory(Path.Combine(cache,"work-"+Guid.NewGuid().ToString("N"))).FullName;
        try {
            var audio=s.audioId!=null?asset(s.audioId):null;
            string aPath=audio==null?null:source(audio.id),aExt=audio==null?null:audio.ext;
            string vPath=source(visual.id),vExt=visual.ext;
            int duration=s.durationMs,aStart=s.audioStartMs,vStart=s.startMs;
            if(s.voice!=null) {
                aPath=Generate(job,new Dictionary<string,object>{{"kind","voice_clone"},{"samplePath",source(s.voice.sampleId)},{"text",s.voice.text},{"referenceText",s.voice.referenceText}},"voice.wav",stop);
                aExt=".wav";aStart=0;duration=AudioMs(ffmpeg,aPath,aExt,job,stop);
                if(duration<40 || duration>600000)throw DirectorMedia.Error("生成配音时长超出单镜范围。");
            }
            duration=((duration+39)/40)*40;
            string sec=DirectorMedia.Sec(duration);
            string captionSource=String.IsNullOrWhiteSpace(s.caption)?"none":"caption";
            var subtitles=Cues(s.caption,duration);
            if(speechSubtitles) {
                if(speech.exe!=null) {
                    subtitles=speech.Run(ffmpeg,aPath,aExt,aStart,duration,job,cache,audio.hash,stop);captionSource="autosubs";
                } else if(!String.IsNullOrWhiteSpace(s.script)) {
                    subtitles=Cues(s.script,duration);captionSource="script";
                } else throw DirectorMedia.Error("本镜有正式录音但尚无字幕。请填写字幕或台词，或在本机配置 AutoSubs 后继续。");
            } else if(subtitles.Count==0 && s.voice!=null) {
                subtitles=Cues(s.voice.text,duration);captionSource="script";
            }
            if(s.presenter!=null) {
                var slice=DirectorMedia.Begin();slice.AddRange(new[]{"-ss",DirectorMedia.Sec(aStart)});DirectorMedia.Input(slice,aPath,aExt);
                string narration=Path.Combine(job,"presenter-audio.wav");slice.AddRange(new[]{"-vn","-t",sec,"-ac","1","-ar","16000","-c:a","pcm_s16le",narration});
                DirectorMedia.Exec(ffmpeg,slice,job,stop);
                vPath=Generate(job,new Dictionary<string,object>{{"kind","talking_head"},{"portraitPath",source(s.presenter.portraitId)},{"audioPath",narration}},"presenter.mp4",stop);
                vExt=".mp4";vStart=0;
            }
            string motion=null;
            if(s.template!=null)motion=Generate(job,new Dictionary<string,object>{{"kind",s.template.kind},{"templateId",s.template.templateId},{"fields",s.template.fields??new Dictionary<string,string>()},{"imagePath",s.template.imageId==null?null:source(s.template.imageId)},{"durationMs",duration},{"width",w},{"height",h},{"fps",Fps}},"template.mov",stop);
            var args=DirectorMedia.Begin();
            if(vStart>0)args.AddRange(new[]{"-ss",DirectorMedia.Sec(vStart)});
            DirectorMedia.Input(args,vPath,vExt);
            int next=1;string audioStream;
            if(aPath!=null) {
                args.AddRange(new[]{"-ss",DirectorMedia.Sec(aStart)});DirectorMedia.Input(args,aPath,aExt);
                audioStream="["+(next++)+":a:0]";
            } else if(visual.hasAudio && s.presenter==null)audioStream="[0:a:0]";
            else {args.AddRange(new[]{"-f","lavfi","-i","anullsrc=r=48000:cl=stereo"});audioStream="["+(next++)+":a:0]";}
            string filter="[0:v:0]fps="+Fps+",scale="+w+":"+h+":force_original_aspect_ratio=decrease:force_divisible_by=2,pad="+w+":"+h+":(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration="+sec+",trim=duration="+sec+",setpts=PTS-STARTPTS";
            if(s.effect=="push-in")filter+=",zoompan=z='1+min(on*0.0012,0.16)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s="+w+"x"+h+":fps="+Fps;
            if(s.effect=="fade") {
                int fade=Math.Min(duration/2,360);
                filter+=",fade=t=in:st=0:d="+DirectorMedia.Sec(fade)+",fade=t=out:st="+DirectorMedia.Sec(duration-fade)+":d="+DirectorMedia.Sec(fade);
            }
            filter+="[base];";string image="base";
            if(motion!=null){DirectorMedia.Input(args,motion,".mov");filter+="[base]["+(next++)+":v:0]overlay=eof_action=pass[motion];";image="motion";}
            if(subtitles.Count>0||s.effect=="size-card"||s.effect=="callout") {
                var cues=DirectorTranscription.Coverage(subtitles,duration);
                var seq=new StringBuilder();
                for(int i=0;i<cues.Count;i++) {
                    stop.ThrowIfCancellationRequested();
                    string name="caption-"+i+".png";Overlay(Path.Combine(job,name),w,h,s,cues[i].text);
                    seq.Append("file '").Append(name).Append("'\nduration ").Append(DirectorMedia.Sec(cues[i].end-cues[i].start)).Append("\n");
                    if(i==cues.Count-1)seq.Append("file '").Append(name).Append("'\n");
                }
                string captions=Path.Combine(job,"captions.txt");File.WriteAllText(captions,seq.ToString(),DirectorMedia.Utf8);
                args.AddRange(new[]{"-threads","2","-protocol_whitelist","file","-f","concat","-safe","1","-i",captions});
                filter+="["+image+"]["+(next++)+":v:0]overlay=eof_action=repeat:format=auto[captioned];";image="captioned";
            }
            filter+="["+image+"]format=yuv420p[v];"+audioStream+"aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration="+sec+",asetpts=PTS-STARTPTS[a]";
            string tmp=Path.Combine(job,"clip.mp4");
            args.AddRange(new[]{"-filter_complex",filter,"-map","[v]","-map","[a]","-t",sec,"-c:v","libx264","-threads","2","-preset","veryfast","-crf","21","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","2","-b:a","128k","-map_metadata","-1",tmp});
            DirectorMedia.Exec(ffmpeg,args,job,stop);stop.ThrowIfCancellationRequested();
            var clip=new DirectorClip{file=dest,sha256=FileHash(tmp),durationMs=duration,cues=subtitles,captionSource=captionSource};
            DirectorMedia.PublishFile(tmp,dest);DirectorMedia.Save(meta,DirectorMedia.Json().Serialize(clip));
            return clip;
        } finally {if(Directory.Exists(job))Directory.Delete(job,true);}
    }
    internal static void Run(string project,string output,DirectorPlan plan,string ffmpeg,CancellationToken stop,Action<int,int,string> update) {
        plan.Validate(project);
        if(ffmpeg==null)throw DirectorMedia.Error("请先安装 FFmpeg，再继续生成。");
        int w=plan.aspect=="16:9"?1280:720,h=plan.aspect=="9:16"?1280:720;
        string cache=Directory.CreateDirectory(Path.Combine(project,"cache")).FullName;
        var clips=new List<DirectorClip>();int reused=0,elapsed=0,cueIndex=0;
        var subtitles=new StringBuilder();var board=new StringBuilder();var timeline=new List<object>();
        for(int i=0;i<plan.shots.Length;i++) {
            stop.ThrowIfCancellationRequested();var s=plan.shots[i];bool hit;
            update(i,reused,"正在制作第 "+(i+1)+" / "+plan.shots.Length+" 镜");
            var clip=RenderShot(project,cache,ffmpeg,w,h,s,stop,out hit);if(hit)reused++;clips.Add(clip);
            foreach(var cue in clip.cues)subtitles.AppendLine((++cueIndex).ToString()).AppendLine(Stamp(elapsed+cue.start)+" --> "+Stamp(elapsed+cue.end)).AppendLine(cue.text).AppendLine();
            var v=DirectorMedia.Asset(project,s.visualId);
            board.AppendLine((i+1)+". "+(s.title??"分镜")+"    "+Stamp(elapsed)+" – "+Stamp(elapsed+clip.durationMs))
                .AppendLine("画面："+v.name+"  ["+v.id+"]").AppendLine("台词："+(s.script??s.caption??"")).AppendLine("字幕："+String.Join(" ",clip.cues.Select(c=>c.text))).AppendLine("动效："+(s.template!=null?s.template.templateId:s.effect));
            if(s.audioId!=null)board.AppendLine("配音："+DirectorMedia.Asset(project,s.audioId).name);
            if(s.voice!=null)board.AppendLine("生成配音："+DirectorMedia.Asset(project,s.voice.sampleId).name);
            foreach(string text in new[]{s.purpose,s.framing,s.direction,s.evidence})if(!String.IsNullOrWhiteSpace(text))board.AppendLine(text);
            board.AppendLine(); timeline.Add(new{shot=s,startMs=elapsed,endMs=elapsed+clip.durationMs,sourceName=v.name,captionSource=clip.captionSource,subtitles=clip.cues,verifiedSha256=clip.sha256});
            elapsed+=clip.durationMs;if(elapsed>600000)throw DirectorMedia.Error("实际配音使成片超过 10 分钟，请拆分项目。");update(i+1,reused,"已核验 "+(i+1)+" / "+plan.shots.Length+" 镜");
        }
        stop.ThrowIfCancellationRequested();
        update(clips.Count,reused,"正在拼接音画并核验成片");
        string work=Directory.CreateDirectory(Path.Combine(cache,"export-"+Guid.NewGuid().ToString("N"))).FullName;
        try {
            // Only renderer-generated hexadecimal cache filenames enter the concat manifest.
            string list=Path.Combine(cache,"concat-"+Guid.NewGuid().ToString("N")+".txt");
            string final=Path.Combine(work,"video.mp4");
            try {
                File.WriteAllText(list,String.Join("\n",clips.Select(c=>"file '"+Path.GetFileName(c.file)+"'\nduration "+DirectorMedia.Sec(c.durationMs)))+"\n",DirectorMedia.Utf8);
                var cmd=DirectorMedia.Begin();cmd.AddRange(new[]{"-protocol_whitelist","file","-f","concat","-safe","1","-i",list,"-map","0:v:0","-map","0:a:0","-c:v","copy","-c:a","aac","-ar","48000","-af","aresample=async=1:first_pts=0","-t",DirectorMedia.Sec(elapsed),"-movflags","+faststart",final});
                DirectorMedia.Exec(ffmpeg,cmd,work,stop);
            } finally {if(File.Exists(list))File.Delete(list);}
            var verify=DirectorMedia.Begin();DirectorMedia.Input(verify,final,".mp4");
            verify.AddRange(new[]{"-xerror","-map","0:v:0","-map","0:a:0","-f","null","-"});
            DirectorMedia.Exec(ffmpeg,verify,work,stop);
            int actual=AudioMs(ffmpeg,final,".mp4",work,stop);
            if(Math.Abs(actual-elapsed)>200)throw DirectorMedia.Error("导出文件时长与分镜不一致，请重新生成。");
            File.WriteAllText(Path.Combine(work,"subtitles.srt"),subtitles.ToString(),DirectorMedia.Utf8);
            File.WriteAllText(Path.Combine(work,"storyboard.txt"),board.ToString(),DirectorMedia.Utf8);
            File.WriteAllText(Path.Combine(work,"edit-plan.json"),DirectorMedia.Json().Serialize(new{schemaVersion=1,aspect=plan.aspect,width=w,height=h,fps=Fps,durationMs=elapsed,shots=plan.shots,timeline}),DirectorMedia.Utf8);
            stop.ThrowIfCancellationRequested();
            foreach(string file in new[]{"video.mp4","subtitles.srt","storyboard.txt","edit-plan.json"})DirectorMedia.PublishFile(Path.Combine(work,file),Path.Combine(output,file));
        } finally {if(Directory.Exists(work))Directory.Delete(work,true);}
    }
}
}
