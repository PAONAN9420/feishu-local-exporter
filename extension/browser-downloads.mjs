export function matchesDownloadPath(actual,relative){
  const normalized=actual.replace(/\\/g,'/');
  if(normalized.endsWith('/'+relative))return true;
  // Chrome uniquifies the name ("name (1).ext") when a retried download finds the
  // previous partial file; the caller then records the real name.
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const ext=(relative.match(/\.[^./]+$/)||[''])[0],base=ext?relative.slice(0,-ext.length):relative;
  return new RegExp('(^|/)'+escape(base)+' \\(\\d+\\)'+escape(ext)+'$').test(normalized);
}
export function validateDownload(asset,item){
  if(item.state!=='complete')throw new Error(item.error||'下载尚未完成。');
  const bytes=item.fileSize>=0?item.fileSize:item.bytesReceived;
  if(bytes<=0)throw new Error('下载结果为空。');
  const mime=(item.mime||'').toLowerCase();
  // The recorded size is the authoritative proof that the original bytes arrived —
  // except when the document stores a placeholder (real documents record size 100
  // for every image); a shrinking transfer is still treated as a failure.
  let sizeMismatch=false;
  if(asset.size&&bytes!==asset.size){
    if(bytes>asset.size&&asset.size<1024)sizeMismatch=true;
    else throw new Error(`原文件大小不符：${bytes} / ${asset.size} 字节。`);
  }
  if(!asset.size){
    const expected=(asset.mime||'').toLowerCase(),name=String(asset.name||'').toLowerCase();
    const pageExpected=/text\/(html|plain)|application\/json/.test(expected)||/\.(html?|json|txt|md|csv|xml)$/.test(name);
    if(!pageExpected&&/text\/html|application\/json|text\/plain/.test(mime))throw new Error('服务器返回网页或错误信息，未确认原始素材。');
  }
  if(asset.kind==='video'&&/mpegurl|dash\+xml/.test(mime))throw new Error('视频返回分片播放清单，需要进一步适配。');
  return {bytes,mime,downloadId:item.id,sizeMismatch};
}
// A download that never leaves "in_progress" (browser security prompt, stalled
// network) used to poll forever and freeze the export. The watchdog reports it
// instead, so the caller can retry or record the file and keep going.
export async function waitDownload(rpc,id,{signal,onProgress=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),stallMs=30000,limitMs=180000,clock=Date.now}={}){
  const started=clock();let lastBytes=-1,lastChange=started;
  while(true){
    if(signal?.aborted){await rpc('downloadCancel',id).catch(()=>{});throw new DOMException('已取消','AbortError');}
    const item=await rpc('downloadStatus',id);onProgress(item);
    if(item.state==='complete')return item;
    if(item.state==='interrupted')throw new Error(`浏览器下载失败：${item.error||'已中断'}`);
    const now=clock(),bytes=Number(item.bytesReceived)||0;
    if(bytes!==lastBytes){lastBytes=bytes;lastChange=now;}
    const stalled=now-lastChange;
    if(stalled>stallMs)throw new Error(`下载卡住：${Math.round(stalled/1000)} 秒没有新数据（可能被浏览器安全提示拦住或网络中断）`);
    if(now-started>limitMs)throw new Error('下载超时：总时长超过 ' + Math.round(limitMs/60000) + ' 分钟。');
    await sleep(700);
  }
}
