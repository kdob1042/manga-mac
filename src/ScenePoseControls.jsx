import React, { useState } from 'react';
import { setupBasketballScene } from './scene-pose-setup.js';

const degrees = radians => Number((radians * 180 / Math.PI).toFixed(1));
const radians = degrees => Number(degrees) * Math.PI / 180;
const moments = [
  ['one_on_one', '1対1'], ['dribble', 'ドリブル'], ['layup', 'レイアップ'], ['block', 'ブロック'], ['rebound', 'リバウンド'],
];

function ActorPose({ scene, assets, chosen, rigInfo, update, busy }) {
  const [clip, setClip] = useState(chosen.pose?.clip ?? '');
  const [time, setTime] = useState(chosen.pose?.time ?? 0);
  const [part, setPart] = useState('');
  const [angles, setAngles] = useState([0, 0, 0]);
  const [ballId, setBallId] = useState(chosen.contacts?.find(c => c.type === 'ball_attach')?.targetId ?? '');
  const [hand, setHand] = useState(chosen.contacts?.find(c => c.type === 'ball_attach')?.hand ?? 'right');
  const [lookAt, setLookAt] = useState(chosen.contacts?.find(c => c.type === 'look_at')?.targetId ?? '');
  const [ground, setGround] = useState(chosen.contacts?.some(c => c.type === 'ground_snap') ?? false);
  const [secondHand, setSecondHand] = useState(chosen.contacts?.some(c => c.type === 'hand_target') ?? false);
  const [secondOffset, setSecondOffset] = useState(chosen.contacts?.find(c => c.type === 'hand_target')?.offset ?? [0.15,0,0]);
  const [plantFoot, setPlantFoot] = useState(chosen.contacts?.find(c => c.type === 'foot_plant')?.side ?? '');
  const [footPosition, setFootPosition] = useState(chosen.contacts?.find(c => c.type === 'foot_plant')?.position ?? [0,0,0]);
  const usable = !!rigInfo?.supported;
  const partNames = usable ? Object.keys(rigInfo.bones) : [];
  const clipNames = usable ? rigInfo.clipNames : [];
  const props = scene.objects.filter(o => o.id !== chosen.id && assets.find(a => a.id === o.assetId)?.kind === 'prop');
  const editBone = name => {
    setPart(name);
    setAngles((chosen.pose?.bones?.[name] ?? [0, 0, 0]).map(degrees));
  };
  return <div className="scene-pose-actor">
    <h4>選択人物のポーズ</h4>
    {!rigInfo && <p role="status">骨格を読み込み中です。読み込み後に利用可能な動作と骨を表示します。</p>}
    {rigInfo && !rigInfo.supported && <p role="alert">この人物の骨格はポーズに対応していません。別の人物素材を使用してください。理由: {rigInfo.reason}。未認識: {rigInfo.missing.join('、') || 'なし'}{rigInfo.ambiguous.length ? `／重複: ${rigInfo.ambiguous.join('、')}` : ''}</p>}
    <div className="scene-actions"><label>動作
      <select aria-label="3D動作" value={clip} onChange={e => setClip(e.target.value)}><option value="">指定なし</option>{clipNames.map(name => <option key={name} value={name}>{name}</option>)}</select>
    </label><label>時点（秒）<input aria-label="動作の時点（秒）" type="number" min="0" step="0.01" disabled={!clip} value={time} onChange={e => setTime(e.target.value)}/></label>
      <button disabled={busy || !usable || !clip} onClick={() => update({ type:'pose',id:chosen.id,pose:{ ...(chosen.pose ?? {}),clip,time:Number(time) } })}>動作を適用</button>
    </div>
    <div className="scene-actions"><label>調整する骨<select aria-label="調整する骨" value={part} onChange={e => editBone(e.target.value)}><option value="">選択</option>{partNames.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      {['X', 'Y', 'Z'].map((axis, index) => <label key={axis}>{axis}°<input aria-label={`${axis}軸の骨角度`} type="number" step="1" value={angles[index]} disabled={!part} onChange={e => setAngles(old => old.map((n, i) => i === index ? e.target.value : n))}/></label>)}
      <button disabled={busy || !usable || !part} onClick={() => update({ type:'pose',id:chosen.id,pose:{ ...(chosen.pose ?? {}),bones:{ ...(chosen.pose?.bones ?? {}),[part]:angles.map(radians) } } })}>骨の角度を保存</button>
    </div>
    <div className="scene-actions"><label>ボールを手に固定
      <select aria-label="固定する小物" value={ballId} onChange={e => setBallId(e.target.value)}><option value="">固定しない</option>{props.map(o => <option key={o.id} value={o.id}>{assets.find(a => a.id === o.assetId)?.name ?? o.id.slice(0,8)}</option>)}</select></label>
      <label>手<select aria-label="固定する手" value={hand} onChange={e => setHand(e.target.value)}><option value="right">右</option><option value="left">左</option></select></label>
      <label>向く相手<select aria-label="向く相手" value={lookAt} onChange={e => setLookAt(e.target.value)}><option value="">指定なし</option>{scene.objects.filter(o => o.id !== chosen.id).map(o => <option key={o.id} value={o.id}>{o.id.slice(0,8)}</option>)}</select></label>
      <label><input type="checkbox" checked={ground} disabled={chosen.airborne} onChange={e => setGround(e.target.checked)}/>足を床に合わせる</label>
      <label><input type="checkbox" checked={secondHand} disabled={!ballId} onChange={e=>setSecondHand(e.target.checked)}/>反対の手もボールに合わせる</label>
      {secondHand && ['X','Y','Z'].map((axis,i)=><label key={axis}>反対の手の接点{axis}（m）<input type="number" step="0.01" value={secondOffset[i]} onChange={e=>setSecondOffset(v=>v.map((n,j)=>i===j?e.target.value:n))}/></label>)}
      <label>固定する足<select value={plantFoot} disabled={chosen.airborne} onChange={e=>setPlantFoot(e.target.value)}><option value="">指定なし</option><option value="left">左足</option><option value="right">右足</option></select></label>
      {plantFoot && ['X','Y','Z'].map((axis,i)=><label key={axis}>足先{axis}（m）<input type="number" step="0.01" value={footPosition[i]} onChange={e=>setFootPosition(v=>v.map((n,j)=>i===j?e.target.value:n))}/></label>)}
      <button disabled={busy || !usable} onClick={() => update({ type:'pose',id:chosen.id,contacts:[
        ...(ground && !chosen.airborne ? [{type:'ground_snap'}] : []),
        ...(lookAt ? [{type:'look_at',targetId:lookAt}] : []),
        ...(ballId ? [{type:'ball_attach',targetId:ballId,hand}] : []),
        ...(ballId && secondHand ? [{type:'hand_target',targetId:ballId,side:hand==='right'?'left':'right',offset:secondOffset.map(Number)}] : []),
        ...(plantFoot && !chosen.airborne ? [{type:'foot_plant',side:plantFoot,position:footPosition.map(Number)}] : []),
      ] })}>接触を保存</button>
    </div>
    <button disabled={busy || (!chosen.pose && !chosen.contacts?.length)} onClick={() => update({type:'pose',id:chosen.id,pose:undefined,contacts:[]})}>ポーズと接触を解除</button>
  </div>;
}

export default function ScenePoseControls({ scene, assets, chosen, rigInfo, update, busy }) {
  const characters = assets.filter(asset => asset.kind === 'character');
  const props = assets.filter(asset => asset.kind === 'prop');
  const [moment, setMoment] = useState('one_on_one');
  const [offense, setOffense] = useState('');
  const [defense, setDefense] = useState('');
  const [ball, setBall] = useState('');
  return <details className="scene-pose-controls"><summary>ポーズ・バスケ構図</summary>
    {chosen && assets.find(a => a.id === chosen.assetId)?.kind === 'character' && <ActorPose key={`${chosen.id}:${JSON.stringify(chosen.pose)}:${JSON.stringify(chosen.contacts)}`} scene={scene} assets={assets} chosen={chosen} rigInfo={rigInfo} update={update} busy={busy}/>}
    <h4>バスケの一瞬を配置</h4>
    <p className="muted">素材を選んで既存のコート上に選手とボールを置きます。あとから位置とカメラを調整できます。</p>
    <div className="scene-actions">
      <label>場面<select aria-label="バスケ場面" value={moment} onChange={e=>setMoment(e.target.value)}>{moments.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>攻撃側<select aria-label="攻撃側素材" value={offense} onChange={e=>setOffense(e.target.value)}><option value="">選択</option>{characters.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>守備側<select aria-label="守備側素材" value={defense} onChange={e=>setDefense(e.target.value)}><option value="">選択</option>{characters.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>ボール<select aria-label="ボール素材" value={ball} onChange={e=>setBall(e.target.value)}><option value="">選択</option>{props.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <button disabled={busy || !offense || !defense || !ball} onClick={()=>update({type:'replace',scene:setupBasketballScene(scene,{moment,offenseAssetId:offense,defenseAssetId:defense,ballAssetId:ball})})}>構図を配置</button>
    </div>
  </details>;
}
