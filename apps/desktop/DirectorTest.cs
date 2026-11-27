using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace XutiDesktop {
static class DirectorTest {
    static void Check(bool pass,string reason){if(!pass)throw new Exception(reason);}
    static DirectorReceipt Wait(DirectorStudio studio,string path) {
        var clock=Stopwatch.StartNew();
        while(clock.Elapsed.TotalSeconds<150) {
            var r=studio.Status(path);
            if(r.state!="running")return r;Thread.Sleep(70);
        }
        throw new Exception("Director fixture exceeded timeout.");
    }
    public static void Policy() {
        var id=Guid.NewGuid().ToString();
        var json=DirectorMedia.Json();var origin=ShellPolicy.Origin;
        var envelope=new{channel="xuti-desktop",id,action="director-capabilities",payload=new{}};
        ShellPolicy.Message(origin+"/my-workspace/director",origin+"/my-workspace/director",json.Serialize(envelope));
        foreach(var denied in new[]{origin+"/my-workspace","https://other.invalid/my-workspace/director"}) {
            bool failed=false;try{ShellPolicy.Message(denied,origin+"/my-workspace/director",json.Serialize(envelope));}catch{failed=true;}
            Check(failed,"Director policy accepted foreign source or route");
        }
        bool bypass=false;
        try{ShellPolicy.Message(origin+"/my-workspace/director",origin+"/my-workspace/director",json.Serialize(new{channel="xuti-desktop",id,action="director-pick",payload=new{projectId=id,kind="files",path="C:\\secret"}}));}catch{bypass=true;}
        Check(bypass,"Director accepted a caller-provided path");
        string another=Guid.NewGuid().ToString(),grant=json.Serialize(new{data=new{projectId=id,deviceId=another}});
        Check(DirectorStudio.Granted(grant,id,another) && !DirectorStudio.Granted(grant,another,id),"Native project/device grant isolation failed");
        var cues=DirectorTranscription.Parse("1\r\n00:00:00,160 --> 00:00:00,480\r\n你好\r\n\r\n2\r\n00:00:00,720 --> 00:00:02,000\r\n袖口\r\n示意\r\n",1000);
        var overlay=DirectorTranscription.Coverage(cues,1000);
        Check(cues.Count==2 && cues[1].end==1000 && cues[1].text=="袖口\n示意" && overlay.Count==4 && overlay[0].text=="" && overlay[2].start==480 && overlay[2].end==720,"Transcribed SRT silence or clip bounds lost");
    }
    internal static int AutoSubs() {
        string temp=Directory.CreateDirectory(Path.Combine(Path.GetTempPath(),"xuti-"+Path.GetRandomFileName())).FullName;
        try {
            string audio=Environment.GetEnvironmentVariable("XUTI_DIRECTOR_TEST_ASR_WAV");
            if(String.IsNullOrWhiteSpace(audio)||!File.Exists(audio)||Path.GetExtension(audio).ToLowerInvariant()!=".wav")throw new Exception("Set XUTI_DIRECTOR_TEST_ASR_WAV to a synthetic Chinese speech recording.");
            string ff=DirectorMedia.Ffmpeg(),project=Directory.CreateDirectory(Path.Combine(temp,"project")).FullName;
            Check(DirectorTranscription.Load().CanStart(),"Official AutoSubs CLI did not pass startup check.");
            string image=Path.Combine(temp,"asr.png");using(var bitmap=new Bitmap(360,640))using(var g=Graphics.FromImage(bitmap)){g.Clear(Color.Teal);bitmap.Save(image,System.Drawing.Imaging.ImageFormat.Png);}
            Func<string,DirectorAsset> add=file=>{using(var f=File.OpenRead(file))return DirectorMedia.Import(project,Guid.NewGuid().ToString(),Path.GetFileName(file),f,ff,CancellationToken.None);};
            var visual=add(image);var narration=add(audio);int duration=Math.Min(12000,narration.durationMs.Value);
            var shot=new DirectorShot{id=Guid.NewGuid().ToString(),visualId=visual.id,audioId=narration.id,durationMs=duration,caption="",effect="none"};
            var plan=new DirectorPlan{aspect="9:16",shots=new[]{shot}};
            var studio=new DirectorStudio(temp);studio.Start(project,1,plan,ff,false);
            string output=DirectorStudio.Out(project,1);var time=Stopwatch.StartNew();
            DirectorReceipt job;
            do {Thread.Sleep(120);job=studio.Status(output);if(time.Elapsed.TotalMinutes>20)throw new Exception("AutoSubs smoke timed out.");}while(job.state=="running");
            Check(job.state=="completed",job.stage);
            string srt=File.ReadAllText(Path.Combine(output,"subtitles.srt")),recipe=File.ReadAllText(Path.Combine(output,"edit-plan.json"));
            var actual=DirectorTranscription.Parse(srt,((duration+39)/40)*40);
            Check(actual.Count>0&&actual.Any(c=>Regex.IsMatch(c.text,@"[\u3400-\u9fff]"))&&recipe.Contains("\"captionSource\":\"autosubs\""),"Expected actual Chinese ASR cues.");
            var cue=actual.OrderByDescending(c=>c.end-c.start).First();
            string frame=Path.Combine(temp,"verified-caption.png");
            DirectorMedia.Exec(ff,new[]{"-nostdin","-hide_banner","-v","error","-ss",DirectorMedia.Sec((cue.start+cue.end)/2),"-i",Path.Combine(output,"video.mp4"),"-frames:v","1","-threads","1",frame},temp,CancellationToken.None);
            int dark=0,white=0;
            using(var pic=new Bitmap(frame))for(int y=pic.Height/2;y<pic.Height;y+=2)for(int x=0;x<pic.Width;x+=2) {
                var px=pic.GetPixel(x,y);if(px.R<45&&px.G<65&&px.B<65)dark++;if(px.R>220&&px.G>220&&px.B>220)white++;
            }
            Check(dark>1000&&white>80,"Exported MP4 did not contain burned, readable text over the plain test frame");
            Console.WriteLine("AutoSubs real local speech test: "+actual.Count+" timed Chinese cues; verified burned glyphs, SRT, edit-plan and speech MP4 in "+time.ElapsedMilliseconds+" ms.");
            if(Environment.GetEnvironmentVariable("XUTI_DIRECTOR_KEEP_FIXTURE")=="1")Console.WriteLine("Fixture: "+output);
            return 0;
        }catch(Exception e){Console.WriteLine(e.ToString());return 1;}
        finally{if(Environment.GetEnvironmentVariable("XUTI_DIRECTOR_KEEP_FIXTURE")!="1")Directory.Delete(temp,true);}
    }
    internal static int Child(string[] args) {
        if(args.Length==1 && args[0]=="--self-test-director-child-sleep"){Thread.Sleep(30000);return 0;}
        if(args.Length<2 || !Regex.IsMatch(args[1],@"^xuti-[a-z0-9]{8}\.[a-z0-9]{3}$"))return 2;
        string temp=Path.Combine(Path.GetTempPath(),args[1]);DirectorMedia.PlainLocal(temp);
        if(args.Length==3 && args[0]=="--self-test-director-child-lock" && Regex.IsMatch(args[2],@"^[0-9a-f]{40}$")){
            try{using(var lease=File.Open(Path.Combine(temp,args[2],"render.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None))return 3;}
            catch(IOException e){return (e.HResult&65535)==32?0:3;}
        }
        if(args.Length!=2||args[0]!="--self-test-director-child-tree")return 2;
        var info=new ProcessStartInfo(System.Windows.Forms.Application.ExecutablePath,"--self-test-director-child-sleep"){UseShellExecute=false,CreateNoWindow=true};
        using(var sub=Process.Start(info)) {
            DirectorMedia.Save(Path.Combine(temp,"tree.pid"),Process.GetCurrentProcess().Id+" "+sub.Id);
            Thread.Sleep(30000);
        }
        return 0;
    }
    static void ProcessTree(string temp) {
        string marker=Path.Combine(temp,"tree.pid");
        using(var stop=new CancellationTokenSource()) {
            var worker=Task.Run(()=>{
                try{DirectorMedia.Exec(System.Windows.Forms.Application.ExecutablePath,new[]{"--self-test-director-child-tree",Path.GetFileName(temp)},temp,stop.Token,35000);return false;}
                catch(OperationCanceledException){return true;}
            });
            try {
                string ids=null;
                for(int i=0;i<100 && String.IsNullOrWhiteSpace(ids);i++) {
                    if(File.Exists(marker))ids=File.ReadAllText(marker);if(String.IsNullOrWhiteSpace(ids))Thread.Sleep(40);
                }
                Check(!String.IsNullOrWhiteSpace(ids),"Renderer descendant did not start");
                stop.Cancel();Check(worker.Wait(5000)&&worker.Result,"Cancel failed to reap render process tree");
                foreach(int pid in ids.Split(new[]{' ','\n','\r'},StringSplitOptions.RemoveEmptyEntries).Select(Int32.Parse))
                    try{using(var p=Process.GetProcessById(pid))Check(p.WaitForExit(1500),"Child engine survived renderer cancellation");}catch(ArgumentException){}
            } finally {stop.Cancel();}
        }
    }
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle file,uint code,IntPtr input,int inputBytes,IntPtr output,int outputBytes,out int returned,IntPtr overlapped);
    static DirectorAsset LocalPack(string temp,string project,string movie,string wav,string ffmpeg) {
        string pack=Directory.CreateDirectory(Path.Combine(temp,"material-pack")).FullName;
        string deep=Directory.CreateDirectory(Path.Combine(pack,"camera","take")).FullName;
        string large=Path.Combine(deep,"long-source.mp4");
        File.Copy(movie,large);
        const long logicalSize=64L*1024*1024*1024;
        using(var file=File.Open(large,FileMode.Open,FileAccess.Write,FileShare.None)) {
            int returned;
            // FSCTL_SET_SPARSE keeps this valid 64 GiB MP4 fixture small on disk.
            if(!DeviceIoControl(file.SafeFileHandle,0x900c4,IntPtr.Zero,0,IntPtr.Zero,0,out returned,IntPtr.Zero))
                throw new IOException("Unable to create sparse MP4 test fixture: "+Marshal.GetLastWin32Error());
            file.Seek(0,SeekOrigin.End);
            file.Write(new byte[]{0,0,0,0,102,114,101,101},0,8); // Extends the final MP4 free box through EOF.
            file.SetLength(logicalSize);
        }
        File.WriteAllText(Path.Combine(pack,"notes.dat"),"Unsupported binary file");
        File.WriteAllBytes(Path.Combine(pack,"broken.mp4"),new byte[0]);
        int visited=0;
        var imported=DirectorStudio.ImportSelection(project,new string[0],pack,500,new HashSet<string>(),ffmpeg,CancellationToken.None,()=>visited++);
        Check(imported.assets.Count==1 && imported.skippedFiles==2 && imported.problems.Count==1 && !imported.overLimit && visited==3,
              "Nested pack did not preserve valid assets alongside skipped or broken files");
        var json=DirectorMedia.Json();
        var published=json.Serialize(imported.assets[0]);
        Check(!published.Contains("material-pack") && !published.Contains("sourcePath"),"Local pack exposed a source path");
        var id=(string)json.Deserialize<Dictionary<string,object>>(published)["id"];
        var clip=DirectorMedia.Asset(project,id);
        Check(clip.bytes==logicalSize && clip.durationMs>=1350 && clip.durationMs<=1500 && DirectorMedia.PathFor(project,clip)==large,
              "Sparse source size, duration or local reference were lost");
        Check(Directory.GetFiles(DirectorMedia.AssetDir(project,id),"*",SearchOption.AllDirectories).Sum(path=>new FileInfo(path).Length)<65536,
              "Local import copied source media into the project");
        var more=DirectorStudio.ImportSelection(project,new[]{large,wav,movie},null,1,new HashSet<string>{id},ffmpeg,CancellationToken.None);
        Check(more.assets.Count==1 && more.duplicates==1 && more.overLimit,"Remaining slots, repeated selections or capacity receipt failed");

        string narrationId=(string)json.Deserialize<Dictionary<string,object>>(json.Serialize(more.assets[0]))["id"];
        // The existing imported narration is a private copy and must remain usable after the linked source changes.
        File.SetLastWriteTimeUtc(wav,File.GetLastWriteTimeUtc(wav).AddMinutes(-2));
        bool stale=false;
        try{DirectorMedia.PathFor(project,DirectorMedia.Asset(project,narrationId));}catch(InvalidOperationException){stale=true;}
        Check(stale && DirectorMedia.ImportLocal(project,wav,ffmpeg,CancellationToken.None).id!=narrationId,"Changed source did not invalidate the linked asset");
        Console.WriteLine("Verified recursive pack import with a 64 GiB sparse MP4, bounded metadata, duplicate detection, partial success and changed-source detection.");
        return clip;
    }
    static void PackCapacity(string temp,string project,string png) {
        string pack=Directory.CreateDirectory(Path.Combine(temp,"image-pack")).FullName;
        for(int i=0;i<501;i++)File.Copy(png,Path.Combine(pack,"image-"+i+".png"));
        var imported=DirectorStudio.ImportSelection(project,new string[0],pack,500,new HashSet<string>(),null,CancellationToken.None);
        var json=DirectorMedia.Json();
        var reply=json.Deserialize<Dictionary<string,object>>(json.Serialize(imported));
        Check(imported.assets.Count==500 && (bool)reply["overLimit"] && ((System.Collections.IList)reply["assets"]).Count==500,
              "Expected one complete 500-asset pick response with an explicit capacity notice");
    }
    static void PackRoles(string temp,string project,string png,string wav,string movie,string ffmpeg) {
        string pack=Directory.CreateDirectory(Path.Combine(temp,"template-pack")).FullName;
        string document=Path.Combine(temp,"notes.txt");
        File.WriteAllText(document,"Disposable product notes");
        var types=new[]{
            new[]{"商品素材","product",movie},new[]{"授权肖像","portrait",png},new[]{"授权音色","voiceSample",wav},
            new[]{"正式配音","narration",wav},new[]{"参考片","reference",movie},new[]{"文字资料","document",document}
        };
        foreach(var t in types) {
            string dir=Directory.CreateDirectory(Path.Combine(pack,t[0],"内部拍摄目录")).FullName;
            File.Copy(t[2],Path.Combine(dir,t[1]+Path.GetExtension(t[2])));
        }
        // The innermost named folder wins; an incompatible video under portraits is skipped.
        string overrideDir=Directory.CreateDirectory(Path.Combine(pack,"授权肖像","商品素材")).FullName;
        File.Copy(movie,Path.Combine(overrideDir,"nested.mp4"));
        File.Copy(movie,Path.Combine(pack,"授权肖像","wrong.mp4"));
        string neutralDir=Directory.CreateDirectory(Path.Combine(pack,"普通目录")).FullName;
        File.Copy(png,Path.Combine(neutralDir,"other.png"));
        var pick=DirectorStudio.ImportSelection(project,new string[0],pack,500,new HashSet<string>(),ffmpeg,CancellationToken.None);
        var json=DirectorMedia.Json();
        var assets=pick.assets.Select(a=>json.Deserialize<Dictionary<string,object>>(json.Serialize(a))).ToArray();
        Check(assets.Length==8 && pick.skippedFiles==1 && pick.problems.Single().Contains("wrong.mp4"),"Folder role mismatch blocked valid files or was lost");
        foreach(var t in types) {
            var row=assets.Single(a=>(string)a["name"]==t[1]+Path.GetExtension(t[2]));
            Check((string)row["folderRole"]==t[1] && !row.ContainsKey("authorized"),"Folder role or authorization was wrong");
        }
        Check((string)assets.Single(a=>(string)a["name"]=="nested.mp4")["folderRole"]=="product" &&
            !assets.Single(a=>(string)a["name"]=="other.png").ContainsKey("folderRole"),"Nested folder override or unclassified folder fallback failed");
        Check(!json.Serialize(assets).Contains("内部拍摄目录"),"Private directory name leaked from the native picker");
        var chosen=DirectorStudio.ImportSelection(project,new[]{movie,png},null,1,new HashSet<string>(),ffmpeg,CancellationToken.None,null,"portrait");
        Check(chosen.assets.Count==1 && chosen.skippedFiles==1 && !chosen.overLimit &&
            (string)json.Deserialize<Dictionary<string,object>>(json.Serialize(chosen.assets[0]))["folderRole"]=="portrait",
            "A mismatched individual selection used a slot or lost its explicit role");
        var doc=assets.Single(a=>(string)a["kind"]=="document");
        string id=(string)doc["id"];
        bool frameDenied=false,renderDenied=false;
        try{DirectorStudio.Frame(project,id,0,null);}catch(InvalidOperationException){frameDenied=true;}
        try{new DirectorPlan{aspect="9:16",shots=new[]{new DirectorShot{id=Guid.NewGuid().ToString(),visualId=id,durationMs=1000,effect="none"}}}.Validate(project);}catch(InvalidOperationException){renderDenied=true;}
        Check(frameDenied && renderDenied,"Document was accepted as a frame or render source");
        Console.WriteLine("Verified all six folder roles, nested and unlabelled folders, document isolation, and mismatched-file skipping.");
    }
    public static int Run() {
        string temp=Directory.CreateDirectory(Path.Combine(Path.GetTempPath(),"xuti-"+Path.GetRandomFileName())).FullName;
        try {
            Policy();
            ProcessTree(temp);
            string ff=DirectorMedia.Ffmpeg();
            Check(ff!=null,"Set XUTI_DIRECTOR_FFMPEG to an installed Windows FFmpeg for this real-media test.");
            var studio=new DirectorStudio(temp);string projectId=Guid.NewGuid().ToString(),device=Guid.NewGuid().ToString();
            string project=studio.Project(device,projectId);
            Directory.CreateDirectory(project);
            string png=Path.Combine(temp,"sample.png"),wav=Path.Combine(temp,"narration.wav"),movie=Path.Combine(temp,"source.mp4");
            using(var bitmap=new Bitmap(360,480))using(var g=Graphics.FromImage(bitmap)) {
                g.Clear(Color.Teal);g.FillEllipse(Brushes.Gold,80,90,180,180);bitmap.Save(png,System.Drawing.Imaging.ImageFormat.Png);
            }
            DirectorMedia.Exec(ff,new[]{"-nostdin","-y","-f","lavfi","-i","sine=frequency=510:duration=1.6","-ar","48000",wav},temp,CancellationToken.None);
            DirectorMedia.Exec(ff,new[]{"-nostdin","-y","-f","lavfi","-i","testsrc2=size=240x320:rate=25:duration=1.4","-f","lavfi","-i","sine=frequency=980:duration=1.4","-c:v","libx264","-threads","2","-pix_fmt","yuv420p","-c:a","aac","-shortest",movie},temp,CancellationToken.None);
            Func<string,DirectorAsset> add=file=>{using(var input=File.OpenRead(file))return DirectorMedia.Import(project,Guid.NewGuid().ToString(),Path.GetFileName(file),input,ff,CancellationToken.None);};
            var photo=add(png);var voice=add(wav);var clip=LocalPack(temp,project,movie,wav,ff);
            PackCapacity(temp,project,png);
            PackRoles(temp,project,png,wav,movie,ff);
            bool deniedOther=false;
            try{DirectorMedia.Asset(studio.Project(Guid.NewGuid().ToString(),projectId),photo.id);}catch(InvalidOperationException){deniedOther=true;}
            Check(deniedOther,"Another owner's paired device accessed this asset");
            Check(clip.hasAudio && voice.hasAudio && voice.durationMs>=1570,"Input streams/duration not detected");
            Check(DirectorMedia.Json().Serialize(DirectorStudio.Frame(project,clip.id,200,ff)).Contains("image/jpeg"),"No reference JPEG frame");
            var plan=new DirectorPlan{aspect="9:16",shots=new[]{
                new DirectorShot{id=Guid.NewGuid().ToString(),visualId=photo.id,audioId=voice.id,caption="合成素材 · 商品标注",effect="callout",effectText="袖口走线",title="商品细节",durationMs=1120},
                new DirectorShot{id=Guid.NewGuid().ToString(),visualId=clip.id,caption="第二镜：原片声音",effect="push-in",startMs=120,durationMs=1120}
            }};
            string output=DirectorStudio.Out(project,1);
            var watch=Stopwatch.StartNew();
            var first=studio.Start(project,1,plan,ff,false);
            var duplicate=new DirectorStudio(temp).Start(project,1,plan,ff,false);
            Check(duplicate.jobId==first.jobId && duplicate.state=="running","Duplicate request did not attach to the existing render");
            DirectorMedia.Exec(System.Windows.Forms.Application.ExecutablePath,new[]{"--self-test-director-child-lock",Path.GetFileName(temp),Path.GetFileName(project)},temp,CancellationToken.None,8000);
            studio.Pause(output);
            Check(Wait(studio,output).state=="paused","Pause did not stop real work");
            var resumed=studio.Start(project,1,null,ff,true);
            Check(first.jobId==resumed.jobId,"Resume replaced the render ID");
            var done=Wait(studio,output);
            Check(done.state=="completed",done.stage);
            foreach(string s in new[]{"video.mp4","subtitles.srt","storyboard.txt","edit-plan.json"})Check(new FileInfo(Path.Combine(output,s)).Length>20,"Missing artifact "+s);
            var result=Path.Combine(output,"video.mp4");
            string inspect=DirectorMedia.Exec(ff,new[]{"-hide_banner","-nostdin","-i",result,"-map","0:a:0","-af","volumedetect","-f","null","-"},output,CancellationToken.None);
            Check(inspect.Contains("720x1280")&&inspect.Contains("Audio: aac")&&inspect.Contains("Video: h264")&&Regex.IsMatch(inspect,@"mean_volume: -(?:[1-4]?\d)(?:\.\d+)? dB"),"Output dimensions, codecs, or audible narration verification failed");
            Check(File.ReadAllText(Path.Combine(output,"subtitles.srt")).Contains("00:00:01,120 --> 00:00:02,240"),"SRT did not follow actual timeline");
            Check(File.ReadAllText(Path.Combine(output,"storyboard.txt")).Contains(voice.name),"Storyboard lost audio binding");
            Check(studio.Start(project,1,plan,ff,false).jobId==first.jobId,"Duplicate start created another job");
            var originalHash=DirectorRender.FileHash(result);
            plan.shots[1].effect="size-card";plan.shots[1].effectText="尺码 S / M";
            bool denied=false;try{studio.Start(project,1,plan,ff,false);}catch(InvalidOperationException){denied=true;}
            Check(denied,"Existing version accepted changed plan");
            studio.Start(project,2,plan,ff,false);
            var second=Wait(studio,DirectorStudio.Out(project,2));
            Check(second.state=="completed"&&second.reusedShots==1,"Edited version failed selective reuse: "+second.stage);
            Check(DirectorRender.FileHash(result)==originalHash,"Original version was altered");
            string localConfig=Environment.GetEnvironmentVariable("XUTI_DIRECTOR_MEDIA_CONFIG");
            try {
                Environment.SetEnvironmentVariable("XUTI_DIRECTOR_MEDIA_CONFIG",Path.Combine(temp,"no-asr.json"));
                plan.shots[0].caption="";plan.shots[0].script="保留人工台词作为字幕。";
                studio.Start(project,3,plan,ff,false);
                var third=DirectorStudio.Out(project,3);
                Check(Wait(studio,third).state=="completed"&&File.ReadAllText(Path.Combine(third,"subtitles.srt")).Contains("保留人工台词")&&File.ReadAllText(Path.Combine(third,"edit-plan.json")).Contains("\"captionSource\":\"script\""),"Missing AutoSubs discarded known narration text");
                plan.shots[0].script="";
                studio.Start(project,4,plan,ff,false);
                var missing=Wait(studio,DirectorStudio.Out(project,4));
                Check(missing.state=="failed"&&missing.stage.Contains("填写字幕或台词"),"No-ASR, no-caption task did not explain how to continue");
            } finally{Environment.SetEnvironmentVariable("XUTI_DIRECTOR_MEDIA_CONFIG",localConfig);}
            Console.WriteLine("Director FFmpeg fixture passed: 720x1280 H.264/AAC, 2.24 s, non-silent audio, burned captions, SRT, storyboard and JSON. Process-tree cancellation, cross-process locking, device isolation, pause/resume, duplicate submissions and one of two cache hits verified in "+watch.ElapsedMilliseconds+" ms.");
            if(Environment.GetEnvironmentVariable("XUTI_DIRECTOR_KEEP_FIXTURE")=="1")Console.WriteLine("Fixture: "+output);
            return 0;
        } catch(Exception e){Console.WriteLine(e.ToString());return 1;}
        finally{if(Environment.GetEnvironmentVariable("XUTI_DIRECTOR_KEEP_FIXTURE")!="1"&&Directory.Exists(temp))Directory.Delete(temp,true);}
    }
}
}
