import { basketballMoment } from './scene-pose.js';

// Select existing instances first so rerunning a composition edits the same actors.
// The complete scene is submitted as one validated edit and therefore one Undo step.
export function setupBasketballScene(scene, { moment, offenseAssetId, defenseAssetId, ballAssetId }, newId = () => crypto.randomUUID()) {
  if (![offenseAssetId, defenseAssetId, ballAssetId].every(id => typeof id === 'string' && id)) throw Error('選手2人とボールの素材を選んでください');
  const selected = new Set();
  const choose = assetId => {
    const existing = scene.objects.find(item => item.assetId === assetId && !selected.has(item.id));
    const id = existing?.id ?? newId();
    if (selected.has(id) || scene.objects.some(item => item.id === id && item !== existing)) throw Error('構図内の識別子が重複しました');
    selected.add(id);
    return { id, existing };
  };
  const offense = choose(offenseAssetId), defense = choose(defenseAssetId), ball = choose(ballAssetId);
  const template = basketballMoment(moment, { offenseId: offense.id, defenseId: defense.id, ballId: ball.id });
  const poseActor = (selection, assetId, templateActor) => ({ id: selection.id, ...templateActor, assetId,
    scale: selection.existing?.scale ?? [1, 1, 1] });
  const ballObject = { ...template.ball, assetId: ballAssetId,
    rotation: ball.existing?.rotation ?? [0, 0, 0], scale: ball.existing?.scale ?? [1, 1, 1] };
  return { ...scene, camera: template.camera,
    objects: [...scene.objects.filter(item => !selected.has(item.id)),
      poseActor(offense, offenseAssetId, template.actors[0]),
      poseActor(defense, defenseAssetId, template.actors[1]), ballObject] };
}
