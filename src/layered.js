import {compositorRevision} from './compositor.js';
import {beginJob,imageHash} from './revisions.js';
import {imageExecution,validateImageDimensions} from './media.js';

const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

export async function layeredRequest(project,panel,modelId,count,width,height,seed=0) {
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('seedが範囲外です');
 const model=validateImageDimensions(modelId,width,height);
 if(!model.operations.includes('decompose')||model.output?.kind!=='ordered-rgba-layers')throw Error('レイヤー分解に対応したモデルを選択してください');
 if(!Number.isInteger(count)||count<model.input.min_layers||count>model.input.max_layers)throw Error('レイヤー数が対応範囲外です');
 if(!panel.image?.startsWith('data:image/png;base64,'))throw Error('PNG原画が必要です');
 const header=Uint8Array.from(atob(panel.image.split(',')[1]),c=>c.charCodeAt(0));
 const view=new DataView(header.buffer);
 if(header.length<33||view.getUint32(16)!==width||view.getUint32(20)!==height)throw Error('分解は原画と同じ寸法で実行してください。対応寸法の原画が必要です');
 const job=await beginJob(project,panel,'decompose',modelId);
 job.layered={layer_count:count,width,height,seed,runtime:structuredClone(model.runtime),output:structuredClone(model.output)};
 const originalHash=await imageHash(panel.image);
 job.recovery={panel:{...structuredClone(panel),decomposition:{...structuredClone(job.layered),media:job.media,source_hash:originalHash,source_revision:panel.artwork_revision}}};
 job.compositor={upstream_revision:compositorRevision,bindings:{}};
 const recovery={version:1,kind:'decompose',panel:{...structuredClone(panel),image:null,generation:{width,height,seed}},original:panel.image,original_hash:originalHash,layered:job.layered};
 return {job,request:{job:{id:job.id,input_hash:job.input_hash,base_revision:job.base_revision,source_revision:job.source_revision,scope:job.scope},media:imageExecution(modelId),
  prompt:'Decompose the input image into independently editable RGBA layers. Preserve the artwork.',original:panel.image,original_hash:originalHash,references:[],width,height,seed,steps:model.input.steps,layer_count:count,recovery}};
}

export async function layersToBundle(job,receipt) {
 if(receipt?.kind!=='ordered-rgba-layers'||receipt.job_id!==job.id||receipt.input_hash!==job.input_hash||receipt.context?.kind!=='decompose'||receipt.context.panel.id!==job.panelId||receipt.context.panel.snapshotId!==job.source_revision||canonical(receipt.context.layered)!==canonical(job.layered)||receipt.layers?.length!==job.layered.layer_count)throw Error('レイヤー結果と保存済み要求が一致しません');
 const {width,height}=job.layered, context=receipt.context;
 if(await imageHash(context.original)!==context.original_hash)throw Error('分解元の原画が一致しません');
 const documentID=crypto.randomUUID().toUpperCase(), layers=[], images={};
 function add(image,name,visible){const id=crypto.randomUUID().toUpperCase();layers.push({id,name,isVisible:visible,transform:{origin:[0,0],size:[width,height],rotation:0,flipX:false,flipY:false,sampling:'High quality'},imageFile:`${id}.png`});images[`${id}.png`]={image};}
 add(context.original,'原画（比較用・非表示）',false);
 for(const [index,layer] of receipt.layers.entries()){
  if(layer.index!==index||layer.hash!==await imageHash(layer.image))throw Error('レイヤーの順序またはhashが一致しません');
  const bytes=Uint8Array.from(atob(layer.image.split(',')[1]),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
  if(bytes.length<33||view.getUint32(16)!==width||view.getUint32(20)!==height||bytes[24]!==8||bytes[25]!==6)throw Error('同寸法の8-bit RGBAレイヤーが必要です');
  add(layer.image,`分解レイヤー ${index+1}（人物未確認）`,true);
 }
 return {manifest:{format:'com.compositor.project',version:8,colorSpace:'sRGB',documentID,width,height,activeLayerID:layers.at(-1).id,layers},images};
}
