import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationClip, Bone, Group, Mesh, BoxGeometry, MeshBasicMaterial, QuaternionKeyframeTrack } from 'three';
import { applyActorPose, basketballMoment, inspectRig, resolveSceneContacts } from '../src/scene-pose.js';

function rig() {
  const root = new Group();
  const names = ['Hips', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
  for (const name of names) {
    const bone = new Bone(); bone.name = `mixamorig${name}`;
    if (name === 'RightHand') bone.position.set(0.5, 1.5, 0);
    if (name.endsWith('Foot')) bone.position.set(0, 0.2, 0);
    root.add(bone);
  }
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
  root.remove(leg);
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
  assert.ok(Math.abs(player.position.y + 0.2) < 1e-8);
  assert.equal(other.position.y, 2);
  assert.deepEqual(ball.position.toArray().map(n => Number(n.toFixed(4))), [1.5, 1.3, 0]);
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
