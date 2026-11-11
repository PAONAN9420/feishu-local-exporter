import test from 'node:test';
import assert from 'node:assert/strict';
const url=new URL('../extension/background.js',import.meta.url).href;
function harness({pageAlive=true,injectFails=false}={}){
  const calls={sent:[],injected:[],badges:[]};
  const chrome={
    runtime:{onMessage:{addListener(){}}},
    action:{onClicked:{addListener(fn){calls.click=fn;}},setBadgeText:async({text})=>{calls.badges.push(text);},setBadgeBackgroundColor:async()=>{}},
    tabs:{sendMessage:async()=>{if(!pageAlive)throw new Error('Could not establish connection. Receiving end does not exist.');calls.sent.push(1);}},
    scripting:{executeScript:async()=>{calls.injected.push(1);if(injectFails)throw new Error('Cannot access contents of the page.');pageAlive=true;}},
    downloads:{},storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}
  };
  globalThis.chrome=chrome;
  return calls;
}
const doc='https://my.feishu.cn/wiki/demoDocument';
test('toolbar click reaches a page whose content script is already loaded',async()=>{
  const calls=harness();
  await import(url+'?case=1');
  await calls.click({id:1,url:doc});
  assert.equal(calls.sent.length,1);assert.equal(calls.injected.length,0);assert.deepEqual(calls.badges,[]);
});
test('toolbar click injects the content script and asks again instead of doing nothing',async()=>{
  const calls=harness({pageAlive:false});
  await import(url+'?case=2');
  await calls.click({id:2,url:doc});
  assert.equal(calls.injected.length,1);
  assert.equal(calls.sent.length,1,'the click must be delivered after injecting, not silently swallowed');
});
test('failed injection reports through the toolbar badge',async()=>{
  const original=globalThis.setTimeout;
  globalThis.setTimeout=(fn)=>{fn();return 0;};
  try{
    const calls=harness({pageAlive:false,injectFails:true});
    await import(url+'?case=3');
    await calls.click({id:3,url:doc});
    assert.deepEqual(calls.badges,['!','']);
  }finally{globalThis.setTimeout=original;}
});
test('non-document pages get a badge hint instead of silence',async()=>{
  const original=globalThis.setTimeout;
  globalThis.setTimeout=(fn)=>{fn();return 0;};
  try{
    const calls=harness();
    await import(url+'?case=4');
    await calls.click({id:4,url:'https://my.feishu.cn/drive/home/'});
    assert.equal(calls.injected.length,0);assert.equal(calls.sent.length,0);assert.deepEqual(calls.badges,['?','']);
  }finally{globalThis.setTimeout=original;}
});
