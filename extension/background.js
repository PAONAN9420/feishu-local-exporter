import {collectDocument} from './collector.mjs';
import {safeName} from './core.mjs';
import {prepareImage,releaseImage} from './media.mjs';
const isDocument=url=>/^https:\/\/([^/]+\.)?feishu\.cn\/(wiki|docx)\//.test(url||'');
const key=id=>'download:'+id;
const read=async id=>(await chrome.storage.session.get(key(id)))[key(id)];
const save=async(id,value)=>chrome.storage.session.set({[key(id)]:value});
async function own(id,tabId){const record=await read(id);if(!record||record.tabId!==tabId)throw new Error('下载不属于当前任务。');return record;}
const flash=async text=>{try{await chrome.action.setBadgeText({text});await chrome.action.setBadgeBackgroundColor({color:'#c9353f'});setTimeout(()=>chrome.action.setBadgeText({text:''}),3000);}catch{}};
const askPage=async tabId=>{try{await chrome.tabs.sendMessage(tabId,{type:'focus-export'});return true;}catch{return false;}};
chrome.action.onClicked.addListener(async tab=>{
  if(!isDocument(tab.url)){await flash('?');return;}
  // The click must work even when the page was opened before the extension was
  // (re)loaded: message first, inject and message again, and only then report.
  if(await askPage(tab.id))return;
  try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.bundle.js']});}
  catch{await flash('!');return;}
  if(!await askPage(tab.id))await flash('!');
});
async function dispatch(message,sender){
  const tabId=sender.tab.id,[arg]=message.args||[];
  if(['collect','cancel','prepareImage','releaseImage'].includes(message.action)){
    const funcs={collect:collectDocument,prepareImage,releaseImage,cancel:id=>{window.__localFeishuExportJobs?.get(id)?.abort();return true;}};
    const func=funcs[message.action];
    const results=await chrome.scripting.executeScript({target:{tabId,frameIds:[sender.frameId||0]},world:'MAIN',func,args:[arg]});
    const first=results[0];if(first?.error||first?.result?.__exportError)throw new Error(first.error?.message||first.result.__exportError);
    if(first?.result===undefined)throw new Error('原文未返回数据，请刷新后重试。');
    if(message.action==='prepareImage'&&first.result.blobUrl)await chrome.storage.session.set({['image:'+first.result.blobUrl]:{tabId}});
    if(message.action==='prepareImage'&&first.result.direct&&first.result.url)await chrome.storage.session.set({['resource:'+first.result.url]:{tabId}});
    if(message.action==='releaseImage')await chrome.storage.session.remove('image:'+arg);
    return first.result;
  }
  if(message.action==='downloadStart'){
    const {path,text,url,replaceId}=arg;
    if(typeof path!=='string'||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\x00]/.test(p)))throw new Error('非法下载路径。');
    let downloadUrl;
    if(text!==undefined){
      if(typeof text!=='string'||text.length>20_000_000)throw new Error('文本附件过大。');
      downloadUrl='data:application/octet-stream;charset=utf-8,'+encodeURIComponent(text);
    }else{
      const u=new URL(url),origin=new URL(sender.url).origin;
      if(u.protocol==='blob:'){
        const record=(await chrome.storage.session.get('image:'+url))['image:'+url];
        if(u.origin!==origin||record?.tabId!==tabId)throw new Error('原图临时地址不属于当前任务。');
      }else{
        const record=(await chrome.storage.session.get('resource:'+url))['resource:'+url];
        if((u.origin!==origin&&record?.tabId!==tabId)||!/(^|\.)feishu\.cn$/.test(u.hostname)||!/^\/space\/api\/box\/stream\/download\/(?:all|preview)\/[a-zA-Z0-9_-]+\/$/.test(u.pathname))throw new Error('不允许的素材地址。');
      }
      downloadUrl=u.href;
    }
    if(replaceId!==undefined){const old=await own(replaceId,tabId);if(old.path!==path||!old.text)throw new Error('只能更新本任务创建的正文和清单。');}
    const id=await chrome.downloads.download({url:downloadUrl,filename:path,saveAs:false,conflictAction:replaceId===undefined?'uniquify':'overwrite'});
    await save(id,{tabId,path,text:text!==undefined});return {id};
  }
  if(['downloadStatus','downloadCancel','downloadRemove','showDownload'].includes(message.action)){
    await own(arg,tabId);
    if(message.action==='downloadCancel'){await chrome.downloads.cancel(arg);return true;}
    if(message.action==='downloadRemove'){await chrome.downloads.removeFile(arg);await chrome.downloads.erase({id:arg});await chrome.storage.session.remove(key(arg));return true;}
    if(message.action==='showDownload'){await chrome.downloads.show(arg);return true;}
    const [item]=await chrome.downloads.search({id:arg});if(!item)throw new Error('下载记录已被移除。');
    return {id:item.id,state:item.state,error:item.error,filename:item.filename,mime:item.mime,bytesReceived:item.bytesReceived,totalBytes:item.totalBytes,fileSize:item.fileSize,danger:item.danger};
  }
  if(message.action==='suggestFolder'){
    const base=safeName(arg.name),start=Number(arg.start)||1;
    for(let n=start;n<start+1000;n++){
      const folder=base+(n===1?'':'_'+String(n).padStart(2,'0'));
      const escaped=folder.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const found=await chrome.downloads.search({filenameRegex:`[\\\\/]${escaped}[\\\\/]`,exists:true,limit:1});
      if(!found.length)return {folder,index:n};
    }
    throw new Error('同名文件夹过多。');
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!sender.tab?.id||!isDocument(sender.url)||!Array.isArray(message.args))return;
  dispatch(message,sender).then(result=>sendResponse({result})).catch(e=>sendResponse({error:e.message}));return true;
});
