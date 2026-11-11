import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareImage,releaseImage} from '../extension/media.mjs';
const origin='https://tenant.feishu.cn';
const asset={id:'block123',token:'token',kind:'image',size:8,mime:'image/png',url:origin+'/space/api/box/stream/download/preview/token/?preview_type=16'};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
const drive={globalConfig:{drive_api:['internal-api-drive-stream.feishu.cn']}};
async function prepare(responses,a=asset,settings=drive){
  const requests=[],blobs=[],queue=Array.isArray(responses)?[...responses]:typeof responses==='function'?null:[responses];
  const next=typeof responses==='function'?responses:()=>queue.length?queue.shift():new Response('',{status:403});
  class MockURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:'+origin+'/test';}static revokeObjectURL(){}}
  const context={URL:MockURL,window:{...settings},location:{origin,href:origin+'/wiki/test'},document:{cookie:'_csrf_token=test-csrf'},AbortController,Blob,Uint8Array,TextDecoder,setTimeout:()=>1,clearTimeout(){},fetch:async(...args)=>{requests.push(args);return next();}};
  const result=await vm.runInNewContext(`(${prepareImage.toString()})(${JSON.stringify(a)})`,context);
  return {result,requests,blobs,context};
}
test('image is read from the same-origin ORIGIN_FILE preview route the Docx client renders',async()=>{
  const {result,requests,blobs}=await prepare(new Response(png,{headers:{'content-type':'image/png'}}));
  assert.equal(result.bytes,8);assert.equal(result.mountNode,'block123');assert.equal(result.resolvedVia,'preview-same-origin');assert.equal(result.blobUrl,'blob:'+origin+'/test');
  const url=new URL(requests[0][0]);
  assert.equal(url.origin,origin);assert.equal(url.pathname,'/space/api/box/stream/download/preview/token/');assert.equal(url.searchParams.get('preview_type'),'16');
  assert.equal(requests.length,1);assert.equal(requests[0][1].credentials,'include');assert.equal(requests[0][1].referrer,origin+'/wiki/test');assert.equal(requests[0][1].headers['X-CSRFToken'],'test-csrf');assert.equal(blobs[0].size,8);
});
test('HTTP 403 on every original-file route never counts as a saved image',async()=>{
  const {result,requests,blobs}=await prepare(()=>new Response(JSON.stringify({code:1061045,message:'permission denied'}),{status:403,headers:{'content-type':'application/json'}}));
  assert.match(result.__exportError,/HTTP 403/);assert.match(result.__exportError,/1061045/);assert.equal(blobs.length,0);assert.equal(requests.length,4);
});
test('page-configured Drive server is only a fallback after the same-origin read fails',async()=>{
  const {result,requests}=await prepare([new Response('',{status:403}),new Response(png,{headers:{'content-type':'image/png'}})]);
  assert.equal(requests.length,2);assert.equal(new URL(requests[1][0]).hostname,'internal-api-drive-stream.feishu.cn');
  assert.equal(new URL(requests[1][0]).pathname,'/space/api/box/stream/download/preview/token/');assert.equal(result.resolvedVia,'preview-drive');assert.equal(result.resourceHost,'internal-api-drive-stream.feishu.cn');
});
test('legacy download-all route stays available for tenants that still allow it',async()=>{
  const {result,requests}=await prepare([new Response('',{status:403}),new Response('',{status:403}),new Response(png,{headers:{'content-type':'image/png'}})]);
  assert.equal(requests.length,3);assert.equal(new URL(requests[2][0]).pathname,'/space/api/box/stream/download/all/token/');
  assert.equal(new URL(requests[2][0]).searchParams.get('mount_node_token'),'block123');assert.equal(result.resolvedVia,'download-all-drive');
});
test('a placeholder recorded size of 100 does not reject a larger original',async()=>{
  const body=new Uint8Array(2000);body.set(png);
  const {result,blobs}=await prepare(new Response(body,{headers:{'content-type':'image/png'}}),{...asset,size:100});
  assert.equal(result.bytes,2000);assert.equal(result.sizeMismatch,true);assert.equal(blobs.length,1);
});
test('a shrinking transfer is still rejected',async()=>{
  const {result}=await prepare(new Response(png,{headers:{'content-type':'image/png'}}),{...asset,size:2000});assert.match(result.__exportError,/字节数不符/);
});
test('thumbnail-sized response is rejected',async()=>{
  const {result,blobs}=await prepare(new Response(png,{headers:{'content-type':'image/png'}}),{...asset,size:100});assert.match(result.__exportError,/字节数不符/);assert.equal(blobs.length,0);
});
const jpeg=new Uint8Array([255,216,255,224,0,16,74,70]);
test('jpeg bytes recorded as png are saved as jpeg and the extension is corrected',async()=>{
  const {result,blobs}=await prepare(new Response(jpeg,{headers:{'content-type':'image/jpeg'}}));
  assert.equal(result.bytes,8);assert.equal(result.mime,'image/jpeg');assert.equal(result.ext,'jpg');
  assert.equal(result.formatCorrected,true);assert.equal(result.recordedMime,'image/png');assert.equal(blobs[0].size,8);
});
test('server content type decides when the bytes carry no signature',async()=>{
  const {result}=await prepare(new Response(new Uint8Array(8),{headers:{'content-type':'image/png'}}));
  assert.equal(result.mime,'image/png');assert.equal(result.ext,'png');assert.equal(result.formatCorrected,false);
});
test('a body that is not an image is refused instead of saved',async()=>{
  const {result,blobs}=await prepare(new Response(new Uint8Array(8),{headers:{'content-type':'application/octet-stream'}}));
  assert.match(result.__exportError,/不是可识别的图片/);assert.equal(blobs.length,0);
});
test('missing drive config still exports from the document origin instead of stopping',async()=>{
  const {result,requests}=await prepare(new Response(png,{headers:{'content-type':'image/png'}}),asset,{});
  assert.equal(requests.length,1);assert.equal(new URL(requests[0][0]).origin,origin);assert.equal(result.bytes,8);
});
test('external service configuration cannot receive image requests or page secrets',async()=>{
  const {requests}=await prepare(new Response(png,{headers:{'content-type':'image/png'}}),asset,{globalConfig:{drive_api:['feishu.cn.evil.example']}});
  assert.equal(requests.length,1);assert.equal(new URL(requests[0][0]).origin,origin);
});
test('large-image direct route uses the same origin original-file address',async()=>{
  const {result,requests}=await prepare(null,{...asset,size:100000000});
  assert.equal(result.direct,true);assert.equal(new URL(result.url).pathname,'/space/api/box/stream/download/preview/token/');assert.equal(requests.length,0);assert.equal(result.resolvedVia,'preview-same-origin');
});
test('asset without a usable token is refused before any request',async()=>{
  const {result,requests}=await prepare(null,{...asset,token:'../evil',url:undefined});assert.match(result.__exportError,/下载标识/);assert.equal(requests.length,0);
});
test('cleanup revokes only a tracked image blob',async()=>{
  const revoked=[],map=new Map([['blob:test',1]]);
  const c={window:{__feishuOriginalImageBlobs:map},clearTimeout(){},URL:{revokeObjectURL:u=>revoked.push(u)}};
  vm.runInNewContext(`(${releaseImage.toString()})('blob:test')`,c);assert.deepEqual(revoked,['blob:test']);assert.equal(map.size,0);
});
