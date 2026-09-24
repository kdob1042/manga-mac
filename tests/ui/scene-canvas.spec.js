import {test,expect} from '@playwright/test';

function fixtureGlb() {
  const vertices=new Float32Array([0,1,0,-1,0,0,1,0,0]);
  const json={asset:{version:'2.0'},buffers:[{byteLength:vertices.byteLength}],bufferViews:[{buffer:0,byteOffset:0,byteLength:vertices.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-1,0,0],max:[1,1,0]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[1,.1,.1,1],metallicFactor:0,roughnessFactor:1},doubleSided:true}],
    meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0};
  const text=Buffer.from(JSON.stringify(json));
  const padded=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,32)]);
  const bin=Buffer.from(vertices.buffer);
  const glb=Buffer.alloc(12+8+padded.length+8+bin.length);
  glb.write('glTF',0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(padded.length,12);glb.write('JSON',16);padded.copy(glb,20);
  let offset=20+padded.length;glb.writeUInt32LE(bin.length,offset);glb.write('BIN\0',offset+4);bin.copy(glb,offset+8);
  return glb;
}

test('real WebGL canvas captures a loaded GLB, rejects lost context, and releases on close',async({page})=>{
  await page.route('**/fixture.glb',route=>route.fulfill({status:200,contentType:'model/gltf-binary',body:fixtureGlb()}));
  await page.goto('/tests/ui/scene-harness.html');
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect.poll(async()=>page.evaluate(async()=>{
    try{return (await window.sceneActions.capture()).startsWith('data:image/png;base64,');}catch{return false;}
  })).toBe(true);
  const pixels=await page.evaluate(async()=>{
    const image=new Image();image.src=await window.sceneActions.capture();await image.decode();
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    return {center:[...context.getImageData(64,64,1,1).data],corner:[...context.getImageData(0,0,1,1).data]};
  });
  expect(pixels.center).not.toEqual(pixels.corner);
  await page.locator('canvas').evaluate(canvas=>canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
  await expect(page.getByRole('alert')).toContainText('描画コンテキスト');
  expect(await page.evaluate(()=>window.sceneActions.capture().then(()=>null,error=>error.message))).toContain('描画コンテキスト');
  await page.evaluate(()=>window.sceneActions.close());
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.evaluate(()=>window.sceneActions.open());
  await expect(page.locator('canvas')).toHaveCount(1);
});
