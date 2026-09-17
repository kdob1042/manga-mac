import React, {useState} from 'react';
import {loadEditProposal,resolveEditProposal,executeLocalEdits} from './edit-commands.js';
import {pagePanels} from './layout.js';
import {pagePNG} from './render.js';

export default function EditProposals({project,current,commit,run,busy,onSelect}) {
  const [proof,setProof]=useState(null);
  const jobs=project.jobs.filter(j=>j.kind==='edit_proposal'&&j.status==='candidate');
  if(!jobs.length)return null;
  return <details className="edit-proposals"><summary>保存した編集候補（{jobs.length}件）</summary>
    {jobs.map(job=><div key={job.id}><span>{job.plan.reason}</span>
      <button disabled={busy} onClick={()=>run('編集候補を開く',async()=>{const c=await loadEditProposal(current.current,job.id);onSelect(c);setProof(null);})}>候補を開く</button>
      {job.plan.operations.every(op=>['lettering','crop','layout'].includes(op.kind))&&<button disabled={busy} onClick={()=>run('変更前後を比較',async()=>{const p=current.current,c=await loadEditProposal(p,job.id),next=executeLocalEdits(p,c);const render=async v=>{const pg=v.layout.pages.find(pg=>pg.id===c.context.pageId);return pagePNG(pagePanels(v,pg),v.snapshots,v.localizations,v.output_locale,pg,false,v.layout.imageCrops);};setProof({revision:p.revision,before:await render(p),after:await render(next)});})}>変更前後を比較</button>}
      <button disabled={busy} onClick={()=>run('候補を取り下げ',async()=>{await commit(resolveEditProposal(current.current,job.id,'abandoned'));setProof(null);})}>候補を取り下げ</button>
    </div>)}
    {proof&&proof.revision===project.revision&&<div className="proposal-comparison"><figure><figcaption>変更前</figcaption><img src={proof.before} alt="編集前のページ"/></figure><figure><figcaption>候補</figcaption><img src={proof.after} alt="編集候補のページ"/></figure></div>}
  </details>;
}
