import { AnimationMixer, Euler, LoopOnce, Quaternion, Vector3 } from 'three';

// Scene coordinates are metres, Y-up. A generated GLB is not assumed to have a usable rig.
const PARTS = ['hips', 'leftUpperArm', 'leftForeArm', 'leftHand', 'rightUpperArm', 'rightForeArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const ALIASES = {
  hips: ['hips', 'pelvis'],
  leftUpperArm: ['leftupperarm', 'leftarm', 'lupperarm'], leftForeArm: ['leftforearm', 'leftlowerarm', 'lforearm'], leftHand: ['lefthand', 'lhand'],
  rightUpperArm: ['rightupperarm', 'rightarm', 'rupperarm'], rightForeArm: ['rightforearm', 'rightlowerarm', 'rforearm'], rightHand: ['righthand', 'rhand'],
  leftUpperLeg: ['leftupperleg', 'leftupleg', 'leftthigh', 'lupperleg'], leftLowerLeg: ['leftlowerleg', 'leftleg', 'leftcalf', 'llowerleg'], leftFoot: ['leftfoot', 'lfoot'],
  rightUpperLeg: ['rightupperleg', 'rightupleg', 'rightthigh', 'rupperleg'], rightLowerLeg: ['rightlowerleg', 'rightleg', 'rightcalf', 'rlowerleg'], rightFoot: ['rightfoot', 'rfoot'],
};
const restStates = new WeakMap();
const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n));
const norm = name => String(name ?? '').replace(/^(mixamorig|j_bip_)/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

function rigBones(root) {
  const found = {};
  root?.traverse?.(node => {
    if (!node.isBone) return;
    const name = norm(node.name);
    for (const part of PARTS) {
      if (ALIASES[part].includes(name)) (found[part] ??= []).push(node);
    }
  });
  return found;
}

function usableClip(clip, root) {
  if (!clip?.name || !Number.isFinite(clip.duration) || clip.duration <= 0 || !clip.tracks?.length) return false;
  const nodes = new Set();
  root?.traverse?.(node => { if (node.isBone && node.name) nodes.add(node.name); });
  // Reject clips whose tracks cannot be bound to any bone on this GLB. Merely having an
  // animation with the same name says nothing about whether this skeleton can play it.
  return clip.tracks.some(track => nodes.has(track.name?.split('.')[0]));
}

export function inspectRig(root, clips = []) {
  const found = rigBones(root);
  const bones = Object.fromEntries(PARTS.filter(k => found[k]?.length === 1).map(k => [k, found[k][0].name]));
  const missing = PARTS.filter(k => !found[k]?.length);
  const ambiguous = PARTS.filter(k => found[k]?.length > 1);
  const clipNames = [...new Set((clips ?? []).filter(c => usableClip(c, root)).map(c => c.name))];
  return { supported: missing.length === 0 && ambiguous.length === 0, bones, missing, ambiguous, clipNames,
    canAttachBall: !!bones.leftHand || !!bones.rightHand,
    canGround: !!bones.leftFoot || !!bones.rightFoot };
}

function restore(root) {
  let state = restStates.get(root);
  if (!state) {
    state = { bones: new Map(), mixer: null };
    root.traverse(node => { if (node.isBone) state.bones.set(node, node.quaternion.clone()); });
    restStates.set(root, state);
  }
  state.mixer?.stopAllAction();
  state.mixer = null;
  for (const [bone, quaternion] of state.bones) bone.quaternion.copy(quaternion);
  return state;
}

// Call after positioning a fresh GLB instance. Manual rotations are deltas in local bone space.
export function applyActorPose(root, actor = {}, clips = []) {
  if (!root?.traverse) return { applied: false, reason: 'missing_object' };
  const pose = actor.pose;
  const rig = inspectRig(root, clips);
  if (!pose) { restore(root); return { applied: false, reason: 'no_pose' }; }
  if (!rig.supported) return { applied: false, reason: 'incompatible_rig', missing: rig.missing, ambiguous: rig.ambiguous };
  if (!pose || typeof pose !== 'object' || Array.isArray(pose)) return { applied: false, reason: 'invalid_pose' };
  const deltas = pose.bones ?? {};
  if (!deltas || typeof deltas !== 'object' || Array.isArray(deltas)) return { applied: false, reason: 'invalid_bones' };
  const names = Object.keys(deltas);
  if (names.some(k => !rig.bones[k] || !finite3(deltas[k]))) return { applied: false, reason: 'unsupported_bone' };
  const clip = pose.clip ? clips.find(c => c.name === pose.clip && usableClip(c, root)) : null;
  if (pose.clip && !clip) return { applied: false, reason: 'unavailable_clip' };
  if (clip && (!Number.isFinite(pose.time ?? 0) || (pose.time ?? 0) < 0 || (pose.time ?? 0) > clip.duration))
    return { applied: false, reason: 'invalid_time' };
  if (!clip && !names.length) return { applied: false, reason: 'empty_pose' };
  const state = restore(root);
  if (clip) {
    state.mixer = new AnimationMixer(root);
    const action = state.mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    state.mixer.setTime(pose.time ?? 0);
  }
  const found = rigBones(root);
  for (const key of names) found[key][0].quaternion.multiply(new Quaternion().setFromEuler(new Euler(...deltas[key], 'XYZ')));
  root.updateMatrixWorld(true);
  return { applied: true, clip: clip?.name ?? null, parts: names };
}

function instancesById(instances) {
  return instances instanceof Map ? instances : new Map(Object.entries(instances ?? {}));
}
function objectOf(value) { return value?.root ?? value?.scene ?? value?.object ?? value; }
function getBone(root, semantic) { const matches = rigBones(root)[semantic]; return matches?.length === 1 ? matches[0] : null; }

// Static constraints run after posing. Only a prop follows a hand: the hand is never moved in response.
// No physics or iterative solver is involved; airborne actors never receive floor snapping.
export function resolveSceneContacts(instances, objects = []) {
  const byId = instancesById(instances);
  const diagnostics = [];
  const attached = new Set();
  const actors = Array.isArray(objects) ? objects : [];
  for (const actor of actors) {
    const root = objectOf(byId.get(actor.id));
    if (!root?.updateMatrixWorld) continue;
    for (const contact of actor.contacts ?? []) {
      if (!inspectRig(root).supported) {
        diagnostics.push({ id: actor.id, type: contact?.type ?? null, reason: 'incompatible_rig' }); continue;
      }
      if (contact?.type === 'ground_snap') {
        if (actor.airborne) { diagnostics.push({ id: actor.id, type: contact.type, reason: 'airborne' }); continue; }
        const feet = ['leftFoot', 'rightFoot'].map(key => getBone(root, key)).filter(Boolean);
        if (!feet.length) { diagnostics.push({ id: actor.id, type: contact.type, reason: 'missing_feet' }); continue; }
        root.updateMatrixWorld(true);
        const floor = Number.isFinite(contact.y) ? contact.y : 0;
        const lowest = Math.min(...feet.map(foot => foot.getWorldPosition(new Vector3()).y));
        root.position.y += floor - lowest;
        root.updateMatrixWorld(true);
        diagnostics.push({ id: actor.id, type: contact.type, applied: true });
      } else if (contact?.type === 'ball_attach') {
        const hand = getBone(root, contact.hand === 'left' ? 'leftHand' : 'rightHand');
        const prop = objectOf(byId.get(contact.targetId));
        if (!hand || !prop?.parent || actor.id === contact.targetId || attached.has(contact.targetId) ||
            (contact.offset != null && !finite3(contact.offset))) {
          diagnostics.push({ id: actor.id, type: contact.type, reason: 'unavailable_target' }); continue;
        }
        root.updateMatrixWorld(true);
        prop.parent.updateMatrixWorld(true);
        const world = hand.localToWorld(new Vector3(...(contact.offset ?? [0, -0.12, 0])));
        prop.position.copy(prop.parent.worldToLocal(world));
        prop.updateMatrixWorld(true);
        attached.add(contact.targetId);
        diagnostics.push({ id: actor.id, type: contact.type, applied: true });
      } else if (contact?.type === 'look_at') {
        const target = objectOf(byId.get(contact.targetId));
        if (!target?.getWorldPosition || target === root || !root.parent) {
          diagnostics.push({ id: actor.id, type: contact.type, reason: 'unavailable_target' }); continue;
        }
        root.parent.updateMatrixWorld(true);
        target.updateMatrixWorld(true);
        const localTarget = root.parent.worldToLocal(target.getWorldPosition(new Vector3()));
        const delta = localTarget.sub(root.position);
        if (delta.x * delta.x + delta.z * delta.z < 1e-8) {
          diagnostics.push({ id: actor.id, type: contact.type, reason: 'overlapping_target' }); continue;
        }
        // +Z is the canonical forward axis; models facing elsewhere should be normalized at import.
        root.rotation.y = Math.atan2(delta.x, delta.z);
        root.updateMatrixWorld(true);
        diagnostics.push({ id: actor.id, type: contact.type, applied: true });
      } else {
        diagnostics.push({ id: actor.id, type: contact?.type ?? null, reason: 'unsupported_contact' });
      }
    }
  }
  return diagnostics;
}

// A starting composition for a single manga panel. Rig names are checked when applying the pose.
// The caller assigns real asset IDs and may move actors/camera without regenerating meshes.
export function basketballMoment(name, { offenseId = 'offense', defenseId = 'defense', ballId = 'ball' } = {}) {
  const poses = {
    dribble: { offense: { rightUpperArm: [-0.5, 0, -0.2], rightForeArm: [-0.8, 0, 0] }, defense: { leftUpperArm: [-0.4, 0, 0.4] }, ball: [0.75, 0.45, -0.1], attached: false },
    one_on_one: { offense: { rightUpperArm: [-0.5, 0, -0.2] }, defense: { leftUpperArm: [-0.5, 0, 0.4], rightUpperArm: [-0.5, 0, -0.4] }, ball: [0.8, 1, 0], attached: true },
    layup: { offense: { rightUpperArm: [-2.2, 0, -0.2], rightForeArm: [-0.3, 0, 0] }, defense: { leftUpperArm: [-1.6, 0, 0.2] }, ball: [0.4, 2.5, 0], attached: true, airborne: true },
    block: { offense: { rightUpperArm: [-2.2, 0, 0] }, defense: { leftUpperArm: [-2.5, 0, 0] }, ball: [0.4, 2.5, 0], attached: true, airborne: true },
    rebound: { offense: { leftUpperArm: [-2.3, 0, 0], rightUpperArm: [-2.3, 0, 0] }, defense: { leftUpperArm: [-1.9, 0, 0] }, ball: [0, 2.8, -0.5], attached: false, airborne: true },
  };
  const moment = poses[name];
  if (!moment) throw Error(`Unknown basketball moment: ${name}`);
  return {
    actors: [
      { id: offenseId, position: [0, moment.airborne ? 0.5 : 0, 0], rotation: [0, 0, 0], pose: { bones: moment.offense },
        ...(moment.airborne ? { airborne: true } : {}),
        contacts: moment.attached ? [{ type: 'ball_attach', targetId: ballId, hand: 'right' }] : moment.airborne ? [] : [{ type: 'ground_snap' }] },
      { id: defenseId, position: [1.35, moment.airborne ? 0.3 : 0, -0.65], rotation: [0, -0.6, 0], pose: { bones: moment.defense },
        ...(moment.airborne ? { airborne: true } : {}),
        contacts: moment.airborne ? [] : [{ type: 'ground_snap' }] },
    ],
    ball: { id: ballId, position: moment.ball },
    camera: { position: [2.7, 1.5, 4.5], target: [0.6, 1.25, -0.4], fov: 45 },
  };
}
