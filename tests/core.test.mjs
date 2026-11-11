import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {safeName,richText,plainText,inspectGraph,buildDocument,markAssetFailures} from '../extension/core.mjs';
import {collectDocument} from '../extension/collector.mjs';
const text=s=>({initialAttributedTexts:{text:{0:s}}});
const block=(type,data={})=>({data:{type,children:[],...data}});
const snapshot=map=>({map,root:'root',title:'测试文档',origin:'https://my.feishu.cn',sourceUrl:'https://my.feishu.cn/wiki/test'});
test('Windows names handle reserved names, separators, trailing dots and unicode',()=>{
  assert.equal(safeName('CON'),'_CON');assert.equal(safeName('a/b:c? '),'a_b_c_');assert.equal(safeName('abc...'),'abc');assert.equal(safeName('😀'.repeat(120)).length,200);
});
test('rich text preserves UTF-16 offsets, bold, encoded links and code',()=>{
  const t={apool:{numToAttrib:{0:['bold','true'],1:['link','https%3A%2F%2Fexample.com%2F']}},initialAttributedTexts:{text:{0:'你好😀 链接'},attribs:{0:'*0+4+1*1+2'}}};
  assert.equal(richText(t),'**你好😀** [链接](<https://example.com/>)');assert.equal(plainText(t),'你好😀 链接');
});
test('incomplete rich-text styles preserve text with a warning',()=>{const warnings=[];assert.equal(richText({initialAttributedTexts:{text:{0:'abc'},attribs:{0:'+1'}}},warnings),'abc');assert.equal(warnings.length,1);});
test('graph detects missing blocks and cycles',()=>{
  assert.deepEqual(inspectGraph({root:block('page',{children:['missing']})},'root').missing,['missing']);
  assert.equal(inspectGraph({root:block('page',{children:['root']})},'root').cycles.length,1);
});
test('missing blocks prevent falsely complete export',()=>assert.throws(()=>buildDocument(snapshot({root:block('page',{children:['x']})})),/不完整/));
test('nested ordered and bullet lists preserve hierarchy',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['a']}),a:block('ordered',{text:text('父项'),children:['b']}),b:block('bullet',{text:text('子项')})}));
  assert.match(d.markdown,/1\. 父项\n\n   - 子项/);
});
test('code fence length adapts to embedded backticks, file preserves exact content',()=>{
  const raw='print("你好")\n```\n';const d=buildDocument(snapshot({root:block('page',{children:['c']}),c:block('code',{language:'Python',text:text(raw)})}));
  assert.equal(d.files[0].path,'attachments/code/code-001.py');assert.equal(d.files[0].content,raw);assert.match(d.markdown,/````python/);
});
test('media deduplicates same token without duplicating downloads',()=>{
  const b=block('image',{image:{token:'token',mimeType:'image/png',size:23}});
  const d=buildDocument(snapshot({root:block('page',{children:['a','b']}),a:b,b}));assert.equal(d.assets.length,1);assert.equal(d.markdown.match(/image-001.png/g).length,2);
  const url=new URL(d.assets[0].url);
  assert.equal(url.pathname,'/space/api/box/stream/download/preview/token/');
  assert.equal(url.searchParams.get('preview_type'),'16');
});
test('all media kinds use the ORIGIN_FILE preview route',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['i','f','v']}),i:block('image',{image:{token:'imgtoken',mimeType:'image/png',size:10}}),f:block('file',{file:{token:'filetoken',mimeType:'text/plain',size:10,name:'a.txt'}}),v:block('file',{file:{token:'videotoken',mimeType:'video/mp4',size:10,name:'b.mp4'}})}));
  for(const kind of ['image','file','video']){
    const asset=d.assets.find(a=>a.kind===kind),url=new URL(asset.url);
    assert.equal(url.pathname,`/space/api/box/stream/download/preview/${asset.token}/`,kind);
    assert.equal(url.searchParams.get('preview_type'),'16',kind);
  }
});
test('current Docx table shape keeps rows, columns and merged spans',()=>{
  const map={root:block('page',{children:['t']}),t:block('table',{
    rows_id:['row1','row2'],columns_id:['col1','col2','col3'],
    cell_set:{
      row1col1:{merge_info:{row_span:1,col_span:1},block_id:'c11'},
      row1col2:{merge_info:{row_span:1,col_span:2},block_id:'c12'},
      row1col3:{merge_info:{row_span:0,col_span:0},block_id:'c13'},
      row2col1:{merge_info:{row_span:1,col_span:1},block_id:'c21'},
      row2col2:{merge_info:{row_span:1,col_span:1},block_id:'c22'},
      row2col3:{merge_info:{row_span:1,col_span:1},block_id:'c23'}
    }})};
  const values={c11:'甲',c12:'合并',c13:'',c21:'乙',c22:'丙',c23:'丁'};
  for(const [id,value] of Object.entries(values)){map[id]=block('table_cell',{children:['x'+id]});map['x'+id]=block('text',{text:text(value)});}
  const d=buildDocument(snapshot(map));
  assert.deepEqual(d.warnings,[]);
  assert.equal(d.counts.table,1);
  const csv=d.files.find(f=>f.path.endsWith('.csv')).content;
  assert.ok(csv.includes('"甲"')&&csv.includes('"丁"'));
  const html=d.files.find(f=>f.path.endsWith('.html')).content;
  assert.ok(html.includes('colspan="2"'));
  assert.ok(!html.includes('<td rowspan="1" colspan="1"></td>'),'covered cell must not emit an empty cell');
  assert.match(d.markdown,/<table>/);
});

