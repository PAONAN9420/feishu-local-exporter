export function safeName(value, max = 100) {
  let s = String(value || '未命名文档').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  s = [...s].slice(0, max).join('').replace(/[. ]+$/g, '') || '未命名文档';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
  return s;
}
export const htmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeMD = s => s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.) /gm, '$1\\$2 ');
export function plainText(text) {
  const t = text?.initialAttributedTexts?.text || {};
  return Object.keys(t).sort((a,b) => Number(a)-Number(b)).map(k => t[k]).join('');
}
function formatRun(s, attrs) {
  if (!s) return '';
  let out = escapeMD(s);
  const on = k => attrs[k] === 'true' || attrs[k] === true;
  if (on('inline-code') || on('code')) {
    const fence = '`'.repeat(Math.max(0,...(s.match(/`+/g)||[]).map(x=>x.length))+1);
    out = `${fence} ${s} ${fence}`;
  } else {
    const leading = out.match(/^\s*/)[0], trailing = out.match(/\s*$/)[0];
    let body = out.slice(leading.length, out.length-trailing.length || undefined);
    if (!out.trim()) return out;
    if (on('bold')) body = `**${body}**`;
    if (on('italic')) body = `*${body}*`;
    if (on('strikethrough')) body = `~~${body}~~`;
    out = leading + body + trailing;
  }
  if (attrs.link) {
    let link = attrs.link;
    try { link = decodeURIComponent(link); } catch {}
    if (/^https?:\/\//i.test(link)) out = `[${out}](<${link.replace(/[<>\r\n]/g, c=>encodeURIComponent(c))}>)`;
  }
  return out;
}
export function richText(text, warnings = []) {
  const initial = text?.initialAttributedTexts;
  if (!initial) return '';
  const pool = text.apool?.numToAttrib || {};
  return Object.keys(initial.text||{}).sort((a,b)=>Number(a)-Number(b)).map(key => {
    const source = initial.text[key], encoded = initial.attribs?.[key];
    if (!encoded) return escapeMD(source);
    const ops = /((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?\+([0-9a-z]+)/g;
    let pos = 0, out = '', m;
    while ((m = ops.exec(encoded))) {
      const count = parseInt(m[2],36), attrs = {};
      for (const a of m[1].matchAll(/\*([0-9a-z]+)/g)) {
        const pair = pool[String(parseInt(a[1],36))];
        if (pair) attrs[pair[0]] = pair[1];
      }
      out += formatRun(source.slice(pos,pos+count), attrs); pos += count;
    }
    if (pos !== source.length) {
      warnings.push('一处富文本样式解析不完整，已保留原文字。');
      return escapeMD(source);
    }
    return out;
  }).join('');
}
export function references(block) {
  const d = block?.data || block || {};
  const cells = Array.isArray(d.table?.cells) ? d.table.cells : [];
  const cellSet = d.cell_set && typeof d.cell_set === 'object' ? Object.values(d.cell_set).map(cell => cell?.block_id).filter(Boolean) : [];
  return [...new Set([...(d.children||[]), ...cells, ...cellSet])];
}
export function inspectGraph(map, root) {
  const visited = new Set(), missing = new Set(), active = new Set(), cycles = [];
  function walk(id) {
    if (active.has(id)) { cycles.push(id); return; }
    if (visited.has(id)) return;
    if (!map[id]) { missing.add(id); return; }
    visited.add(id); active.add(id);
    references(map[id]).forEach(walk); active.delete(id);
  }
  walk(root);
  return {visited:[...visited], missing:[...missing], cycles};
}
const langExtensions = {python:'py',javascript:'js',typescript:'ts',json:'json',html:'html',css:'css',sql:'sql',bash:'sh',shell:'sh',powershell:'ps1',java:'java',c:'c',cpp:'cpp',csharp:'cs',yaml:'yaml',markdown:'md',xml:'xml'};
export function buildDocument(snapshot) {
  const {map, root, origin, sourceUrl} = snapshot;
  const warnings = [...(snapshot.warnings||[])], files = [], assets = [], sheetLinks = [], dedup = new Map();
  const graph = inspectGraph(map,root);
  if (graph.missing.length || graph.cycles.length) throw new Error(`正文结构不完整：缺少 ${graph.missing.length} 块，循环引用 ${graph.cycles.length} 处。`);
  const title = snapshot.title || plainText(map[root]?.data?.text) || '未命名文档';
  const name = safeName(title), counts = {code:0,table:0,image:0,video:0,file:0};
  function media(d, id) {
    const item = d.image || d.file || d.video || {}, token = item.token || d.token;
    const mime = item.mimeType || item.mime_type || '';
    const kind = d.type === 'image' ? 'image' : mime.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(item.name||'') ? 'video' : 'file';
    if (!token || !/^[a-zA-Z0-9_-]+$/.test(token)) { warnings.push(`资源 ${id} 没有可用的下载标识。`); return `> [资源未导出：${escapeMD(item.name||d.type)}]`; }
    const key = kind+':'+token;
    let asset = dedup.get(key);
    if (!asset) {
      const extByMime = {'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg','image/avif':'avif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'};
      const ext = extByMime[mime] || (item.name||'').match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() || 'bin';
      const dir = {image:'images',video:'videos',file:'attachments/files'}[kind];
      const path = `${dir}/${kind}-${String(++counts[kind]).padStart(3,'0')}.${ext}`;
      // ORIGIN_FILE preview is the route the Docx client itself uses: preview_type
      // 16 returns the byte-identical original and only needs the document read
      // permission. /download/all/ is a "download file" permission and answers 403
      // on documents that allow reading but not downloading — verified for images,
      // videos and text attachments alike.
      const url = new URL(`/space/api/box/stream/download/preview/${token}/?preview_type=16`,origin);
      asset = {key,token,id,kind,path,mime,size:Number(item.size)||0,width:item.width,height:item.height,name:item.name||path,url:url.href};
      dedup.set(key,asset); assets.push(asset);
    }
    const caption = plainText(item.caption?.text) || item.name || (kind==='image'?'图片':'视频');
    return kind==='image' ? `![${escapeMD(caption)}](./${asset.path})` : `[${kind==='video'?'视频':'附件'}：${escapeMD(caption)}](./${asset.path})`;
  }
  function children(d) {return (d.children||[]).map(id=>render(id)).filter(Boolean).join('\n\n');}
  function table(d,id) {
    const props = d.table?.property || d.property || d.table || d;
    const cellSet = d.cell_set || d.table?.cell_set || null;
    const rowIds = d.rows_id || d.table?.rows_id || null;
    const colIds = d.columns_id || d.table?.columns_id || null;
    const cols = (colIds && colIds.length) || props.column_size || props.column_count || (Array.isArray(props.column_width)?props.column_width.length:0);
    const cellIds = d.table?.cells || d.children || [];
    let rows = null;
    if (Array.isArray(rowIds) && Array.isArray(colIds) && rowIds.length && colIds.length && cellSet) {
      // Current Docx table shape: rows_id/columns_id plus cell_set keyed by rowId+colId.
      rows = rowIds.map(r => colIds.map(c => {
        const cell = cellSet[r + c] || cellSet[c + r] || {};
        return { html: cell.block_id && map[cell.block_id] ? render(cell.block_id) : '', merge: cell.merge_info || { row_span: 1, col_span: 1 } };
      }));
    } else if (cols && cellIds.length) {
      // Older shape: flat cell list plus merge_info indexed by position.
      rows = [];
      for (let i = 0; i < cellIds.length; i += cols) rows.push(cellIds.slice(i, i + cols).map(cid => ({ html: render(cid) })));
      rows.forEach((row, r) => row.forEach((cell, c) => { cell.merge = (props.merge_info || [])[r * cols + c] || { row_span: 1, col_span: 1 }; }));
    }
    if (!rows || !rows.length) {
      warnings.push(`表格 ${id} 的行列结构无法识别，已保留单元格文本。`);
      return children(d);
    }
    const merged = rows.some(row => row.some(cell => (cell.merge?.row_span || 1) > 1 || (cell.merge?.col_span || 1) > 1));
    const n = String(++counts.table).padStart(3, '0');
    const csv = rows.map(row => row.map(cell => '"' + String(cell.html).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    files.push({ path: `attachments/tables/table-${n}.csv`, content: '\ufeff' + csv });
    let markup = '<table>\n';
    rows.forEach(row => {
      markup += '<tr>';
      row.forEach(cell => {
        const span = cell.merge || {};
        if (span.row_span === 0 || span.col_span === 0) return;
        markup += `<td rowspan="${Number(span.row_span) || 1}" colspan="${Number(span.col_span) || 1}">${htmlEscape(cell.html).replace(/\n/g, '<br>')}</td>`;
      });
      markup += '</tr>\n';
    });
    markup += '</table>';
    files.push({ path: `attachments/tables/table-${n}.html`, content: `<!doctype html><meta charset="utf-8"><style>table{border-collapse:collapse}td{border:1px solid #aaa;padding:8px;white-space:pre-wrap}</style>${markup}` });
    const md = merged ? markup : rows.map((row, i) => '| ' + row.map(cell => String(cell.html).replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |' + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n');
    return md + `\n\n[表格 CSV](./attachments/tables/table-${n}.csv) · [表格 HTML](./attachments/tables/table-${n}.html)`;
  }
  function render(id) {
    const d=map[id].data||map[id], t=d.type, text=richText(d.text,warnings);
    if(d.hidden) warnings.push(`内容块 ${id} 带隐藏标记，已按原始结构保留，请核对。`);
    if(t==='page') return children(d);
    if(t==='image'||t==='file'||t==='video') return media(d,id);
    if(t==='code') {
      const raw=plainText(d.text), lang=String(d.language||'').toLowerCase().replace(/[^a-z0-9+#_-]/g,'');
      const n=String(++counts.code).padStart(3,'0'), path=`attachments/code/code-${n}.${langExtensions[lang]||'txt'}`;
      files.push({path,content:raw});
      const fence='`'.repeat(Math.max(2,...(raw.match(/`+/g)||[]).map(s=>s.length))+1);
      return `${fence}${lang==='plaintext'?'':lang}\n${raw}\n${fence}\n\n[代码文件](./${path})`;
    }
    if(t==='table') return table(d,id);
    if(t==='bookmark'||t==='link_preview') {
      const card=d.bookmark||d.link_preview||{};
      const title=String(card.title||card.url||'书签');
      const href=String(card.url||'');
      const link=/^https?:\/\//i.test(href)?`[${escapeMD(title)}](<${href.replace(/[<>\r\n]/g,c=>encodeURIComponent(c))}>)`:`**${escapeMD(title)}**`;
      const summary=String(card.summary||'').replace(/\s*\n+\s*/g,' ').trim();
      return summary?`${link}\n\n> ${escapeMD(summary)}` : link;
    }
    if(t==='sheet'||t==='bitable') {
      const kind=t==='sheet'?'电子表格':'多维表格';
      const token=String(d.token||d.sheet?.token||d.bitable?.token||'').replace(/[^a-zA-Z0-9_-]/g,'');
      const href=token?`${origin}/${t==='sheet'?'sheets':'base'}/${token}`:`${sourceUrl}#${id}`;
      // Feishu delivers embedded sheet content as gzip'd binary snapshots
      // (/space/api/v3/sheet/client_vars + /block), not as cell values, so the
      // cell grid cannot be read without reimplementing that private format.
      warnings.push(`嵌入${kind} ${id} 未导出单元格数据：飞书以二进制快照下发内容，插件不解码；已保留可点击链接。`);
      if(token)sheetLinks.push({blockId:id,kind,token,url:href});
      return `> [嵌入${kind}：打开原表](<${href}>)`;
    }
    if(t==='base_refer'){      // Base blocks carry only "<baseToken>_<tableId>" plus an optional view id.
      const token=String(d.token||''),view=String(d.view_id||'');
      const cut=token.indexOf('_tbl'),base=cut>0?token.slice(0,cut):token,table=cut>0?token.slice(cut+1):'';
      const href=`${origin}/base/${base}${table?`?table=${table}${view?`&view=${view}`:''}`:''}`;
      warnings.push(`嵌入多维表格 ${id} 未导出记录数据：飞书以二进制快照下发内容，插件不解码；已保留可点击链接。`);
      sheetLinks.push({blockId:id,kind:'bitable',token,url:href});
      return `> [嵌入多维表格：打开原表](<${href}>)`;
    }
    if(t==='isv'){
      // Third-party app block: the document only stores an app id and a block type
      // id, and the content is rendered by that app inside an iframe.
      const app=String(d.manifest?.app_name||'').trim(),typeId=String(d.block_type_id||'').trim();
      const label=app?`第三方应用：${escapeMD(app)}`:'第三方应用内容';
      warnings.push(`第三方应用嵌入块${typeId?`（${typeId}）`:''} ${id} 无法离线导出，已在原位置保留说明。`);
      return `> [${label}未导出]`;
    }
    if(t==='divider') return '---';
    if(/^heading[1-9]$/.test(t)) return '#'.repeat(Math.min(6,Number(t.slice(7))))+' '+text+(d.children?.length?'\n\n'+children(d):'');
    if(['bullet','ordered','todo'].includes(t)) {
      const prefix=t==='ordered'?`${Number(d.sequence)||1}. `:t==='todo'?`- [${d.done||d.checked?'x':' '}] `:'- ';
      const body=text.replace(/\n/g,'\n'+' '.repeat(prefix.length));
      return prefix+body+(d.children?.length?'\n\n'+children(d).split('\n').map(s=>' '.repeat(prefix.length)+s).join('\n'):'');
    }
    if(t==='quote_container'||t==='quote'||t==='callout') return [text,children(d)].filter(Boolean).join('\n\n').split('\n').map(s=>'> '+s).join('\n');
    if(['text','grid','grid_column','view','table_cell'].includes(t)) return [text,children(d)].filter(Boolean).join('\n\n');
    warnings.push(`未适配内容类型 ${t}（${id}），已保留文字和子内容。`);
    return [text,children(d),`> [需核对内容：${t}]`].filter(Boolean).join('\n\n');
  }
  const body=render(root);
  return {title,name,markdown:`# ${escapeMD(title)}\n\n${body}\n`,files,assets,sheetLinks,warnings:[...new Set(warnings)],graph,counts,sourceUrl};
}
export function markAssetFailures(markdown, failures) {
  for(const asset of failures) {
    const path=asset.path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=new RegExp(`!?\\[([^\\n]*?)\\]\\(\\./${path}\\)`,'g');
    markdown=markdown.replace(pattern,(_,label)=>`[${label}](<${asset.sourceUrl||'#'}>) **[${asset.kind==='image'?'原图':'文件'}未下载]**`);
  }
  return markdown;
}
