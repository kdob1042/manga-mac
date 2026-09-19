import React,{useEffect,useRef,useState} from 'react';
import {pageClipPath,tileClipPath,videoBox,videoPageStyle,videoRatio} from './panel-video.js';

export default function PanelVideo({slot,crop,src,ratio,mode='page'}) {
  const [w,h]=videoRatio(ratio);
  const box=videoBox(slot,w,h,crop);
  if (mode==='tile') {
    return <div className="panel-video-tile" style={{clipPath:tileClipPath(slot.points)}}>
      <video data-testid={`panel-video-${slot.panelId}`} src={src} muted autoPlay loop playsInline preload="metadata" className="panel-video-clip-media" style={{objectFit:'cover'}}/>
    </div>;
  }
  return <div className="panel-video-page" data-testid={`page-video-${slot.panelId}`} style={{clipPath:pageClipPath(slot.points)}}>
    <video data-testid={`panel-video-${slot.panelId}`} src={src} muted autoPlay loop playsInline preload="metadata" className="panel-video-clip-media" style={videoPageStyle(box)}/>
  </div>;
}

export function VideoLightbox({src,onClose}) {
  const dialog=useRef(null);
  useEffect(()=>{dialog.current?.showModal();},[src]);
  return <dialog ref={dialog} className="panel-video-dialog" aria-label="動画の全体" onClose={onClose} onClick={e=>{if(e.target===dialog.current)onClose();}}>
    <form method="dialog"><button value="close">閉じる</button></form>
    <video data-testid="panel-video-full" src={src} controls playsInline preload="metadata" className="panel-video-full-media"/>
  </dialog>;
}

export function useMotionSources(project,panels) {
  const [sources,setSources]=useState({});
  const ids=(panels??[]).map(p=>p.id).join(',');
  useEffect(()=>{
    let stopped=false;
    const list=(panels??[]).filter(p=>p?.id);
    import('./panel-video.js').then(({motionSrc})=>Promise.all(list.map(async p=>{
      try {return [p.id,await motionSrc(project,p)];}
      catch {return [p.id,null];}
    }))).then(entries=>{if(!stopped)setSources(Object.fromEntries(entries));});
    return ()=>{stopped=true;};
  },[ids,project]);
  return sources;
}
