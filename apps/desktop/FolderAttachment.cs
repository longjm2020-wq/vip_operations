using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace XutiDesktop {
static partial class Native {
    internal sealed class FolderAttachment {
        internal const int MaxBytes=64*1024*1024;
        const int Chunk=128*1024;
        internal readonly string Name,Digest;
        internal readonly int Length;
        internal byte[] Content {get;private set;}
        internal object Descriptor {get {return new{name=Name,bytes=Length,sha256=Digest};}}

        internal FolderAttachment(Dictionary<string,object> descriptor) {
            Name=FolderSegment(AssistantForm.S(descriptor,"name"),180);
            Digest=AssistantForm.S(descriptor,"sha256");
            int length;
            if(!Int32.TryParse(AssistantForm.S(descriptor,"bytes"),NumberStyles.None,CultureInfo.InvariantCulture,out length) ||
                length<1 || length>MaxBytes || !Regex.IsMatch(Digest,@"\A[0-9a-f]{64}\z"))
                throw new IOException("附件缺少有效的大小或 SHA-256 摘要。");
            Length=length;
        }
        static string Hex(byte[] hash) {return BitConverter.ToString(hash).Replace("-","").ToLowerInvariant();}
        internal void SetContent(byte[] bytes) {
            if(bytes.Length!=Length)throw new IOException("任务附件大小与授权回执不一致。");
            using(var sha=SHA256.Create())if(Hex(sha.ComputeHash(bytes))!=Digest)throw new IOException("附件的 SHA-256 与授权回执不一致。");
            Content=bytes;
        }
        internal FileStream OpenDestination(string folder,bool allowMissing) {
            string path=Path.Combine(folder,Name);
            var handle=ExplorerCopy.CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            if(handle.IsInvalid) {
                int error=Marshal.GetLastWin32Error();
                handle.Dispose();
                if(allowMissing && error==2)return null;
                throw new IOException("无法核验目标 "+Path.GetFileName(folder)+" 中的附件（Windows "+error+"）。");
            }
            try {
                ExplorerCopy.VerifyBatchNote(handle,false);
                CheckBatchEntryName(handle,path);
                return new FileStream(handle,FileAccess.Read,Chunk,false);
            } catch {handle.Dispose();throw;}
        }
        internal async Task VerifyDestination(FileStream file,Func<Task> checkpoint) {
            ExplorerCopy.VerifyBatchNote(file.SafeFileHandle,false);
            if(file.Length==Length) {
                file.Position=0;
                byte[] buffer=new byte[Chunk];
                using(var sha=SHA256.Create()) {
                    int count;
                    while((count=file.Read(buffer,0,buffer.Length))>0) {
                        await checkpoint();
                        sha.TransformBlock(buffer,0,count,buffer,0);
                    }
                    sha.TransformFinalBlock(new byte[0],0,0);
                    if(Hex(sha.Hash)==Digest)return;
                }
            }
            throw new IOException("有同名文件的内容与附件不同，请核对已有文件。");
        }
        internal async Task<FileStream> Publish(string folder,Func<Task> checkpoint) {
            string target=Path.Combine(folder,Name);
            string stage=Path.Combine(folder,".xuti-attachment-"+Guid.NewGuid().ToString("N")+".tmp");
            using(var handle=ExplorerCopy.CreateFileW(stage,0x40010000,0,IntPtr.Zero,1,0x80,IntPtr.Zero)) {
                if(handle.IsInvalid)throw new IOException("无法在目标子目录中暂存附件。");
                ExplorerCopy.StagingDisposition(handle,true);
                using(var file=new FileStream(handle,FileAccess.Write,Chunk,false)) {
                    for(int offset=0;offset<Content.Length;offset+=Chunk) {
                        await checkpoint();
                        file.Write(Content,offset,Math.Min(Chunk,Content.Length-offset));
                    }
                    file.Flush(true);await checkpoint();
                    // Open handles hold the directory tree throughout the batch. Rename
                    // publishes the complete file in the same directory without replacement.
                    ExplorerCopy.StagingDisposition(handle,false);
                    FileStream existing=null;
                    try {ExplorerCopy.PublishFile(handle,target);}
                    catch(IOException) {
                        ExplorerCopy.StagingDisposition(handle,true);
                        // A competing creator may have published the identical attachment.
                        existing=OpenDestination(folder,true);
                        if(existing==null)throw;
                    }
                    if(existing!=null) {
                        try {await VerifyDestination(existing,checkpoint);return existing;}
                        catch {existing.Dispose();throw;}
                    }
                }
            }
            return OpenDestination(folder,false);
        }
    }
}
}
