// Panel motion plays in the home frame only. Overflow stills stay on the raster.
import { bounds, PAGE } from './layout.js';
import { panelArtRect } from './page-art.js';
import { motionStatus } from './panel-motion.js';
import { call, desktop } from './bridge.js';

export function pageClipPath(points) {
  return `polygon(${points.map(([x,y])=>`${x*100}% ${y*100}%`).join(',')})`;
}
export function tileClipPath(points) {
  const b=bounds(points);
  return `polygon(${points.map(([x,y])=>`${((x-b.x)/b.width)*100}% ${((y-b.y)/b.height)*100}%`).join(',')})`;
}
export function videoBox(slot,width,height,crop) {
  return panelArtRect(slot.points,width,height,crop);
}
export function videoPageStyle(box) {
  return {left:`${box.x/PAGE.width*100}%`,top:`${box.y/PAGE.height*100}%`,width:`${box.width/PAGE.width*100}%`,height:`${box.height/PAGE.height*100}%`};
}
export function videoRatio(ratio='960:960') {
  const [w,h]=String(ratio).split(':').map(Number);
  if (![w,h].every(n=>Number.isFinite(n)&&n>0)) throw Error('動画の寸法が不正です');
  return [w,h];
}
export async function motionSrc(project,panel) {
  const status=await motionStatus(project,panel);
  if (!['ready','update'].includes(status.state)||!status.revision) return null;
  const injected=globalThis.__MOTION_SRC__?.[status.revision.id];
  if (injected) return {src:injected,ratio:project.videoShots.find(s=>s.id===status.revision.shot_id)?.ratio??'960:960',revisionId:status.revision.id};
  if (!desktop()) return null;
  const {convertFileSrc}=await import('@tauri-apps/api/core');
  const response=await call('video_playback',{revisionId:status.revision.id});
  return {src:convertFileSrc(response.path),ratio:project.videoShots.find(s=>s.id===status.revision.shot_id)?.ratio??'960:960',revisionId:status.revision.id};
}
