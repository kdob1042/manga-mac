import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationClip, Bone, Group, Mesh, BoxGeometry, MeshBasicMaterial, QuaternionKeyframeTrack, SkinnedMesh, Skeleton, Vector3 } from 'three';
import { applyActorPose, basketballMoment, inspectRig, resolveSceneContacts } from '../src/scene-pose.js';

function rig() {
  const root = new Group();
  const make = (name, parent, x, y) => { const bone = new Bone(); bone.name = `mixamorig${name}`; bone.position.set(x,y,0); parent.add(bone); return bone; };
  const hips = make('Hips',root,0,1);
  for (const [side,sign] of [['Left',-1],['Right',1]]) {
    const arm = make(`${side}Arm`,hips,sign*.3,.6);
    const forearm = make(`${side}ForeArm`,arm,sign*.2,-.2);
    make(`${side}Hand`,forearm,0,-.2);
    const leg = make(`${side}UpLeg`,hips,sign*.1,-.45);
    const shin = make(`${side}Leg`,leg,0,-.4);
    make(`${side}Foot`,shin,0,-.15);
  }
  const mesh = new SkinnedMesh(new BoxGeometry(),new MeshBasicMaterial());
  const bones = [];hips.traverse(node=>{if(node.isBone)bones.push(node);});
  root.add(mesh);mesh.bind(new Skeleton(bones));
  return root;
}

