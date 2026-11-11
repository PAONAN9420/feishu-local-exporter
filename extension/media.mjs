// Runs in the document MAIN world, so image reads keep the page's login,
// referrer and document read permission.
//
// Root cause of the earlier HTTP 403 (verified 2026-11-11 against a real
// document): the plugin requested /space/api/box/stream/download/all/<token>/,
// which is the "download original file" permission. Documents that allow
// reading but not downloading answer 403 on that route no matter which
// mount_point / mount_node_token / resource host is used. The route the Docx
// client itself uses is /space/api/box/stream/download/preview/<token>/
// ?preview_type=16 — preview_type 16 is ORIGIN_FILE in Feishu's own enum — and
// it returns the byte-identical original (21/21 images, sizes equal to the
// block model). It is used here first, on the document's own origin.
//
// The document's own mimeType is not trustworthy: real documents store JPEG
// files as image/png with a "filename.png" name (verified on the user's
// document, sizes matched byte for byte). The bytes and the server's
// Content-Type decide the saved format; only an unrecognisable body is refused.
export async function prepareImage(asset){
  try{
    const token=String(asset.token||'');
    if(!/^[a-zA-Z0-9_-]+$/.test(token))throw new Error('图片缺少可用的下载标识。');
    const size=Number(asset.size)||0,maxBytes=64*1024*1024,blockId=String(asset.id||'');
    const origin=location.origin,urls=[],seen=new Set();
    const sniff=b=>{
      if(!b||b.length<12)return '';
      if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47)return 'image/png';
      if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
      if(b[0]===0x47&&b[1]===0x49&&b[2]===0x46&&b[3]===0x38)return 'image/gif';
      if(b[0]===0x42&&b[1]===0x4d)return 'image/bmp';
      if(b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46&&b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50)return 'image/webp';
      if(b[4]===0x66&&b[5]===0x74&&b[6]===0x79&&b[7]===0x70){
        const brand=String.fromCharCode(b[8],b[9],b[10],b[11]).toLowerCase();
        if(brand==='heic'||brand==='heix'||brand==='heif'||brand==='mif1')return 'image/heic';
        return 'image/avif';
      }
      if((b[0]===0x49&&b[1]===0x49&&b[2]===0x2a)||(b[0]===0x4d&&b[1]===0x4d&&b[3]===0x2a))return 'image/tiff';
      if(b[0]===0x3c&&(b[1]===0x3f||b[1]===0x73)&&b[2]===0x76)return 'image/svg+xml';
      return '';
    };
    const extFor=m=>({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/bmp':'bmp','image/webp':'webp','image/avif':'avif','image/heic':'heic','image/tiff':'tiff','image/svg+xml':'svg'})[m]||'';
    const add=(href,via)=>{
      let u;try{u=new URL(href);}catch{return;}
      if(u.protocol!=='https:'||!/(^|\.)feishu\.cn$/.test(u.hostname)||u.username||u.password)return;
      if(seen.has(u.href))return;seen.add(u.href);urls.push({href:u.href,via});
    };
    const originalFile=t=>`/space/api/box/stream/download/preview/${t}/?preview_type=16`;
    const legacyAll=(host,t)=>`${host}/space/api/box/stream/download/all/${t}/?mount_point=docx_image&mount_node_token=${encodeURIComponent(blockId)}`;
    // 1. Same-origin ORIGIN_FILE preview: no CORS, page cookies, read permission.
    add(origin+originalFile(token),'preview-same-origin');
    // 2. Optional cross-origin Drive server, only if the page exposes one.
    const configured=window.local?.driveStreamApiHost||window.globalConfig?.drive_api?.[0];
    if(configured){
      let drive;try{drive=new URL(/^https?:\/\//.test(configured)?configured:'https://'+configured);}catch{drive=null;}
      if(drive&&drive.protocol==='https:'&&/(^|\.)feishu\.cn$/.test(drive.hostname)&&!drive.username&&!drive.password){
        add(drive.origin+originalFile(token),'preview-drive');
        add(legacyAll(drive.origin,token),'download-all-drive');
      }
    }
    // 3. Legacy "download all" route last; it is the route that answers 403 on
    //    read-only documents, but some tenants still allow it.
    add(legacyAll(origin,token),'download-all-same-origin');
    if(size>maxBytes)return {direct:true,url:urls[0].href,resourceHost:new URL(urls[0].href).host,resolvedVia:urls[0].via};
    let failure='',mismatch='',oversize=false;
    for(const candidate of urls){
      const url=new URL(candidate.href);
      const csrf=url.origin===location.origin?document.cookie.match(/(?:^|;\s*)(?:_csrf_token|csrf_token)=([^;]+)/)?.[1]:undefined;
      const headers=csrf?{'X-CSRFToken':decodeURIComponent(csrf)}:{};
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
      try{
        const response=await fetch(url.href,{credentials:'include',headers,referrer:location.href,signal:controller.signal});
        const type=response.headers.get('content-type')||'';
        if(!response.ok||/application\/json|text\/html|text\/plain/i.test(type)){
          // Read only a bounded error prefix; never expose cookies or authorization headers.
          const reader=response.body?.getReader();let message='';
          if(reader){const first=await reader.read();await reader.cancel();message=new TextDecoder().decode(first.value?.slice(0,1000)||new Uint8Array());}
          let detail='';try{const parsed=JSON.parse(message);detail=`；业务码 ${parsed.code??'?'}，${String(parsed.message||parsed.msg||'').slice(0,100)}`;}catch{}
          failure=`素材服务 ${url.host} 返回 HTTP ${response.status}${detail}`;
          continue;
        }
        const reader=response.body?.getReader();if(!reader){failure='原图响应为空。';continue;}
        let total=0;const chunks=[];
        while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;
          if(total>maxBytes){oversize=true;controller.abort();throw new Error('原图超过页面中转上限，需使用直接下载适配。');}
          chunks.push(chunk.value);
        }
        if(!total){failure='原图文件为空。';continue;}
        // Some documents record a placeholder size (real document: every image had
        // size 100 while the originals were 103517+ bytes). A shrinking transfer is
        // still a real failure; a larger body against an implausible size is not.
        let sizeSuspect=false;
        if(size&&total!==size){
          if(total>size&&size<1024)sizeSuspect=true;
          else{mismatch=`原图字节数不符：${total} / ${size}`;continue;}
        }
        const head=new Uint8Array(await new Blob(chunks).slice(0,64).arrayBuffer());
        const sniffed=sniff(head),serverType=String(type||'').split(';')[0].trim().toLowerCase(),declared=String(asset.mime||'').toLowerCase();
        // The bytes win, then the server's own Content-Type. The block model's
        // mimeType is only recorded for the report; it is known to be wrong.
        const actualImage=sniffed||(/^image\//.test(serverType)?serverType:'');
        if(!actualImage){mismatch=`原图不是可识别的图片（${serverType||'无内容类型'}），未保存。`;continue;}
        const ext=extFor(actualImage),blob=new Blob(chunks,{type:actualImage});
        const blobUrl=URL.createObjectURL(blob);
        window.__feishuOriginalImageBlobs ||= new Map();
        const cleanup=setTimeout(()=>{URL.revokeObjectURL(blobUrl);window.__feishuOriginalImageBlobs.delete(blobUrl);},600000);
        window.__feishuOriginalImageBlobs.set(blobUrl,cleanup);
        return {blobUrl,bytes:total,mime:actualImage,ext,recordedMime:declared||'',formatCorrected:!!ext&&!!extFor(declared)&&extFor(declared)!==ext,sizeMismatch:!!sizeSuspect,mountPoint:'docx_image',mountNode:blockId,resourceHost:url.host,resolvedVia:candidate.via};
      }catch(e){
        if(oversize)throw e;
        failure=`素材服务 ${url.host} 请求失败：${e?.message||String(e)}`;
      }finally{clearTimeout(timer);}
    }
    throw new Error(mismatch||failure||'原图读取失败。');
  }catch(e){return {__exportError:e.message||String(e)};}
}
export function releaseImage(blobUrl){
  const map=window.__feishuOriginalImageBlobs;
  if(map?.has(blobUrl)){clearTimeout(map.get(blobUrl));URL.revokeObjectURL(blobUrl);map.delete(blobUrl);}
  return true;
}
