import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import SceneViewport from '../../src/SceneViewport.jsx';
import {createScene} from '../../src/scene-model.js';

const hash='a'.repeat(64);
window.__TAURI_INTERNALS__={invoke:async command=>{if(command==='scene_asset_url')return '/fixture.glb';throw Error(command);},convertFileSrc:path=>path};
const assets=[{id:hash,hash,file:`${hash}.glb`,bytes:1024,kind:'prop',name:'triangle'}];
const scene={...createScene(),camera:{position:[0,1,4],target:[0,.5,0],fov:45},objects:[{id:'triangle',assetId:hash,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}]};
function Fixture(){
  const ref=useRef(),[open,setOpen]=useState(true);
  window.sceneActions={capture:()=>ref.current.capture({width:128,height:128}),close:()=>setOpen(false),open:()=>setOpen(true)};
  return <div style={{width:500,height:350}}>{open&&<SceneViewport ref={ref} scene={scene} assets={assets}/>}</div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
