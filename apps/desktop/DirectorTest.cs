using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;

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
            var photo=add(png);var voice=add(wav);var clip=add(movie);
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
