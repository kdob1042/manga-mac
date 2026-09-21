import React,{useState} from 'react';
import {completeSection,reopenSection,undoCompletion,sectionStatus,completionProblems,sectionPanels} from './section-completion.js';
export default function SectionCompletion({project,current,commit,run,busy,onSelect}){
 const source=project.snapshots.find(s=>s.id===project.active),[chosen,setChosen]=useState('');
 if(!source)return null;
 const id=source.scenes.some(s=>s.id===chosen)?chosen:source.scenes[0]?.id;if(!id)return null;
 const status=sectionStatus(project,id),problems=completionProblems(project,id);
 function select(id){setChosen(id);const panel=sectionPanels(project,id)[0];onSelect?.(panel?.id);}
 return <section aria-label="セクションの完了管理"><h3>セクションの制作状態</h3><label>セクション<select value={id} onChange={e=>select(e.target.value)}>{source.scenes.map(s=><option key={s.id} value={s.id}>{s.title??s.id} · {sectionStatus(project,s.id)}</option>)}</select></label><strong className={status==='完了'?'section-complete':status==='要確認'?'section-review':''}>{status}</strong>
 {problems.length>0&&<p>{problems.join(' / ')}</p>}
 <button disabled={busy||!!problems.length||status==='完了'} onClick={()=>run('漫画化完了を保存',()=>commit(completeSection(current.current,id)))}>このセクションの漫画化を完了</button>
 <button disabled={busy||!['完了','要確認'].includes(status)} onClick={()=>run('編集を再開',()=>commit(reopenSection(current.current,id)))}>完了解除・編集再開</button>
 <button disabled={busy||!project.sectionCompletionUndo?.length} onClick={()=>run('完了承認を戻す',()=>commit(undoCompletion(current.current)))}>完了承認をUndo</button>
 <button onClick={()=>{const at=source.scenes.findIndex(s=>s.id===id),next=[...source.scenes.slice(at+1),...source.scenes.slice(0,at)].find(s=>sectionStatus(project,s.id)!=='完了');if(next)select(next.id);}}>次の未完了セクション</button></section>;
}
