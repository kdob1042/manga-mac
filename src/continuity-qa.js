import {imageHash} from './revisions.js';
import {nameReadToken} from './name-v2.js';
import {effectiveContinuity} from './continuity.js';

const schema={type:'object',additionalProperties:false,required:['findings'],properties:{findings:{type:'array',maxItems:6,items:{type:'object',additionalProperties:false,required:['severity','evidence','suggestion'],properties:{severity:{enum:['notice','warning']},evidence:{type:'string',minLength:1,maxLength:300},suggestion:{type:'string',minLength:1,maxLength:300}}}}}};

export async function runContinuityQA({project,panelId,imageCapable=false,ask}) {
  if(!imageCapable)throw Error('画像入力対応と送信許可が必要です');
  const panel=project.panels.find(p=>p.id===panelId),previous=project.panels.find(p=>p.id===effectiveContinuity(panel)?.previousPanelId);
  if(!panel?.image||!previous?.image||panel.sceneId!==previous.sceneId||project.panels.indexOf(previous)>=project.panels.indexOf(panel))throw Error('同じ場面の採用済み連続コマを選んでください');
  const [previousHash,panelHash]=await Promise.all([imageHash(previous.image),imageHash(panel.image)]);
  const base=await nameReadToken(project);
  const raw=await ask({purpose:'vision',images:[previous.image,panel.image],schema,prompt:JSON.stringify({task:'2枚の漫画コマ画像を読書順に比較し、衣装・持ち物・汗/傷・人物の位置/表情が不自然に飛んでいないか指摘する。原稿や描かれていない設定を推測して事実扱いしない。変更を実行せず、問題がなければfindings:[]を返す。',previousPanelId:previous.id,panelId:panel.id,expected:effectiveContinuity(panel),visualOnly:true})});
  const result=typeof raw==='string'?JSON.parse(raw):raw;
  if(!result||!Array.isArray(result.findings)||result.findings.length>6||result.findings.some(f=>!['notice','warning'].includes(f.severity)||typeof f.evidence!=='string'||!f.evidence.trim()||f.evidence.length>300||typeof f.suggestion!=='string'||!f.suggestion.trim()||f.suggestion.length>300))throw Error('画像間QAの応答が不正です');
  return {panelId,previousPanelId:previous.id,previousHash,panelHash,panelRevision:panel.artwork_revision??null,previousRevision:previous.artwork_revision??null,base,findings:result.findings.map(f=>({severity:f.severity,evidence:f.evidence,suggestion:f.suggestion})),humanAccepted:false,at:new Date().toISOString()};
}

export async function assertContinuityQACurrent(project,qa) {
  const panel=project.panels.find(p=>p.id===qa.panelId),previous=project.panels.find(p=>p.id===qa.previousPanelId);
  if(!panel?.image||!previous?.image||effectiveContinuity(panel)?.previousPanelId!==previous.id||panel.sceneId!==previous.sceneId||qa.base!==await nameReadToken(project)||qa.panelHash!==await imageHash(panel.image)||qa.previousHash!==await imageHash(previous.image))throw Error('画像間QA中にコマが変わりました');
}
