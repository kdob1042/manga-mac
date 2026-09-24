import {PAGE_FORMAT,validateEpisode} from '../contracts/name-plan/page.mjs';
import {textForRefs} from './source-refs.js';
import {effectiveContinuity} from './continuity.js';
import {commitNameEpisode} from './page-name.js';

// Migrate the saved, hand-edited state once. The old candidate file is only a
// source for intentions and beats; it never overwrites live panels or geometry.
export function migrateSavedName(project,episodeId) {
  if(!project.layout?.pages?.length||!project.panels?.length)throw Error('移行する保存済みのコマがありません');
  const source=project.snapshots?.find(snapshot=>snapshot.id===project.active);
  const workId=project.workId??source?.workId??project.namePlan?.file?.source?.workId;
  if(!workId||!episodeId)throw Error('作品と話の固定IDを指定してください');
  const original=project.namePlan?.file?.plan;
  const known=new Set(project.panels.map(panel=>panel.id));
  const savedPages=project.layout.pages.map(page=>({...page,slots:[...page.slots]}));
  const owner=new Map();
  for(const page of savedPages)for(const slot of page.slots)if(slot.panelId){
    if(!known.has(slot.panelId)||owner.has(slot.panelId))throw Error('移行するコマの所属が不明または重複しています');
    owner.set(slot.panelId,page.id);
  }
  const previous=project.namePlan?.compiledLayout?.pages??[];
  for(const panel of project.panels)if(!owner.has(panel.id)){
    const candidates=previous.filter(page=>page.slots?.some(slot=>slot.panelId===panel.id));
    if(candidates.length!==1||!savedPages.some(page=>page.id===candidates[0].id))throw Error(`未配置コマ ${panel.id} のページを指定してから移行してください`);
    owner.set(panel.id,candidates[0].id);
  }
  const scenes=[...new Set(project.panels.map(panel=>panel.sceneId).filter(Boolean))].map(id=>{
    const sourceScene=source?.scenes?.find(scene=>scene.id===id);
    return {id,label:sourceScene?.title??id,location:'',timeOfDay:'',props:[],spatial:'',hardConstraints:[],appearances:[]};
  });
  const appearanceIds=new Map();
  const characters=[...new Set(project.panels.flatMap(panel=>panel.characterIds??[]))].map(id=>{
    const person=project.characters.find(character=>character.id===id);
    if(!person)throw Error(`人物 ${id} の保存データがありません`);
    return {id,name:person.name??id,description:person.description??''};
  });
  const beats=original?.beats??[];
  const pages=savedPages.map((page,pageIndex)=>{
    const sourceExcerpts=[],contextExcerpts=[];
    const makeExcerpts=(refs,panelId,kind)=>refs.map((ref,index)=>{
      const id=`excerpt:${panelId}:${kind}:${index}`,text=textForRefs([ref],project.snapshots);
      if(!text)throw Error(`コマ ${panelId} の原文を保存済み資料から特定できません`);
      const entry={id,text,origin:structuredClone(ref)};
      (kind==='source'?sourceExcerpts:contextExcerpts).push(entry);
      return id;
    });
    const placed=page.slots.filter(slot=>slot.panelId).map(slot=>slot.panelId);
    const ordered=[...placed,...project.panels.filter(panel=>owner.get(panel.id)===page.id&&!placed.includes(panel.id)).map(panel=>panel.id)];
    const panels=ordered.map(panelId=>project.panels.find(panel=>panel.id===panelId)).map(panel=>{
      const slot=page.slots.find(item=>item.panelId===panel.id);
      const continuity=effectiveContinuity(panel);
      const appearanceScene=scenes.find(scene=>scene.id===panel.sceneId);
      const people=(panel.characterIds??[]).map(characterId=>{
        const state=continuity?.characters?.find(person=>person.id===characterId)??{};
        const costume=state.costume?.trim()??'';
        let appearanceId=null;
        if(costume&&appearanceScene){
          const key=JSON.stringify([panel.sceneId,characterId,costume]);
          if(!appearanceIds.has(key)){
            appearanceId=`appearance:${appearanceScene.id}:${characterId}:${appearanceScene.appearances.length+1}`;
            appearanceScene.appearances.push({id:appearanceId,characterId,label:costume,costume,visualState:''});
            appearanceIds.set(key,appearanceId);
          }else appearanceId=appearanceIds.get(key);
        }
        return {characterId,appearanceId,visualState:state.visualState??'',emotion:state.emotion??'',holding:state.holding??[]};
      });
      const texts=(panel.lettering?.boxes??[]).map((box,index)=>{
        const content=typeof box.text==='string'?box.text:textForRefs(box.sourceRefs??[],project.snapshots);
        if(!content)return null;
        const id=`text:${panel.id}:${index}`;
        return {id,kind:box.kind??'dialogue',speakerId:null,text:content,box:{x:box.x,y:box.y,width:box.width,height:box.height},style:Object.fromEntries(['shape','fontSize','lineHeight','padding','tail','writingMode','fontFamily'].filter(key=>box[key]!==undefined).map(key=>[key,structuredClone(box[key])]))};
      }).filter(Boolean);
      const sourceExcerptIds=makeExcerpts(panel.sourceRefs??[],panel.id,'source'),contextExcerptIds=makeExcerpts(panel.contextRefs??[],panel.id,'context');
      const old=original?.panels?.find(item=>item.id===panel.id);
      return {id:panel.id,sceneId:panel.sceneId??null,sourceExcerptIds,contextExcerptIds,beatIds:old?.beatIds??[],characters:people,
        prompt:panel.prompt??'',shotIntent:panel.nameIntent??old?.shotIntent??'',protect:old?.protect??[],gaze:old?.gaze??'neutral',
        previousPanelId:continuity?.previousPanelId??null,texts,
        frame:slot?{points:structuredClone(slot.points),slotId:slot.id,...(slot.overflow?{overflow:structuredClone(slot.overflow)}:{})}:null};
    });
    const old=original?.pages?.[pageIndex];
    return {id:page.id,purpose:old?.purpose??'',entryBeatId:old?.entryBeatId??null,exit:old?.exit??null,
      sourceExcerpts,contextExcerpts,boundaryContext:{before:null,after:null},panels,
      emptyFrames:page.slots.filter(slot=>slot.panelId===null).map(({panelId,...frame})=>structuredClone(frame))};
  });
  const episode=validateEpisode({format:PAGE_FORMAT,workId,episodeId,title:project.title??'ネーム',readingDirection:'rtl',
    characters,workGoal:original?.workGoal??null,beats,scenes,boundaryContext:{before:null,after:null},pageIds:pages.map(page=>page.id),pages});
  return commitNameEpisode(project,episode,'旧保存からページネームへ移行');
}
