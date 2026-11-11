import {buildDocument,markAssetFailures} from './core.mjs';
import {waitDownload,matchesDownloadPath,validateDownload} from './browser-downloads.mjs';

// Re-entrant install. A boolean "already installed" flag was the reason both
// reports happened: when install() threw once (empty body at document_idle) the
// flag stayed set, so the retry interval and the toolbar message never existed,
// and re-injecting the bundle did nothing. ensure() now repairs whatever is
// missing and never throws; a second injection reuses the same control.
install();
function install(){
  const existing=globalThis.__feishuLocalExporter;
  if(existing){try{existing.ensure();}catch{}return existing;}
  const host=document.createElement('span');host.id='feishu-local-save-control';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>
    :host{display:inline-flex;vertical-align:middle;margin-right:12px;flex-shrink:0;font:14px "Segoe UI","Microsoft YaHei",sans-serif;color:#1f2329;position:relative;z-index:100}*{box-sizing:border-box}[hidden]{display:none!important}
    button{font:inherit;cursor:pointer;white-space:nowrap}button:focus-visible{outline:2px solid #82a7ff;outline-offset:3px}
    .primary{border:0;background:#3370ff;color:white;height:34px;font-weight:600;padding:0 12px;display:flex;align-items:center;gap:7px;border-radius:6px;box-shadow:0 1px 2px #0001}.primary:hover{background:#245bdb}.primary:active{filter:brightness(.9)}.primary:disabled{cursor:default;opacity:.7}svg{width:15px;height:15px;flex-shrink:0}
    .panel{position:absolute;right:0;top:calc(100% + 7px);width:300px;padding:12px;background:white;border:1px solid #dee0e3;border-radius:8px;box-shadow:0 6px 24px #1f23291a;font-size:13px;line-height:1.6;color:#1f2329}.message{overflow-wrap:anywhere;white-space:pre-line;max-height:190px;overflow:auto}.progress-line{display:flex;align-items:center;gap:8px;margin-top:8px}progress{flex:1;height:5px;accent-color:#3370ff;margin:0}.percent{font-size:12px;line-height:1;color:#646a73;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:6px}.actions button{background:none;border:0;color:#3370ff;padding:2px;font-size:12px}
  </style><button class="primary" title="保存到浏览器默认下载位置：正文、原图、视频、代码和表格"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg><span class="label">保存全文与素材</span></button>
  <div class="panel" hidden role="status" aria-live="polite"><div class="message"></div><div class="progress-line" hidden><progress max="1" value="0"></progress><span class="percent">0%</span></div><div class="actions"><button class="cancel" hidden>取消</button><button class="retry" hidden>重试缺失素材</button><button class="open" hidden>打开文件夹</button><button class="close">收起</button></div></div>`;
  const q=s=>shadow.querySelector(s),primary=q('.primary'),label=q('.label'),panel=q('.panel'),progress=q('progress'),progressLine=q('.progress-line'),percentEl=q('.percent');
  let busy=false,run,exported,timer,currentUrl=location.href.split('#')[0],placement='',finished=false;
  // Origin-wide locks serialise every Feishu tab, which blocks exporting several
  // documents at once; this guard only has to cover the current page.
  const pageLock=`feishu-local-download:${crypto.randomUUID()}`;
  const humanBytes=bytes=>{
    const value=Number(bytes);
    if(!Number.isFinite(value)||value<=0)return '';
    if(value<1024*1024)return `${Math.max(1,Math.round(value/1024))} KB`;
    const mb=value/1048576;
    return `${mb<10?mb.toFixed(1):Math.round(mb)} MB`;
  };
  const percentOf=fraction=>{
    const value=Number(fraction);
    return Math.max(0,Math.min(100,Math.round((Number.isFinite(value)?value:0)*100)));
  };
  // Renders three places from one fraction: the compact button label, the panel's
  // first summary line and the small number next to the bar.
  const view={done:0,total:0,bytes:0,fraction:0};
  const status=(short,detail='',fraction)=>{
    const tracking=typeof fraction==='number'&&view.total>0;
    label.textContent=tracking?`${view.done}/${view.total} · ${percentOf(fraction)}%`:short;
    primary.title=detail||'保存到浏览器默认下载位置：正文、原图、视频和附件';
    const lines=[];
    if(tracking)lines.push(`素材 ${view.done}/${view.total}${view.bytes>0?' · 已存 '+humanBytes(view.bytes):''} · ${percentOf(fraction)}%`);
    if(detail)lines.push(detail);
    q('.message').textContent=lines.length?lines.join('\n'):short;
    progressLine.hidden=fraction===undefined;
    if(fraction===null){progress.removeAttribute('value');percentEl.textContent='…';}
    else if(fraction!==undefined){progress.value=Math.max(0,Math.min(1,Number(fraction)||0));percentEl.textContent=`${percentOf(fraction)}%`;}
  };
  // Sliding-window rate of the current file only. Returns '' whenever the numbers
  // would be meaningless (no total, under 1 s of samples, zero or invalid rate),
  // so no NaN or Infinity can reach the label.
  const etaText=(samples,received,total)=>{
    if(!(total>0)||!Number.isFinite(received)||samples.length<2)return '';
    const last=samples[samples.length-1];
    let first=samples[0];
    for(const sample of samples){if(last.t-sample.t<=5000){first=sample;break;}}
    const span=(last.t-first.t)/1000;
    if(!(span>=1))return '';
    const delta=last.b-first.b;
    if(!(delta>0))return '';
    const rate=delta/span;
    if(!Number.isFinite(rate)||rate<=0)return '';
    const remain=(total-received)/rate;
    if(!Number.isFinite(remain)||remain<=0)return '';
    const seconds=Math.round(remain);
    if(seconds<1)return '';
    return seconds<60?`约剩 ${seconds} 秒`:`约剩 ${Math.max(1,Math.round(seconds/60))} 分`;
  };
  const notify=(short,detail)=>{panel.hidden=false;status(short,detail);};
  const controls=value=>{busy=value;primary.disabled=value;q('.cancel').hidden=!value;q('.retry').disabled=value;};
  // After the extension is reloaded, an older page keeps an orphaned script whose
  // messaging is dead. Say so instead of offering a button that cannot work.
  const alive=()=>{try{return !!(chrome&&chrome.runtime&&chrome.runtime.id);}catch{return false;}};
  async function rpc(action,...args){
    if(!alive())throw new Error('扩展已更新，请刷新飞书页面后再试。');
    let response;
    try{response=await chrome.runtime.sendMessage({action,args});}
    catch(e){throw new Error(/context invalidated|receiving end does not exist|message port closed/i.test(e?.message||'')?'扩展已更新，请刷新飞书页面后再试。':(e?.message||String(e)));}
    if(response?.error)throw new Error(response.error);if(!response)throw new Error('扩展已更新，请刷新飞书页面后再试。');return response.result;
  }
  const check=()=>{if(run?.signal.aborted)throw new DOMException('已取消','AbortError');if(location.href.split('#')[0]!==currentUrl)throw new Error('原文地址已改变，请重新导出。');};
  async function saveFile(path,text,replaceId,ignoreCancel=false){
    const {id}=await rpc('downloadStart',{path,text,replaceId});
    const result=await waitDownload(rpc,id,{signal:ignoreCancel?undefined:run.signal});
    if(!matchesDownloadPath(result.filename,path)){await rpc('downloadRemove',id).catch(()=>{});throw new Error('下载文件名发生变化，可能是同名文件或其他下载插件干预。');}
    return {id,filename:result.filename};
  }
  async function markdown(ignoreCancel=false){
    const d=exported,failed=d.doc.assets.filter(a=>!d.success.has(a.key)).map(a=>({...a,sourceUrl:d.doc.sourceUrl}));
    let md=markAssetFailures(d.doc.markdown,failed);
    for(const a of d.doc.assets){const actual=d.success.get(a.key)?.relative;if(actual&&actual!==a.path)md=md.split(`](./${a.path})`).join(`](<./${actual.replace(/[<>]/g,c=>encodeURIComponent(c))}>)`);}
    const escapeRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    for(const entry of d.fileErrors||[]){const path=String(entry).split('：')[0];md=md.replace(new RegExp(`\\]\\(\\./${escapeRe(path)}\\)`,'g'),']（该附件未保存）');}
    if(d.doc.warnings.length||failed.length||(d.fileErrors||[]).length)md=`> 导出有待核对项：${d.doc.warnings.length} 项内容提示、${failed.length + (d.fileErrors||[]).length} 个附件未保存，详见 attachments/export-report.json。\n\n`+md;
    const saved=await saveFile(`${d.folder}/${d.doc.name}.md`,md,d.markdownId,ignoreCancel);d.markdownId=saved.id;d.filename=saved.filename;
  }
  async function report(ignoreCancel=false){
    const d=exported;
    const text=JSON.stringify({version:'0.3.12',source:d.doc.sourceUrl,title:d.doc.title,state:d.state,updatedAt:new Date().toISOString(),blocks:d.doc.graph.visited.length,warnings:d.doc.warnings,fileErrors:d.fileErrors||[],embeddedSheets:d.doc.sheetLinks||[],assets:d.doc.assets.map(a=>({path:d.success.get(a.key)?.relative||a.path,name:a.name,expectedBytes:a.size,bytes:d.success.get(a.key)?.bytes,blockId:a.id,mountPoint:a.kind==='image'?'docx_image':'docx_file',recordedMime:a.mime,actualMime:a.actualMime,sizeMismatch:!!a.sizeMismatch,resourceHost:a.resourceHost,resolvedVia:a.resolvedVia,downloadMode:a.kind==='image'&&a.size<=67108864?'page-original-blob':'browser-direct',status:d.success.has(a.key)?'saved-from-original-endpoint':'failed-or-pending',error:d.errors.get(a.key)}))},null,2);
    const saved=await saveFile(`${d.folder}/attachments/export-report.json`,text,d.reportId,ignoreCancel);d.reportId=saved.id;
  }
  async function allocate(doc){
    for(let start=1;start<1000;){
      check();const {folder,index}=await rpc('suggestFolder',{name:doc.name,start});
      const path=`${folder}/${doc.name}.md`,{id}=await rpc('downloadStart',{path,text:`# ${doc.title}\n\n> 正在保存全文与素材，完成后会自动更新此文件。\n`});
      const result=await waitDownload(rpc,id,{signal:run.signal});
      // Folder allocation must be exact: a " (1)" suffix means another tab claimed
      // this folder first, so take the next free index instead of sharing it.
      if(result.filename.replace(/\\/g,'/').endsWith('/'+path))return {folder,markdownId:id,filename:result.filename};
      await rpc('downloadRemove',id);start=index+1;
    }
    throw new Error('无法创建独立的文章文件夹。');
  }
  async function execute(retry=false){
    if(busy)return;clearTimeout(timer);controls(true);panel.hidden=true;q('.retry').hidden=true;q('.open').hidden=true;finished=false;
    run=new AbortController();run.jobId=crypto.randomUUID();currentUrl=location.href.split('#')[0];
    try{
      await navigator.locks.request(pageLock,{ifAvailable:true},async lock=>{
        if(!lock)throw new Error('此页面已有保存任务正在运行，请稍后重试。');
        if(!retry){
          exported=null;
          // The read phase can take a while on big documents or a busy network; show
          // real page/block counts and elapsed seconds instead of a frozen label.
          const collectStarted=Date.now();
          const readProgress=()=>{
            const el=document.getElementById('feishu-local-progress'),data=el?.dataset||{};
            const pages=Number(data.pages)||0,blocks=Number(data.blocks)||0,filled=Number(data.filled)||0;
            const seconds=Math.max(0,Math.round((Date.now()-collectStarted)/1000));
            const parts=[];
            if(pages)parts.push(`已读 ${pages} 页`);
            if(blocks)parts.push(`${blocks} 块`);
            if(filled)parts.push(`补读 ${filled} 个块`);
            const detail=`正在读取完整正文${parts.length?' · '+parts.join(' · '):''} · ${seconds} 秒${seconds>=15?'（网络较慢或同时在下载，仍在读取…）':''}`;
            status(`读取正文 ${seconds} 秒`,detail,null);
          };
          readProgress();
          const ticker=setInterval(()=>{try{readProgress();}catch{}},400);
          let snapshot;
          try{snapshot=await rpc('collect',run.jobId);}finally{clearInterval(ticker);}
          check();const doc=buildDocument(snapshot),reserved=await allocate(doc);
          exported={doc,...reserved,success:new Map(),errors:new Map(),fileErrors:[],state:'in-progress'};await report();
          const files=doc.files;
          for(let n=0;n<files.length;n++){
            check();const file=files[n];
            status('写入附件',`${file.path}（${n+1}/${files.length}）`,null);
            // One stuck text download must not freeze the whole export: retry once,
            // then record the file and continue.
            try{await saveFile(`${exported.folder}/${file.path}`,file.content);}
            catch(e){
              if(run.signal.aborted)throw e;
              status('重试附件',`${file.path}：${e.message}`,null);
              try{await saveFile(`${exported.folder}/${file.path}`,file.content);}
              catch(again){if(run.signal.aborted)throw again;exported.fileErrors.push(`${file.path}：${again.message}`);}
            }
          }
          await markdown();
        }
        const d=exported;
        const totalAssets=d.doc.assets.length;
        view.total=totalAssets;
        for(let i=0;i<totalAssets;i++){
          check();const asset=d.doc.assets[i];if(d.success.has(asset.key))continue;
          let id,prepared,targetPath=asset.path;
          // Saved bytes count towards the panel summary; the per-file line gets a
          // sliding-window ETA from the current file only.
          const savedBefore=[...d.success.values()].reduce((sum,item)=>sum+(Number(item.bytes)||0),0);
          let samples=[];
          view.done=i+1;view.bytes=savedBefore;
          try{
            if(asset.kind==='image'){
              status(`读取原图 ${i+1}/${totalAssets}`,asset.path);
              prepared=await rpc('prepareImage',asset);asset.resourceHost=prepared.resourceHost;asset.resolvedVia=prepared.resolvedVia;
              // The block model can mislabel the file (real documents record JPEG
              // as image/png); the bytes decide the extension.
              if(prepared.ext&&!asset.path.toLowerCase().endsWith('.'+prepared.ext))targetPath=asset.path.replace(/\.[a-z0-9]+$/i,'.'+prepared.ext);
              asset.actualMime=prepared.mime;asset.sizeMismatch=!!prepared.sizeMismatch;check();
            }
            const handle=item=>{
              check();
              const total=Number(asset.size||item.totalBytes)||0,received=Number(item.bytesReceived)||0;
              const now=Date.now();
              samples.push({t:now,b:received});
              while(samples.length>2&&now-samples[0].t>5000)samples.shift();
              const fraction=(i+(total>0?Math.min(1,received/total):0))/totalAssets;
              view.bytes=savedBefore+received;view.fraction=fraction;
              const eta=etaText(samples,received,total);
              status('',`${targetPath} · ${(received/1048576).toFixed(1)}${total>0?'/'+(total/1048576).toFixed(1):''} MB${eta?' · '+eta:''}`,fraction);
            };
            let item;
            for(let attempt=1;;attempt++){
              const started=await rpc('downloadStart',{path:`${d.folder}/${targetPath}`,url:prepared?.blobUrl||prepared?.url||asset.url});id=started.id;
              try{item=await waitDownload(rpc,id,{signal:run.signal,onProgress:handle});break;}
              catch(e){
                await rpc('downloadCancel',id).catch(()=>{});await rpc('downloadRemove',id).catch(()=>{});id=undefined;
                // NETWORK_FAILED / stalls on large media are transient; retry twice.
                if(attempt>=3||!/NETWORK_|SERVER_|TIMEOUT|CRASH|超时|卡住/i.test(e?.message||''))throw e;
                check();status('',`${targetPath}：${e.message}，第 ${attempt} 次重试。`,view.fraction);
                await new Promise(r=>setTimeout(r,700*attempt));
              }
            }
            const info=validateDownload(asset,item),normalized=item.filename.replace(/\\/g,'/'),marker='/'+d.folder+'/';
            if(!normalized.includes(marker))throw new Error('下载位置被其他扩展改变。');
            info.relative=normalized.slice(normalized.lastIndexOf(marker)+marker.length);if(info.sizeMismatch)asset.sizeMismatch=true;d.success.set(asset.key,info);d.errors.delete(asset.key);
          }catch(e){
            if(id){await rpc('downloadCancel',id).catch(()=>{});await rpc('downloadRemove',id).catch(()=>{});}
            check();d.errors.set(asset.key,e.message);
          }finally{if(prepared?.blobUrl)await rpc('releaseImage',prepared.blobUrl).catch(()=>{});}
        }
        d.state=d.errors.size||d.doc.warnings.length||d.fileErrors.length?'partial':'complete';await markdown();await report();
        q('.open').hidden=false;
        if(d.state==='complete'){
          finished=true;
          notify('已全部完成',`${d.doc.title}\n正文与 ${d.success.size} 个素材已全部保存到浏览器下载目录。`);
          // The completion state is the button's status: collapsing the panel must
          // not turn it back into "保存全文与素材".
          timer=setTimeout(()=>{if(!busy){panel.hidden=true;status('已全部完成','已全部完成，点击可重新导出。');}},6000);
        }else{
          notify('已保存 · 有缺项',[`正文已保存，素材 ${d.success.size}/${d.doc.assets.length}。`,...d.doc.warnings,...d.fileErrors,...[...d.errors].map(([key,msg])=>`${d.doc.assets.find(a=>a.key===key)?.path}：${msg}`)].join('\n'));q('.retry').hidden=d.success.size===d.doc.assets.length&&!d.fileErrors.length;
        }
      });
    }catch(e){
      if(exported){exported.state=run.signal.aborted?'cancelled':'interrupted';await markdown(true).catch(()=>{});await report(true).catch(()=>{});q('.retry').hidden=!exported.doc.assets.some(a=>!exported.success.has(a.key));q('.open').hidden=!exported.markdownId;}
      notify(run.signal.aborted?'已取消':'保存未完成',e.message);
    }finally{controls(false);}
  }
  primary.onclick=()=>execute();
  q('.close').onclick=()=>{panel.hidden=true;if(!busy)status(finished?'已全部完成':'保存全文与素材');};
  q('.cancel').onclick=()=>{run?.abort();rpc('cancel',run?.jobId).catch(()=>{});status('正在取消…');};
  q('.retry').onclick=()=>execute(true);
  q('.open').onclick=()=>rpc('showDownload',exported.markdownId).catch(e=>notify('无法打开文件夹',e.message));
  host.addEventListener('mouseenter',()=>{if(busy)panel.hidden=false;});
  window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='focus-export')focus();});
  function focus(){
    try{attach();}catch{}
    if(!busy&&finished)notify('已全部完成','已全部完成，点击可重新导出。');
    else if(!busy)notify('保存全文与素材','点击此按钮，保存正文、原图、视频和附件。沿用浏览器下载目录。');
    else panel.hidden=false;
    try{primary.focus();}catch{}
    return true;
  }
  // A placed control must be genuinely visible: on first load Feishu can be an
  // empty document, then hydrate a second header tree, so a "found" anchor can
  // still sit inside a hidden or zero-size container.
  const visible=element=>{
    if(!element||!element.isConnected)return false;
    const rect=element.getBoundingClientRect();
    if(!rect.width||!rect.height)return false;
    if(rect.bottom<0||rect.right<0)return false;
    const style=getComputedStyle(element);
    return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0;
  };
  const selectors=['.header-ssr-layout-component-ShareBtn','.suite-title-bar-actions','.docs-header-right','.header-ssr-layout-area-RightContent'];
  function attach(){
    if(!/^\/(wiki|docx)\//.test(location.pathname)){host.remove();placement='';return false;}
    // A header placement is kept while it stays visible; the floating fallback is
    // re-examined every time so the control moves into the real header as soon as
    // one appears.
    if(placement==='header'&&visible(host))return true;
    for(const selector of selectors){
      for(const anchor of document.querySelectorAll(selector)){
        if(!visible(anchor))continue;
        const parent=anchor.parentElement;if(!parent||!visible(parent))continue;
        if(host.parentElement!==parent||host.nextSibling!==anchor){host.style.cssText='';parent.insertBefore(host,anchor);}
        if(visible(host)){placement='header';return true;}
      }
    }
    // Floating fallback: only when no visible header anchor exists, above the page
    // chrome, and parked left of the share button so it never covers it.
    const share=document.querySelector('.header-ssr-layout-component-ShareBtn');
    const viewport=Number(window.innerWidth)||0;
    const right=share&&visible(share)&&share.getBoundingClientRect().left>0&&viewport>0?Math.max(240,Math.round(viewport-share.getBoundingClientRect().left+12)):240;
    host.style.cssText=`position:fixed;right:${right}px;top:12px;z-index:2147483000`;
    if(!host.isConnected)(document.body||document.documentElement).append(host);
    placement=visible(host)?'floating':'';
    return placement!=='';
  }
  const ensure=()=>{try{if(!alive()){label.textContent='扩展已更新';primary.disabled=true;primary.title='扩展已更新，请刷新飞书页面后再试。';}return attach();}catch{return false;}};
  const api={ensure,focus,get attached(){return placement!=='';}};
  globalThis.__feishuLocalExporter=api;
  try{attach();}catch{}
  const observer=new MutationObserver(()=>{try{attach();}catch{}});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{try{
    if(location.href.split('#')[0]!==currentUrl&&!busy){currentUrl=location.href.split('#')[0];exported=null;finished=false;q('.retry').hidden=true;q('.open').hidden=true;panel.hidden=true;status('保存全文与素材');}
    ensure();
  }catch{}},1500);
  window.addEventListener('pageshow',()=>{try{attach();}catch{}});
  return api;
}




