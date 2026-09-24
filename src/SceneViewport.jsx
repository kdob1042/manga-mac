import React, {forwardRef, useEffect, useImperativeHandle, useRef, useState} from 'react';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {resolveSceneAsset} from './scene-assets.js';
import {applyActorPose, inspectRig, resolveSceneContacts} from './scene-pose.js';

// GLB resolution is performed only when the shot workspace is opened. Each
// rebuild disposes the old render graph and the renderer is never kept hidden.
const SceneViewport=forwardRef(function SceneViewport({scene,assets=[],onCamera,onRigInfo},ref){
  const host=useRef(null), runtime=useRef(null), callback=useRef(onCamera),rigCallback=useRef(onRigInfo), [error,setError]=useState('');
  callback.current=onCamera;
  rigCallback.current=onRigInfo;
  useImperativeHandle(ref,()=>({capture:async({width=768,height=768}={})=>{
    const state=runtime.current;
    if(!state || state.loading) throw Error('3D素材の読み込みが完了していません');
    if(state.error) throw Error(state.error);
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>4096||height>4096)throw Error('撮影サイズは64〜4096pxです');
    const {renderer,camera,world}=state,oldSize=new THREE.Vector2(),oldRatio=renderer.getPixelRatio();
    renderer.getSize(oldSize);
    try{renderer.setPixelRatio(1);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();renderer.render(world,camera);return renderer.domElement.toDataURL('image/png');}
    finally{renderer.setPixelRatio(oldRatio);renderer.setSize(oldSize.x,oldSize.y,false);camera.aspect=oldSize.x/oldSize.y;camera.updateProjectionMatrix();renderer.render(world,camera);}
  }}),[]);
  useEffect(()=>{
    if(!host.current)return;
    const container=host.current,world=new THREE.Scene();world.background=new THREE.Color(scene.background);
    const camera=new THREE.PerspectiveCamera(scene.camera.fov,1,.01,5000);
    camera.position.fromArray(scene.camera.position);camera.lookAt(...scene.camera.target);
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.setSize(Math.max(container.clientWidth,320),Math.max(container.clientHeight,260));
    container.appendChild(renderer.domElement);
    const controls=new OrbitControls(camera,renderer.domElement);
    controls.target.fromArray(scene.camera.target);controls.update();
    const ambient=new THREE.HemisphereLight(0xffffff,0x9da6b2,2.1);world.add(ambient);
    const sunlight=new THREE.DirectionalLight(0xffffff,2.5);sunlight.position.set(4,9,5);world.add(sunlight);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0xd5d9dd,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.008;world.add(floor);
    const instances=new Map(),loading={renderer,camera,world,loading:true,error:null}; runtime.current=loading;
    rigCallback.current?.({});
    let disposed=false;
    const resize=()=>{if(disposed)return;renderer.setSize(Math.max(container.clientWidth,320),Math.max(container.clientHeight,260));camera.aspect=renderer.domElement.width/renderer.domElement.height;camera.updateProjectionMatrix();};
    const render=()=>{if(!disposed && !document.hidden)renderer.render(world,camera);};
    const observer=new ResizeObserver(()=>{resize();render();});observer.observe(container);
    controls.addEventListener('change',render);
    document.addEventListener('visibilitychange',render);
    render();
    const stop=()=>{if(disposed||!callback.current)return;const position=camera.position.toArray(),target=controls.target.toArray();
      if(JSON.stringify([position,target])!==JSON.stringify([scene.camera.position,scene.camera.target]))callback.current({position,target,fov:camera.fov});
    };controls.addEventListener('end',stop);
    const loader=new GLTFLoader();
    const info={};
    Promise.all(scene.objects.map(async object=>{
      const asset=assets.find(item=>item.id===object.assetId);
      if(!asset)throw Error(`素材が見つかりません: ${object.assetId}`);
      const url=await resolveSceneAsset(asset);
      const gltf=await loader.loadAsync(url);
      if(disposed){gltf.scene.traverse(node=>{node.geometry?.dispose();});return;}
      const instance=gltf.scene;
      info[object.id]=inspectRig(instance,gltf.animations);
      rigCallback.current?.({...info});
      instance.position.fromArray(object.position);instance.rotation.fromArray(object.rotation);instance.scale.fromArray(object.scale);
      const result=applyActorPose(instance,object,gltf.animations);
      if(object.pose && !result.applied)throw Error(`ポーズを適用できません (${object.id}: ${result.reason})`);
      world.add(instance);instances.set(object.id,instance);
    })).then(()=>{
      if(disposed)return;
      const diagnostics=resolveSceneContacts(instances,scene.objects);
      const failed=diagnostics.find(result=>!result.applied);
      if(failed)throw Error(`接触位置を解決できません (${failed.id}: ${failed.reason})`);
      loading.loading=false;setError('');rigCallback.current?.(info);render();
    }).catch(e=>{if(disposed)return;loading.error=e.message??String(e);loading.loading=false;setError(loading.error);});
    return ()=>{disposed=true;observer.disconnect();controls.removeEventListener('end',stop);controls.removeEventListener('change',render);document.removeEventListener('visibilitychange',render);controls.dispose();runtime.current=null;
      world.traverse(node=>{node.geometry?.dispose();if(node.material){for(const material of (Array.isArray(node.material)?node.material:[node.material])){for(const value of Object.values(material))if(value?.isTexture)value.dispose();material.dispose();}}});
      renderer.dispose();renderer.domElement.remove();};
  },[scene,assets]);
  return <div className="scene-viewport" role="img" aria-label="3D構図のプレビュー" ref={host}>{error&&<p role="alert" className="scene-viewport-error">{error}</p>}</div>;
});
export default SceneViewport;
