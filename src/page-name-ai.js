import {buildPageEditContext,editNamePage} from '../contracts/name-plan/page.mjs';

// AI can suggest only typed operations on one page. IDs for additions are
// allocated by code once when the proposal is assembled and survive adoption.
export async function proposePageEdit(episode,pageId,instruction,ask) {
  if(!instruction?.trim())throw Error('修正する内容を入力してください');
  const context=buildPageEditContext(episode,pageId),basePage=structuredClone(context.page);
  const schema={type:'object',properties:{reason:{type:'string'},operations:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['updatePanel','updateText','insertPanel','removePanel','splitPanel','mergePanels','reorderPanels','setFrames']},panelId:{type:'string'},textId:{type:'string'},changes:{type:'object'},index:{type:'integer'},panel:{type:'object'},newPanel:{type:'object'},moveTextIds:{type:'array',items:{type:'string'}},otherPanelIds:{type:'array',items:{type:'string'}},panelIds:{type:'array',items:{type:'string'}},frames:{type:'object'}},required:['type'],additionalProperties:false}}},required:['reason','operations'],additionalProperties:false};
  const prompt=JSON.stringify({task:'指定ページだけの漫画ネーム修正。前後ページと共通シーンは読むだけ。原文・参考文を改変せず、操作の対象固定IDを指定。新しいコマのIDは書かない。ページを跨ぐ変更は禁止。',instruction,context});
  const raw=JSON.parse(await ask(prompt,schema));
  if(!Array.isArray(raw.operations)||raw.operations.length>16)throw Error('AI修正案の操作数が不正です');
  const operations=raw.operations.map(operation=>{
    const item=structuredClone(operation);
    if(item.type==='insertPanel'&&item.panel){item.panel={sceneId:null,sourceExcerptIds:[],contextExcerptIds:[],beatIds:[],characters:[],texts:[],prompt:'',frame:null,...item.panel,id:crypto.randomUUID()};}
    if(item.type==='splitPanel'){item.newPanel??={};item.newPanel.id=crypto.randomUUID();}
    return item;
  });
  const next=editNamePage(episode,pageId,operations);
  return {pageId,basePage,operations,afterPage:next.pages.find(page=>page.id===pageId),reason:raw.reason};
}
