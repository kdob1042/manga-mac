// A saved scene belongs to one manga panel. Coordinates use metres, Y up, radians.
export const SCENE_VERSION = 1;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const vector = (value, length = 3) => Array.isArray(value) && value.length === length && value.every(n => Number.isFinite(n) && Math.abs(n) <= 10000);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
const fail = () => { throw Error('3Dシーンの形式または操作が不正です'); };
function validPose(pose){
  if(pose===undefined)return true;
  if(!exact(pose,['clip','time','bones']))return false;
  if(pose.clip!==undefined&&!id(pose.clip))return false;
  if(pose.time!==undefined&&(!Number.isFinite(pose.time)||pose.time<0||pose.time>3600))return false;
  if(pose.bones!==undefined&&(!plain(pose.bones)||Object.keys(pose.bones).length>120||Object.entries(pose.bones).some(([key,value])=>!id(key)||!vector(value))))return false;
  return true;
}

export function createScene() {
  return {schemaVersion:SCENE_VERSION,objects:[],camera:{position:[5,3,7],target:[0,1,0],fov:45},background:'#e9edf1'};
}

export function validateScene(scene, assetIds) {
  if (!exact(scene,['schemaVersion','objects','camera','background']) || scene.schemaVersion !== SCENE_VERSION || !Array.isArray(scene.objects) || scene.objects.length > 80 || !exact(scene.camera,['position','target','fov']) || !vector(scene.camera.position) || !vector(scene.camera.target) || scene.camera.position.every((n,i)=>n===scene.camera.target[i]) || !Number.isFinite(scene.camera.fov) || scene.camera.fov < 10 || scene.camera.fov > 120 || typeof scene.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(scene.background)) fail();
  const ids = new Set();
  for(const object of scene.objects){
    if(!exact(object,['id','assetId','position','rotation','scale','pose','contacts','airborne']) || !id(object.id) || ids.has(object.id) || !id(object.assetId) || (assetIds && !assetIds.has(object.assetId)) || !vector(object.position) || !vector(object.rotation) || !vector(object.scale) || object.scale.some(n=>n<=0 || n>100) || (object.airborne!==undefined && typeof object.airborne!=='boolean') || !validPose(object.pose)) fail();
    if(object.contacts!==undefined && (!Array.isArray(object.contacts) || object.contacts.length>16 || object.contacts.some(c=>
      !exact(c,['type','targetId','hand','side','offset','position']) || !['ball_attach','ground_snap','look_at','hand_target','foot_plant'].includes(c.type) ||
      (c.targetId!==undefined&&!id(c.targetId)) || (c.hand!==undefined&&!['left','right'].includes(c.hand)) ||
      (c.side!==undefined&&!['left','right'].includes(c.side)) || (c.offset!==undefined&&!vector(c.offset)) ||
      (c.position!==undefined&&!vector(c.position)) ||
      (['ball_attach','look_at','hand_target'].includes(c.type) && !c.targetId) ||
      (['hand_target','foot_plant'].includes(c.type) && !c.side) ||
      (c.type==='foot_plant' && !c.position) ||
      (c.type==='foot_plant' && object.airborne)))) fail();
    ids.add(object.id);
  }
  for(const object of scene.objects) for(const contact of object.contacts??[]) {
    if(contact.targetId && (!ids.has(contact.targetId)||contact.targetId===object.id)) fail();
    if(['ball_attach','hand_target'].includes(contact.type) && assetIds instanceof Map){
      const target=scene.objects.find(item=>item.id===contact.targetId);
      if(assetIds.get(target?.assetId)?.kind!=='prop')fail();
    }
  }
  return scene;
}

export function applySceneOperation(scene, operation, assetIds) {
  validateScene(scene,assetIds);
  if(!plain(operation)) fail();
  const existing = scene.objects.find(item=>item.id===operation.id);
  let next;
  switch(operation.type){
    case 'replace':
      if(!exact(operation,['type','scene']))fail();
      next=operation.scene;break;
    case 'add':
      if(!exact(operation,['type','object']) || !plain(operation.object) || scene.objects.some(item=>item.id===operation.object.id)) fail();
      next={...scene,objects:[...scene.objects,operation.object]}; break;
    case 'remove':
      if(!exact(operation,['type','id']) || !existing) fail();
      next={...scene,objects:scene.objects.filter(item=>item.id!==operation.id).map(item=>({...item,contacts:item.contacts?.filter(c=>c.targetId!==operation.id)}))}; break;
    case 'transform':
      if(!exact(operation,['type','id','position','rotation','scale']) || !existing || !['position','rotation','scale'].some(key=>key in operation)) fail();
      next={...scene,objects:scene.objects.map(item=>item.id===operation.id?{...item,...Object.fromEntries(['position','rotation','scale'].filter(key=>key in operation).map(key=>[key,operation[key]]))}:item)}; break;
    case 'pose':
      if(!exact(operation,['type','id','pose','contacts']) || !existing || !('pose' in operation||'contacts' in operation)) fail();
      next={...scene,objects:scene.objects.map(item=>item.id===operation.id?{...item,...Object.fromEntries(['pose','contacts'].filter(key=>key in operation).map(key=>[key,operation[key]]))}:item)}; break;
    case 'camera':
      if(!exact(operation,['type','camera']) || !plain(operation.camera)) fail();
      next={...scene,camera:{...scene.camera,...operation.camera}}; break;
    default: fail();
  }
  return validateScene(next,assetIds);
}

export function updatePanelScene(project,panelId,operation){
  const panel=project.panels.find(item=>item.id===panelId);
  if(!panel) throw Error('対象のコマがありません');
  const assetIds=new Map((project.sceneAssets??[]).map(asset=>[asset.id,asset]));
  const scene=applySceneOperation(panel.scene3d??createScene(),operation,assetIds);
  const panels=project.panels.map(item=>item.id===panelId?{...item,scene3d:scene}:item);
  return {...project,panels,history:[...project.history,{panels:project.panels,layout:project.layout,edit:true,after:{panels,layout:project.layout},label:'3D構図を編集'}],editRedo:[]};
}
