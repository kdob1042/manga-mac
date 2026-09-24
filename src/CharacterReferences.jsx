import React from 'react';
import { imageHash } from './revisions.js';

export async function replaceCharacterImage(project, id, image) {
  const character = project.characters.find(c => c.id === id);
  if (!character) throw Error('画像の登録先となる人物IDがありません');
  const hash = await imageHash(image);
  return {...project,characters:project.characters.map(c=>c.id===id?{...c,image,hash,version:(c.version??0)+1}:c)};
}
export default function CharacterReferences({project,current,commit,run,busy}) {
  async function upload(id,file) {
    if(!file)return;
    await run('人物の参照画像を登録',async()=>{
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>20*1024*1024)throw Error('20MB以下のPNG/JPEG/WebPを選んでください');
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      await commit(await replaceCharacterImage(current.current,id,image));
    });
  }
  return <details><summary>人物の参照画像</summary><p>人物IDに画像を登録します。差し替えた画像は次の作画から使います。</p>
    {project.characters.map(c=><div key={c.id}><strong>{c.source?.character_id??c.id} · {c.name}</strong>
      {c.image?<img src={c.image} alt={c.name} style={{width:64,height:64,objectFit:'contain'}}/>:<p>参照画像がありません。この人物を描くコマの作画時に必要です。</p>}
      <label>{c.image?'画像を差し替える':'画像を登録'}<input aria-label={`${c.source?.character_id??c.id}の参照画像`} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';upload(c.id,file);}}/></label>
    </div>)}
  </details>;
}
