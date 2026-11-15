import { readdir, readFile, readlink } from 'node:fs/promises';

/** Chromium may replace argv[0] with its complete, space-separated process title. */
export function parseBrowserProcessTitle(commandLine:string) {
  const [title='',...args]=commandLine.split('\0');
  // Inspect actual switches separately. A normal argument's value can contain
  // text such as "--no-sandbox" without being a Chromium command-line switch.
  const typeArgument=args.find(arg=>arg.startsWith('--type='));
  const type=typeArgument?.slice(7) ?? /(?:^|[\t ])--type=([a-zA-Z0-9-]+)(?=$|[\t ])/.exec(title)?.[1];
  const role=type===undefined?'browser':['browser','renderer','zygote','gpu-process','utility'].includes(type)?type:'other';
  const forbidden=['--no-sandbox','--disable-namespace-sandbox','--disable-seccomp-filter-sandbox','--disable-setuid-sandbox'];
  const prohibitedFlags=args.some(arg=>forbidden.some(flag=>arg===flag||arg.startsWith(flag+'='))) ||
    /(?:^|[\t ])--(?:no-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox|disable-setuid-sandbox)(?:=[^\t ]*)?(?=$|[\t ])/.test(title);
  return {role,prohibitedFlags};
}

/** Read-only VM facts. No PID, command line, environment, hostname or raw error leaves here. */
export async function browserIsolationDiagnostics() {
  const uid=process.getuid?.() ?? -1;
  const kernel=(await readFile('/proc/sys/kernel/osrelease','utf8').catch(()=>'' )).match(/^\d+\.\d+\.\d+/)?.[0] || 'unknown';
  const namespaces=['user','pid','net'] as const;
  const own=await Promise.all(namespaces.map(name=>readlink('/proc/self/ns/'+name).catch(()=>null)));
  const groups=new Map<string,{role:string;seccomp:number|null;noNewPrivileges:number|null;userNamespaceDifferent:boolean|null;pidNamespaceDifferent:boolean|null;netNamespaceDifferent:boolean|null;count:number}>();
  let prohibitedFlags=false;
  for(const id of (await readdir('/proc').catch(()=>[])).filter(id=>/^\d+$/.test(id)).slice(0,2000)){
    try{
      const [status,raw]=await Promise.all([readFile('/proc/'+id+'/status','utf8'),readFile('/proc/'+id+'/cmdline','utf8')]);
      const args=raw.split('\0');
      if(!args[0]?.includes('chrome-headless-shell')||Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])!==uid)continue;
      const processTitle=parseBrowserProcessTitle(raw);
      prohibitedFlags ||= processTitle.prohibitedFlags;
      const role=processTitle.role;
      const ns=await Promise.all(namespaces.map(name=>readlink('/proc/'+id+'/ns/'+name).catch(()=>null)));
      const difference=(index:number)=>own[index]&&ns[index]?own[index]!==ns[index]:null;
      const seccomp=Number(/^Seccomp:\s+(\d+)/m.exec(status)?.[1]),nnp=Number(/^NoNewPrivs:\s+(\d+)/m.exec(status)?.[1]);
      const item={role,seccomp:[0,1,2].includes(seccomp)?seccomp:null,noNewPrivileges:[0,1].includes(nnp)?nnp:null,userNamespaceDifferent:difference(0),pidNamespaceDifferent:difference(1),netNamespaceDifferent:difference(2)};
      const key=JSON.stringify(item),previous=groups.get(key);
      if(previous)previous.count++;else if(groups.size<32)groups.set(key,{...item,count:1});
    }catch{/* A disappearing or sandbox-protected process is not broadened into privileged access. */}
  }
  return {uid,kernel,prohibitedFlags,processes:[...groups.values()]};
}
