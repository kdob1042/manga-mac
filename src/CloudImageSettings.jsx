import React,{useState} from 'react';
import {call,desktop} from './bridge.js';
export default function CloudImageSettings({current,commit,run,busy}){
 const [key,setKey]=useState(''),[limit,setLimit]=useState(50),[approved,setApproved]=useState(false);
 return <fieldset disabled={busy||!desktop()}><legend>Runway静止画の接続</legend><p>Gen-4 Image · 720×720 · 1枚5 credits（税別0.05 USD）。人物・画風・編集元を合わせて参照3枚まで。キーは起動中だけ保持します。</p><label>静止画APIキー<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)}/></label><label>この作品の静止画上限（credits）<input type="number" min="5" max="6000" value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label><label><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>選択コマの作画指示と対応画像をRunwayへ送り、上限内の生成を許可する</label><button disabled={!approved||!key} onClick={()=>run('静止画接続を登録',async()=>{const id=await call('register_image',{input:{credential:key,max_credits:limit,approved}});setKey('');await commit({...current.current,mediaDefaults:{...current.current.mediaDefaults,imageConnection:id}});})}>静止画接続を登録</button></fieldset>;
}
