import React,{useRef,useState} from 'react';
import LayoutEditor from './LayoutEditor.jsx';
import {namePanels,editName,validateName} from './name-edit.js';
import {textForRefs} from './source-refs.js';
export default function NameEditor({project,candidate,onChange,busy,model,onDraw}){
 const [drawing,setDrawing]=useState([]);
 const [page,setPage]=useState(0),[error,setError]=useState(''),[selected,setSelected]=useState(null);
 const projected={...project,...candidate.patch,layoutHistory:candidate.layoutHistory??[],layoutRedo:candidate.layoutRedo??[]};
 const current=useRef(projected);current.current=projected;
 async function run(label,fn){try{setError('');await fn();}catch(e){setError(e.message);}}
 const remember=next=>onChange({...next,nameUndo:[...(candidate.nameUndo??[]),{patch:candidate.patch,redrawPanelIds:candidate.redrawPanelIds}].slice(-30),nameRedo:[]});
 const change=fn=>run('原稿割当',async()=>{const groups=namePanels(candidate).map(p=>({id:p.id,refs:structuredClone(p.sourceRefs)}));fn(groups);await remember(editName(project,candidate,groups));});
 const undo=redo=>run('ネーム履歴',()=>{const key=redo?'nameRedo':'nameUndo',other=redo?'nameUndo':'nameRedo',stack=candidate[key]??[],value=stack.at(-1);if(!value)return;return onChange({...candidate,...value,nameConfirmed:false,[key]:stack.slice(0,-1),[other]:[...(candidate[other]??[]),{patch:candidate.patch,redrawPanelIds:candidate.redrawPanelIds}]});});
 return <section aria-label="生成前のネーム"><h4>{candidate.nameConfirmed?'確定したネーム':'原文入りネーム候補'}</h4>{error&&<p role="alert">{error}</p>}
 <button disabled={busy||!candidate.nameUndo?.length||candidate.nameConfirmed} onClick={()=>undo(false)}>ネームUndo</button><button disabled={busy||!candidate.nameRedo?.length||candidate.nameConfirmed} onClick={()=>undo(true)}>ネームRedo</button>
 <label>候補ページ<select value={Math.min(page,Math.max(0,projected.layout.pages.length-1))} onChange={e=>setPage(Number(e.target.value))}>{projected.layout.pages.map((p,i)=><option key={p.id} value={i}>{i+1}</option>)}</select></label>
 <LayoutEditor project={projected} current={current} commit={p=>remember(validateName(project,{...candidate,manualLayout:true,patch:{...candidate.patch,layout:p.layout},layoutHistory:p.layoutHistory,layoutRedo:p.layoutRedo}))} run={run} busy={busy||candidate.nameConfirmed} pageIndex={Math.min(page,Math.max(0,projected.layout.pages.length-1))} setPage={setPage} selected={selected} onSelect={setSelected} model={model}/>
 {namePanels(candidate).map((p,i,panels)=><fieldset key={p.id} disabled={busy||candidate.nameConfirmed}><legend>コマ {i+1} · {p.image?'作画あり':'未作画'}</legend>{p.sourceRefs.map((ref,j)=><div key={j}><pre className="source-text">{textForRefs([ref],project.snapshots)}</pre>
 {j===0&&i>0&&<button onClick={()=>change(g=>{g[i-1].refs.push(g[i].refs.shift());if(!g[i].refs.length)g.splice(i,1);})}>前のコマへ移す</button>}
 {j===p.sourceRefs.length-1&&i<panels.length-1&&<button onClick={()=>change(g=>{g[i+1].refs.unshift(g[i].refs.pop());if(!g[i].refs.length)g.splice(i,1);})}>次のコマへ移す</button>}
 {j>0&&<button onClick={()=>change(g=>{const tail=g[i].refs.splice(j);g.splice(i+1,0,{refs:tail});})}>ここでコマを分割</button>}</div>)}
 {i<panels.length-1&&<button onClick={()=>change(g=>{g[i].refs.push(...g[i+1].refs);g.splice(i+1,1);})}>次のコマと統合</button>}</fieldset>)}
 {candidate.nameConfirmed&&<fieldset disabled={busy}><legend>確定ネームから作画</legend>{namePanels(candidate).filter(p=>!p.image).map((p,i)=><div key={p.id}><label><input type="checkbox" checked={drawing.includes(p.id)} onChange={e=>setDrawing(e.target.checked?[...drawing,p.id]:drawing.filter(id=>id!==p.id))}/>作画対象 {i+1}</label><button onClick={()=>onDraw?.([p.id])}>この候補コマを生成</button></div>)}<button disabled={!drawing.some(id=>candidate.redrawPanelIds.includes(id))} onClick={()=>onDraw?.(drawing.filter(id=>candidate.redrawPanelIds.includes(id)))}>選択した候補コマを生成</button></fieldset>}
 <p>原文は編集しません。割当変更したコマは作画待ちに戻り、旧採用版は保持されます。</p>
 <button disabled={busy} onClick={()=>run('ネーム確定',()=>onChange({...validateName(project,candidate),nameConfirmed:!candidate.nameConfirmed}))}>{candidate.nameConfirmed?'ネームの確定を解除':'このネームを確定'}</button>
 </section>;
}