test('table yields readable Markdown and standalone CSV plus HTML',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['t']}),t:block('table',{table:{property:{column_size:2},cells:['a','b','c','d']}}),a:block('text',{text:text('甲')}),b:block('text',{text:text('乙')}),c:block('text',{text:text('a,"b"')}),d:block('text',{text:text('值|换行\n下一行')})}));
  assert.match(d.markdown,/\| 甲 \| 乙 \|/);assert.ok(d.files.find(f=>f.path.endsWith('.csv')).content.includes('"a,""b"""'));assert.match(d.markdown,/值\\\|换行<br>下一行/);
});
test('merged cells retain spans in HTML',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['t']}),t:block('table',{table:{property:{column_size:2,merge_info:[{row_span:1,col_span:2},{row_span:0,col_span:0}]},cells:['a','b']}}),a:block('text',{text:text('合并')}),b:block('text',{text:text('')})}));assert.match(d.markdown,/colspan="2"/);
});
test('embedded spreadsheets stay linkable and say what is missing',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['s']}),s:block('sheet',{token:'shtcnABC123'})}));
  assert.equal(d.warnings.length,1);assert.match(d.warnings[0],/未导出单元格数据/);
  assert.match(d.markdown,/\[嵌入电子表格：打开原表\]\(<https:\/\/my\.feishu\.cn\/sheets\/shtcnABC123>\)/);
});
test('third-party app blocks keep an explanatory note instead of raw type noise',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['i']}),i:block('isv',{block_type_id:'blk_demo_app',manifest:{app_name:'',app_version:'0.0.43'}})}));
  assert.equal(d.warnings.length,1);assert.match(d.warnings[0],/第三方应用嵌入块/);
  assert.match(d.markdown,/\[第三方应用内容未导出\]/);
});
test('base_refer blocks link to the base table and say what is missing',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['b']}),b:block('base_refer',{token:'demoBase_tblDemo',view_id:'viewDemo'})}));
  assert.equal(d.warnings.length,1);assert.match(d.warnings[0],/未导出记录数据/);
  assert.match(d.markdown,/\[嵌入多维表格：打开原表\]\(<https:\/\/my\.feishu\.cn\/base\/demoBase\?table=tblDemo&view=viewDemo>\)/);
  assert.deepEqual(d.sheetLinks,[{blockId:'b',kind:'bitable',token:'demoBase_tblDemo',url:'https://my.feishu.cn/base/demoBase?table=tblDemo&view=viewDemo'}]);
});
test('bookmark cards become a link plus summary without a warning',()=>{
  const d=buildDocument(snapshot({root:block('page',{children:['b']}),b:block('bookmark',{bookmark:{title:'一篇好文章',url:'https://example.com/a?x=1',summary:'第一行\n第二行'}})}));
  assert.deepEqual(d.warnings,[]);
  assert.match(d.markdown,/\[一篇好文章\]\(<https:\/\/example\.com\/a\?x=1>\)/);
  assert.match(d.markdown,/> 第一行 第二行/);
});
test('failed image replaced by source link, not broken embedded image',()=>{
  const result=markAssetFailures('![图片](./images/image-001.png)',[{path:'images/image-001.png',kind:'image',sourceUrl:'https://example.com'}]);
  assert.match(result,/原图未下载/);assert.ok(!result.startsWith('!'));assert.ok(!result.includes('./images/'));
});
async function runCollector(initial,responses) {
  const calls=[];const context={window:{DATA:{clientVars:initial,meta:{title:'Doc'}}},document:{cookie:'',title:'Doc'},location:{href:'https://my.feishu.cn/wiki/test',origin:'https://my.feishu.cn'},AbortController,AbortSignal,URL,setTimeout,clearTimeout,fetch:async url=>{calls.push(url);const value=responses.shift();return {ok:true,json:async()=>value};}};
  const result=await vm.runInNewContext(`(${collectDocument.toString()})('test')`,context);if(result.__exportError)throw new Error(result.__exportError);return {result,calls};
}
test('collector follows concurrent pagination and yields complete graph',async()=>{
  const initial={mode:7,data:{id:'root',block_map:{root:block('page',{children:['a','b']})},has_more:true,concurrent:true,next_cursors:['a','b']}};
  const {result,calls}=await runCollector(initial,[{code:0,data:{block_map:{a:block('text',{text:text('a')})},has_more:false}},{code:0,data:{block_map:{b:block('text',{text:text('b')})},has_more:false}}]);
  assert.equal(calls.length,2);assert.equal(inspectGraph(result.map,'root').missing.length,0);
});
test('collector rejects login-required response instead of emitting partial content',async()=>{
  const initial={data:{id:'root',block_map:{root:block('page')},has_more:true,cursor:'a'}};
  await assert.rejects(()=>runCollector(initial,[{code:5,msg:'Login Required'}]),/未允许读取/);
});
test('collector rejects missing pagination cursor',async()=>{await assert.rejects(()=>runCollector({data:{id:'root',block_map:{root:block('page')},has_more:true}},[]),/未提供下一页/);});
