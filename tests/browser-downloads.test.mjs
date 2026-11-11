import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {matchesDownloadPath,validateDownload,waitDownload} from '../extension/browser-downloads.mjs';
test('placeholder size 100 accepts the real file while a short transfer still fails',()=>{
  const info=validateDownload({kind:'image',size:100,mime:'image/png'},{state:'complete',fileSize:103517,mime:'image/png'});
  assert.equal(info.bytes,103517);assert.equal(info.sizeMismatch,true);
  assert.throws(()=>validateDownload({kind:'image',size:2000,mime:'image/png'},{state:'complete',fileSize:1000,mime:'image/png'}),/大小不符/);
});
test('browser default directory accepts nested relative path and browser-renamed duplicates',()=>{
  assert.equal(matchesDownloadPath('E:\\任意下载目录\\文章\\images\\image-001.png','文章/images/image-001.png'),true);
  // A retried download can come back as "name (1).ext"; the real name is recorded
  // and the Markdown link follows it, so this must not fail the asset.
  assert.equal(matchesDownloadPath('E:\\下载\\文章\\文章 (1).md','文章/文章.md'),true);
  assert.equal(matchesDownloadPath('E:\\下载\\其他\\文章.md','文章/文章.md'),false);
});
test('text attachments are accepted when the recorded size matches',()=>{
  assert.equal(validateDownload({kind:'file',size:28521,mime:'text/plain',name:'a.txt'},{state:'complete',fileSize:28521,mime:'text/plain'}).bytes,28521);
  assert.equal(validateDownload({kind:'file',size:9117,mime:'text/html',name:'b.html'},{state:'complete',fileSize:9117,mime:'text/html'}).bytes,9117);
  // A page returned instead of a video never matches the recorded size.
  assert.throws(()=>validateDownload({kind:'video',size:31304490,mime:'video/mp4',name:'c.mp4'},{state:'complete',fileSize:9117,mime:'text/html'}),/大小不符/);
  // Without a recorded size, a page-looking body is still refused unless the asset is itself text.
  assert.throws(()=>validateDownload({kind:'video',size:0,mime:'video/mp4',name:'c.mp4'},{state:'complete',fileSize:50,mime:'text/html'}),/网页/);
  assert.equal(validateDownload({kind:'file',size:0,mime:'text/plain',name:'d.txt'},{state:'complete',fileSize:50,mime:'text/plain'}).bytes,50);
});
test('completed original download verifies expected bytes',()=>{
  assert.equal(validateDownload({kind:'video',size:1000},{state:'complete',fileSize:1000,mime:'video/mp4',id:3}).bytes,1000);
  assert.throws(()=>validateDownload({kind:'video',size:1000},{state:'complete',fileSize:500,mime:'video/mp4'}),/大小不符/);
});
test('browser downloads reject error documents and streaming playlists',()=>{
  assert.throws(()=>validateDownload({kind:'image',size:0,mime:'image/png'},{state:'complete',fileSize:50,mime:'text/html'}),/网页/);
  assert.throws(()=>validateDownload({kind:'video',size:0,mime:'video/mp4'},{state:'complete',fileSize:50,mime:'application/vnd.apple.mpegurl'}),/分片/);
});
test('a download that never progresses is reported instead of polled forever',async()=>{
  let ticks=0;const clock=()=>ticks*10000;
  const rpc=async()=>({state:'in_progress',bytesReceived:0});
  await assert.rejects(()=>waitDownload(rpc,1,{sleep:async()=>{ticks++;},clock,stallMs:30000}),/下载卡住/);
});
test('a stalled download with growing bytes keeps waiting',async()=>{
  let ticks=0;const clock=()=>ticks*10000;const bytes=[0,1000,2000,3000];
  const rpc=async()=>({state:'in_progress',bytesReceived:bytes.length?bytes.shift():3000});
  await assert.rejects(()=>waitDownload(rpc,1,{sleep:async()=>{ticks++;},clock,stallMs:30000}),/下载卡住/,'after progress stops it must still give up');
});
test('download monitor gives up after the total limit',async()=>{
  let ticks=0;const clock=()=>ticks*1000;
  const rpc=async()=>({state:'in_progress',bytesReceived:ticks});
  await assert.rejects(()=>waitDownload(rpc,1,{sleep:async()=>{ticks++;},clock,stallMs:60000,limitMs:180000}),/超时/);
});
test('download monitor waits until complete instead of treating download start as success',async()=>{
  const states=[{state:'in_progress',bytesReceived:10},{state:'complete',fileSize:20}];let calls=0;
  const item=await waitDownload(async()=>{calls++;return states.shift();},1,{sleep:async()=>{}});assert.equal(calls,2);assert.equal(item.fileSize,20);
});
test('download monitor propagates interrupted errors',async()=>{
  await assert.rejects(()=>waitDownload(async()=>({state:'interrupted',error:'SERVER_UNAUTHORIZED'}),1),/SERVER_UNAUTHORIZED/);
});
test('cancellation stops browser download',async()=>{
  const controller=new AbortController();controller.abort();const calls=[];
  await assert.rejects(()=>waitDownload(async(...args)=>calls.push(args),5,{signal:controller.signal}),/取消/);assert.deepEqual(calls,[['downloadCancel',5]]);
});
test('active content bundle contains no directory picker or separate page navigation',async()=>{
  const content=await fs.readFile(new URL('../extension/content.bundle.js',import.meta.url),'utf8');
  const bg=await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  assert.ok(content.includes('保存全文与素材'));assert.ok(!content.includes('showDirectoryPicker'));assert.ok(!content.includes('indexedDB'));assert.ok(!bg.includes('tabs.create'));assert.ok(bg.includes('saveAs:false'));
});
