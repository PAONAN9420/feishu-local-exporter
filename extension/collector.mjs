// Executed in the document's MAIN world. Keep all helpers inside this function.
export async function collectDocument(jobId) {
  if (!/^https:\/\/[^/]*\.?feishu\.cn\/(wiki|docx)\//.test(location.href)) throw new Error('请在飞书 Wiki 或新版 Docx 文档页启动导出。');
  const sourceUrl=location.href.split('#')[0], origin=location.origin;
  const controller=new AbortController();
  let progress=null;
  window.__localFeishuExportJobs ||= new Map();
  window.__localFeishuExportJobs.set(jobId,controller);
  const check=()=>{if(controller.signal.aborted) throw new Error('已取消'); if(location.href.split('#')[0]!==sourceUrl) throw new Error('导出期间文档地址发生变化，请重新导出。');};
  async function getJSON(url) {
    for(let attempt=0;attempt<3;attempt++) {
      check();
      const csrf=document.cookie.match(/(?:^|;\s*)(?:_csrf_token|csrf_token)=([^;]+)/)?.[1];
      const headers=csrf?{'X-CSRFToken':decodeURIComponent(csrf)}:{};
      const response=await fetch(url,{credentials:'include',headers,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
      if((response.status===429||response.status>=500)&&attempt<2) {await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
      if(!response.ok) throw new Error(`正文读取失败 HTTP ${response.status}，请确认已登录且可访问文档。`);
      const json=await response.json();
      if(json.code!==0 && json.code!==undefined) throw new Error(`飞书未允许读取后续正文（${json.code}）：${json.msg||json.message||'请检查登录状态'}。`);
      return json;
    }
  }
  function jsonAt(html,needle) {
    const index=html.indexOf(needle); if(index<0) return null;
    const start=html.indexOf('{',index+needle.length); if(start<0) return null;
    let depth=0,quote=false,escape=false;
    for(let i=start;i<html.length;i++) {
      const c=html[i];
      if(quote) {if(escape) escape=false;else if(c==='\\') escape=true;else if(c==='"') quote=false;continue;}
      if(c==='"') quote=true; else if(c==='{') depth++; else if(c==='}'&&--depth===0) return JSON.parse(html.slice(start,i+1));
    }
    return null;
  }
  try {
    let initial=window.DATA?.clientVars, meta=window.DATA?.meta;
    if(!initial?.data?.block_map) {
      const response=await fetch(sourceUrl,{credentials:'include',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
      if(!response.ok) throw new Error(`文档页面读取失败 HTTP ${response.status}`);
      const html=await response.text();
      initial=jsonAt(html,'clientVars: Object('); meta ||= jsonAt(html,'meta: Object(');
    }
    if(!initial?.data?.block_map) throw new Error('未找到文档结构化内容。请等待正文加载完成；若仍失败，需要针对当前飞书版本适配。');
    // Snapshot once; do not retain live mutable page model objects.
    initial=JSON.parse(JSON.stringify(initial));
    const map={...initial.data.block_map}, root=initial.data.id||meta?.token;
    if(!root||!map[root]) throw new Error('缺少文档根节点，停止导出以免漏文。');
    const queue=[],seen=new Set(),skip=new Set(initial.data.skip_blocks||[]);
    // Live progress for the content script: attributes live in the shared DOM, so
    // the isolated world can read them while this MAIN-world run is in flight.
    let progressElement=null;
    try{
      progressElement=document.createElement('span');progressElement.id='feishu-local-progress';progressElement.style.display='none';
      (document.body||document.documentElement).append(progressElement);
    }catch{progressElement=null;}
    progress=progressElement;
    const reportProgress=extra=>{
      if(!progress)return;
      try{
        progress.dataset.pages=String(requests);
        progress.dataset.blocks=String(Object.keys(map).length);
        if(extra!==undefined)progress.dataset.filled=String(extra);
      }catch{}
    };
    const rootVersion=map[root].version;
    function enqueue(data,blockId) {
      for(const id of data.skip_blocks||[]) skip.add(id);
      const cursors=data.concurrent&&data.next_cursors?.length?data.next_cursors:(data.has_more&&data.cursor?[data.cursor]:[]);
      for(const cursor of cursors) {
        const key=(blockId||'')+':'+cursor;
        if(!seen.has(key)) {seen.add(key);queue.push({cursor,blockId});}
      }
      if(data.has_more&&!cursors.length) throw new Error('飞书返回正文未完但未提供下一页，停止导出。');
    }
    enqueue(initial.data);
    let requests=0;
    async function load({cursor,blockId}) {
      if(++requests>1000) throw new Error('正文分页数量异常，已停止。');
      const url=new URL('/space/api/docx/pages/client_vars',origin);
      url.searchParams.set('id',root);url.searchParams.set('mode',String(initial.mode??7));url.searchParams.set('limit','239');
      if(cursor) url.searchParams.set('cursor',cursor);
      if(blockId) url.searchParams.set('block_id',blockId);
      const result=await getJSON(url.href), data=result.data;
      if(!data?.block_map||!Object.keys(data.block_map).length) throw new Error('飞书返回了空的正文分页，无法确认完整性。');
      if(data.block_map[root]?.version!==undefined&&data.block_map[root].version!==rootVersion) throw new Error('文档在读取期间发生修改，请稍后重新导出。');
      Object.assign(map,data.block_map);enqueue(data,blockId);reportProgress();
    }
    while(queue.length) await load(queue.shift());
    const loadedSkip=new Set();
    let filled=0;
    for(let round=0;round<20;round++) {
      check();
      const refs=new Set(Object.values(map).flatMap(b=>[...(b.data?.children||[]),...(b.data?.table?.cells||[]),...(b.data?.cell_set&&typeof b.data.cell_set==='object'?Object.values(b.data.cell_set).map(c=>c?.block_id).filter(Boolean):[])]));
      const missing=[...refs].filter(id=>!map[id]);
      const extra=[...skip].filter(id=>!loadedSkip.has(id));
      if(!missing.length&&!extra.length) break;
      const before=Object.keys(map).length;
      for(const blockId of [...new Set([...extra,...missing])]) {loadedSkip.add(blockId);await load({blockId});while(queue.length) await load(queue.shift());reportProgress(++filled);}
      if(Object.keys(map).length===before&&missing.length) throw new Error(`仍有 ${missing.length} 个正文块无法读取。`);
    }
    check();
    const title=initial.data.meta_map?.[root]?.title||meta?.title||document.title;
    return {map,root,title,sourceUrl,origin,requests,warnings:[]};
  } catch(e) {return {__exportError:e.message||String(e)};}
  finally { window.__localFeishuExportJobs.delete(jobId); try{progress?.remove();}catch{} }
}

// The page can read its authenticated same-origin files. Only the exact original-file
// route is accepted; readers have bounded chunks and auto-expire to avoid leaked requests.
export async function pageStream(action,key,url) {
  window.__localFeishuReaders ||= new Map();
  const store=window.__localFeishuReaders;
  const touch=state=>{clearTimeout(state.timer);state.timer=setTimeout(()=>{state.controller.abort();state.reader.cancel().catch(()=>{});store.delete(key);},90000);};
  if(action==='close') {const s=store.get(key);if(s){clearTimeout(s.timer);s.controller.abort();await s.reader.cancel().catch(()=>{});store.delete(key);}return {done:true};}
  if(action==='open') {
    const u=new URL(url);
    if(!/(^|\.)feishu\.cn$/.test(u.hostname)||!/^\/space\/api\/box\/stream\/download\/(?:all|preview)\/[a-zA-Z0-9_-]+\/$/.test(u.pathname)) throw new Error('不允许的资源下载地址。');
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),45000);
    let r;
    try {r=await fetch(u.href,{credentials:'include',signal:controller.signal});}finally{clearTimeout(timer);}
    if(!r.ok||!r.body) {controller.abort();throw new Error(`资源下载失败 HTTP ${r.status}`);}
    const state={reader:r.body.getReader(),controller,pending:null};store.set(key,state);touch(state);
    return {type:r.headers.get('content-type')||'',length:Number(r.headers.get('content-length'))||0};
  }
  const s=store.get(key);if(!s) throw new Error('资源读取已过期，请重试。');touch(s);
  let value=s.pending;s.pending=null;
  if(!value) {const chunk=await s.reader.read();if(chunk.done){clearTimeout(s.timer);store.delete(key);return {done:true};}value=chunk.value;}
  if(value.length>262144) {s.pending=value.slice(262144);value=value.slice(0,262144);}
  return {done:false,bytes:Array.from(value)};
}
