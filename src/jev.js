import { askLLM } from './llm.js';
export async function classifyEdit(config,instruction,context) {
  const value=JSON.parse(await askLLM(config,{purpose:'classify',schema:{type:'object'},prompt:JSON.stringify({instruction,selected:context.selected,panels:context.panels.map(p=>({id:p.id,number:p.number})),operations:context.operations})}));
  if(value.type!=='choice'||!Number.isFinite(value.confidence)||value.confidence<.75)throw Error('操作の判断が不確かです。対象と変更内容を具体的にしてください');
  return {choice:value.choice,confidence:value.confidence};
}
