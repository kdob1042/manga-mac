import { validate, VERSION } from '../vendor/live-manga/contracts/validate.mjs';
import { pageLayers, panelLayout, imageOf } from './render';
import { imageHash } from './revisions';
import { motionStatus } from './panel-motion';
import { textForPanel } from './localization';
import { call } from './bridge';
// The caller freezes a project snapshot before the first asynchronous operation.
export async function prepareLiveManga(project, probeVideo) {
 if(!project.panels.length)throw Error('書き出すコマがありません');
 const assets=new Map(),sources={};
 async function image(data) {const hash=await imageHash(data),im=await imageOf(data),mime=data.slice(5,data.indexOf(';')),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];const a={id:hash,path:`assets/${hash}.${ext}`,sha256:hash,mime,bytes:atob(data.split(',')[1]).length,width:im.width,height:im.height};assets.set(hash,a);sources[hash]={image:data};return hash;}
 const pages=[];
 for(let offset=0;offset<project.panels.length;offset+=4) {
  const panels=project.panels.slice(offset,offset+4),page={id:`page-${offset/4+1}`,width:1600,height:2260,panels:[]};
  for(const [name,layer] of [['art','art'],['overlay','overlay'],['fallback','complete']])page[name]=await image(await pageLayers(panels,project.snapshots,project.localizations,project.output_locale,layer));
  for(const [i,p] of panels.entries()) {
   const im=await imageOf(p.image),snapshot=project.snapshots.find(s=>s.id===p.snapshotId),localization=project.output_locale==='en'?project.localizations.find(l=>l.snapshot_id===p.snapshotId&&l.locale==='en'):null;
   const panel={id:p.id,...panelLayout(i,im.width,im.height),poster:await image(p.image),text:textForPanel(p,snapshot,localization)};
   const status=await motionStatus(project,p);if(status.state==='stale')throw Error(`コマ ${offset+i+1}: ${status.message}。動画の変更または割当解除が必要です`);
   if(status.revision) {
    const v=status.revision,meta=await probeVideo(v.id),a={id:v.artifact.hash,path:`assets/${v.artifact.hash}.mp4`,sha256:v.artifact.hash,mime:'video/mp4',bytes:v.artifact.size,...meta};
    assets.set(a.id,a);sources[a.id]={videoRevision:v.id};panel.motion={asset:a.id,end:'poster'};
   }
   page.panels.push(panel);
  }
  pages.push(page);
 }
 const manifest=validate({format:'live-manga',schemaVersion:VERSION,releaseId:crypto.randomUUID(),workId:project.id??'manga',episodeId:'publication',title:project.title||'漫画',language:project.output_locale??'ja',pages,assets:[...assets.values()]});
 return {manifest,sources,projectRevision:project.revision};
}
export async function exportLiveManga(project) {
 const prepared=await prepareLiveManga(project,revisionId=>call('live_video_probe',{revisionId}));
 return call('live_export',{request:prepared});
}
