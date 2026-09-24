import test from 'node:test';
import assert from 'node:assert/strict';
import { setupBasketballScene } from '../src/scene-pose-setup.js';

test('basketball setup reuses matching players, preserves the court and resets airborne on the next ground moment', () => {
  const court = {id:'court',assetId:'court',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
  const first={schemaVersion:1,camera:{position:[5,3,7],target:[0,1,0],fov:45},background:'#eeeeee',objects:[court]};
  let serial=0;
  const ids=()=>`new-${++serial}`;
  const airborne=setupBasketballScene(first,{moment:'layup',offenseAssetId:'player',defenseAssetId:'player',ballAssetId:'ball'},ids);
  assert.equal(airborne.objects.length,4);
  assert.deepEqual(airborne.objects[0],court);
  assert.deepEqual(airborne.objects.slice(1,3).map(o=>o.assetId),['player','player']);
  assert.equal(airborne.objects[1].airborne,true);
  assert.deepEqual(airborne.objects[1].contacts,[{type:'ball_attach',targetId:'new-3',hand:'right'}]);
  assert.deepEqual(first.objects,[court]);
  const grounded=setupBasketballScene(airborne,{moment:'dribble',offenseAssetId:'player',defenseAssetId:'player',ballAssetId:'ball'},ids);
  assert.equal(serial,3);
  assert.equal(grounded.objects.length,4);
  assert.equal(grounded.objects[1].airborne,undefined);
  assert.deepEqual(grounded.objects[1].contacts,[{type:'ground_snap'}]);
  assert.deepEqual(grounded.objects[3].position,[0.75,0.45,-0.1]);
});

test('basketball setup requires all three assets and makes distinct instances when both players share an asset', () => {
  const scene={objects:[],camera:{position:[5,3,7],target:[0,1,0],fov:45},schemaVersion:1,background:'#ffffff'};
  assert.throws(()=>setupBasketballScene(scene,{moment:'dribble',offenseAssetId:'p',defenseAssetId:'p',ballAssetId:''}),/素材/);
  assert.throws(()=>setupBasketballScene(scene,{moment:'dribble',offenseAssetId:'p',defenseAssetId:'p',ballAssetId:'b'},()=> 'same'),/重複/);
});
