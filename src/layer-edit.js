import {beginJob,imageHash} from './revisions.js';
import {validateImageDimensions,validateImageReferences} from './media.js';

export function validateColourEdit(rect,colour) {
 if(!Array.isArray(rect)||rect.length!==4||rect.some(n=>!Number.isFinite(n)||n<0||n>1)||rect[2]<=0||rect[3]<=0||rect[0]+rect[2]>1||rect[1]+rect[3]>1||!/^#[0-9a-f]{6}$/i.test(colour))throw Error('色と編集範囲を指定してください');
}
export async function colourRequest(project,panel,sessionId,capture,characterId,rect,colour,modelId) {
 validateColourEdit(rect,colour);
 const {width,height}=capture.state,model=validateImageDimensions(modelId,width,height);
 if(!model.operations.includes('edit')||!model.capabilities.multi_reference)throw Error('人物参照と文脈の編集に対応するモデルが必要です');
 const character=project.characters.find(c=>c.id===characterId);
 if(!character?.image||!character.hash||!panel.characterIds.includes(characterId))throw Error('対象人物の正本画像とレイヤー対応を確認してください');
 if(await imageHash(character.image)!==character.hash)throw Error('人物参照のhashが一致しません');
 const refs=[{id:'context',name:'Panel context (no lettering)',role:'context',image:capture.context,hash:await imageHash(capture.context)},
  {id:character.id,name:character.name,role:'character',image:character.image,hash:character.hash}];
 validateImageReferences(modelId,refs);
 const job=await beginJob(project,panel,'layer_edit',modelId),targetHash=await imageHash(capture.target);
 job.layer_edit={preset:'colour-only',colour,rect:[...rect],width,height,character_id:characterId,target_hash:targetHash,
  source:{session:sessionId,instance:capture.state.instance,document:capture.state.document,revision:capture.state.revision,layer:capture.layer},
  references:refs.map(({image,...r})=>r),runtime:structuredClone(model.runtime)};
 job.compositor={session_id:sessionId,bindings:{[capture.layer]:characterId}};
 job.recovery={panel:{...structuredClone(panel),layer_edit:structuredClone(job.layer_edit)}};
 const seed=crypto.getRandomValues(new Uint32Array(1))[0];
 const request={job:{id:job.id,input_hash:job.input_hash,base_revision:job.base_revision,source_revision:job.source_revision,scope:job.scope},media:job.media,
  prompt:`Local colour-only edit. Change the selected subject's colour toward ${colour} inside normalized rectangle ${JSON.stringify(rect)}. Keep the same pose, orientation, silhouette, identity and composition. Input canvas is the target layer. Reference 1 is panel context; reference 2 is the character identity. No text.`,
  original:capture.target,original_hash:targetHash,references:refs,width,height,seed,steps:model.input.steps};
 request.recovery={version:1,kind:'layer_edit',panel:{...job.recovery.panel,image:null,generation:{width,height,seed}},layer_edit:job.layer_edit,target:{image:capture.target}};
 return {job,request};
}
export async function completeColourEdit(job,receipt) {
 if(receipt.job_id!==job.id||receipt.input_hash!==job.input_hash||receipt.context?.kind!=='layer_edit'||receipt.context.layer_edit.target_hash!==job.layer_edit.target_hash||receipt.hash!==await imageHash(receipt.image)||await imageHash(receipt.context.target.image)!==job.layer_edit.target_hash)throw Error('レイヤー編集結果と保存済み要求が一致しません');
 if(receipt.colour_composited!==true)throw Error('透過画素を保護したnative編集結果が必要です');
 return receipt.image;
}

export function planLayerMove(project,job,state,instruction) {
 const match=instruction.trim().match(/^(.+?)を(少し)?(左|右|上|下)へ(?:動かして|移動して|移動)?[。]?$/);
 if(!match)throw Error('レイヤー編集中は「人物名を少し左へ」などの移動、または局所色変更を使ってください。向き・ポーズ変更は未対応です');
 if(state.owner!=='app'||job.status!=='running')throw Error('編集状態を確認し、操作権をアプリに戻してください');
 const panel=project.panels.find(p=>p.id===job.panelId),people=project.characters.filter(c=>c.name===match[1]&&panel?.characterIds.includes(c.id));
 const layers=state.layers.filter(l=>l.raster&&!l.parent&&l.visible&&job.compositor.bindings[l.id]===people[0]?.id);
 if(people.length!==1||layers.length!==1)throw Error('人物と対象レイヤーの対応を一つに確定してください');
 const layer=layers[0],horizontal=['左','右'].includes(match[3]),delta=Math.max(1,Math.round((horizontal?state.width:state.height)*(match[2]?.025:.1)))*(['左','上'].includes(match[3])?-1:1);
 return {layer:layer.id,x:layer.x+(horizontal?delta:0),y:layer.y+(horizontal?0:delta),width:layer.width,height:layer.height,rotation:layer.rotation,visible:layer.visible};
}