test('rig inspection rejects a displayable mesh and reports usable semantic limbs and clips', () => {
  const mesh = new Group(); mesh.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  assert.equal(inspectRig(mesh).supported, false);
  const root = rig();
  const matching = new AnimationClip('jump', 1, [new QuaternionKeyframeTrack('mixamorigRightArm.quaternion', [0, 1], [0, 0, 0, 1, 0.707, 0, 0, 0.707])]);
  const wrong = new AnimationClip('not-this-rig', 1, [new QuaternionKeyframeTrack('Alien.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
  assert.deepEqual(inspectRig(root, [matching, wrong]).clipNames, ['jump']);
  assert.equal(inspectRig(root).supported, true);
  const duplicate = new Bone(); duplicate.name = 'RightHand'; root.add(duplicate);
  assert.deepEqual(inspectRig(root).ambiguous, ['rightHand']);
});

test('partial rigs never claim a pose or contact succeeded even if the requested hand is present', () => {
  const root = rig(), leg = root.getObjectByName('mixamorigLeftLeg');
  leg.parent.remove(leg);
  const before = root.getObjectByName('mixamorigRightHand').quaternion.clone();
  const pose = applyActorPose(root,{pose:{bones:{rightHand:[0.5,0,0]}}});
  assert.equal(pose.applied,false);
  assert.equal(pose.reason,'incompatible_rig');
  assert.ok(before.equals(root.getObjectByName('mixamorigRightHand').quaternion));
  const scene = new Group(), ball = new Group(); scene.add(root,ball);
  const result = resolveSceneContacts(new Map([['actor',root],['ball',ball]]),[{id:'actor',contacts:[{type:'ball_attach',targetId:'ball'}]}]);
  assert.equal(result[0].reason,'incompatible_rig');
});

test('pose sampling is repeatable and invalid clips or bones cannot partially change the skeleton', () => {
  const root = rig();
  const arm = root.getObjectByName('mixamorigRightArm');
  const clip = new AnimationClip('shoot', 1, [new QuaternionKeyframeTrack('mixamorigRightArm.quaternion', [0, 1], [0, 0, 0, 1, 0.7071068, 0, 0, 0.7071068])]);
  assert.equal(applyActorPose(root, { pose: { clip: 'shoot', time: 1 } }, [clip]).applied, true);
  assert.ok(Math.abs(arm.quaternion.x) > 0.6);
  const old = arm.quaternion.clone();
  assert.equal(applyActorPose(root, { pose: { clip: 'unknown' } }, [clip]).reason, 'unavailable_clip');
  assert.ok(old.equals(arm.quaternion));
  assert.equal(applyActorPose(root, { pose: { bones: { rightHand: [0, 0, 0.4] } } }, [clip]).applied, true);
  const first = root.getObjectByName('mixamorigRightHand').quaternion.clone();
  assert.equal(applyActorPose(root, { pose: { bones: { rightHand: [0, 0, 0.4] } } }, [clip]).applied, true);
  assert.ok(first.equals(root.getObjectByName('mixamorigRightHand').quaternion));
  assert.equal(arm.quaternion.x, 0);
});

test('ball follows only the hand; floor snap skips airborne actor and duplicate attachment fails', () => {
  const scene = new Group(), player = rig(), other = rig(), ball = new Group();
  scene.add(player, other, ball);
  player.position.set(1, 2, 0); other.position.set(3, 2, 0);
  const actors = [
    { id: 'a', contacts: [{ type: 'ground_snap' }, { type: 'ball_attach', targetId: 'ball', hand: 'right', offset: [0, 0, 0] }] },
    { id: 'b', airborne: true, contacts: [{ type: 'ground_snap' }, { type: 'ball_attach', targetId: 'ball' }] },
  ];
  const result = resolveSceneContacts(new Map([['a', player], ['b', other], ['ball', ball]]), actors);
  assert.ok(Math.abs(player.position.y) < 1e-8);
  assert.equal(other.position.y, 2);
  assert.deepEqual(ball.position.toArray().map(n => Number(n.toFixed(4))), [1.5, 1.2, 0]);
  assert.equal(result.at(-1).reason, 'unavailable_target');
  assert.equal(result[2].reason, 'airborne');
});

test('basketball presets distinguish a dribble from a held ball and airborne moments', () => {
  const dribble = basketballMoment('dribble');
  assert.equal(dribble.actors[0].contacts.some(c => c.type === 'ball_attach'), false);
  assert.equal(basketballMoment('layup').actors[0].airborne, true);
  assert.equal(basketballMoment('block', { ballId: 'b1' }).actors[0].contacts[0].targetId, 'b1');
  assert.throws(() => basketballMoment('football'), /Unknown/);
});

test('look-at rotates the actor toward a target without moving either object', () => {
  const scene = new Group(), actor = rig(), target = new Group();
  scene.add(actor, target);
  target.position.x = 3;
  assert.deepEqual(resolveSceneContacts(new Map([['actor', actor], ['target', target]]),
    [{ id: 'actor', contacts: [{ type: 'look_at', targetId: 'target' }] }]),
  [{ id: 'actor', type: 'look_at', applied: true }]);
  assert.ok(Math.abs(actor.rotation.y - Math.PI / 2) < 1e-8);
  assert.deepEqual(actor.position.toArray(), [0, 0, 0]);
  assert.deepEqual(target.position.toArray(), [3, 0, 0]);
});

test('bone names without a bound, connected skeleton cannot claim an acting rig', () => {
  const root = rig();
  root.children.find(node=>node.isSkinnedMesh).removeFromParent();
  assert.equal(inspectRig(root).reason,'unbound_skeleton');
  const bound = rig(), elbow = bound.getObjectByName('mixamorigRightForeArm');
  bound.add(elbow);
  assert.equal(inspectRig(bound).reason,'invalid_joint_chain');
});

test('a second hand reaches a stationary ball and an impossible target restores its last pose', () => {
  const scene = new Group(), actor = rig(), ball = new Group();scene.add(actor,ball);
  ball.position.set(0,1.2,0);
  const hand = actor.getObjectByName('mixamorigLeftHand');
  const contact = {type:'hand_target',targetId:'ball',side:'left'};
  const result = resolveSceneContacts(new Map([['actor',actor],['ball',ball]]),[{id:'actor',contacts:[contact]}]);
  assert.equal(result[0].applied,true);
  assert.ok(hand.getWorldPosition(ball.position.clone()).distanceTo(ball.position) < .035);
  const pose = actor.getObjectByName('mixamorigLeftArm').quaternion.clone();
  ball.position.set(5,5,0);
  assert.equal(resolveSceneContacts(new Map([['actor',actor],['ball',ball]]),[{id:'actor',contacts:[contact]}])[0].reason,'unreachable');
  assert.ok(actor.getObjectByName('mixamorigLeftArm').quaternion.equals(pose));
});

test('one-way hand attachment and opposite-hand target do not move the ball twice', () => {
  const scene = new Group(), actor = rig(), ball = new Group();scene.add(actor,ball);
  const contacts = [{type:'ball_attach',targetId:'ball',hand:'right',offset:[-.25,0,0]},
    {type:'hand_target',targetId:'ball',side:'left',offset:[-.25,0,0]}];
  const result = resolveSceneContacts(new Map([['actor',actor],['ball',ball]]),[{id:'actor',contacts}]);
  assert.equal(result[0].applied,true);
  assert.equal(result[1].applied,true);
  const center = ball.position.clone();
  assert.ok(actor.getObjectByName('mixamorigLeftHand').getWorldPosition(new Vector3()).distanceTo(ball.localToWorld(new Vector3(-.25,0,0))) < .035);
  assert.ok(ball.position.equals(center));
  const cycle = resolveSceneContacts(new Map([['actor',actor],['ball',ball]]),[{id:'actor',contacts:[
    {type:'ball_attach',targetId:'ball',hand:'right'}, {type:'hand_target',targetId:'ball',side:'right'}]}]);
  assert.equal(cycle[1].reason,'cyclic_contact');
});

test('a reversed contact list still places the ball after turning the actor', () => {
  const scene = new Group(), actor = rig(), ball = new Group(), target = new Group();scene.add(actor,ball,target);
  target.position.set(3,0,0);
  const contacts=[{type:'ball_attach',targetId:'ball',hand:'right',offset:[0,0,0]}, {type:'look_at',targetId:'target'}];
  const result=resolveSceneContacts(new Map([['actor',actor],['ball',ball],['target',target]]),[{id:'actor',contacts}]);
  assert.equal(result.every(item=>item.applied),true);
  assert.ok(ball.getWorldPosition(new Vector3()).distanceTo(actor.getObjectByName('mixamorigRightHand').getWorldPosition(new Vector3()))<1e-6);
});

test('planted foot uses world coordinates and rejects an airborne actor', () => {
  const scene = new Group(), actor = rig();scene.add(actor);
  const target = [-.1,.03,.05];
  const contact = {type:'foot_plant',side:'left',position:target};
  const result = resolveSceneContacts(new Map([['actor',actor]]),[{id:'actor',contacts:[contact]}]);
  assert.equal(result[0].applied,true);
  assert.ok(actor.getObjectByName('mixamorigLeftFoot').getWorldPosition(actor.position.clone()).distanceTo({x:target[0],y:target[1],z:target[2]}) < .035);
  assert.equal(resolveSceneContacts(new Map([['actor',actor]]),[{id:'actor',airborne:true,contacts:[contact]}])[0].reason,'airborne');
});
