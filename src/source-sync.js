import {sceneTags} from './source-tags.js';
// This is the import preview, not the manuscript-to-manga application diff.
export function sourceSummary(previous, next) {
  const changes=(before=[],after=[],key,body)=>{
    const old=new Map(before.map(x=>[key(x),x])), fresh=new Map(after.map(x=>[key(x),x]));
    return [...after.filter(x=>!old.has(key(x))||body(old.get(key(x)))!==body(x)).map(x=>`${old.has(key(x))?'変更':'追加'}: ${key(x)}`),...before.filter(x=>!fresh.has(key(x))).map(x=>`削除: ${key(x)}`)];
  };
  const scenes=changes(previous?.scenes,next.scenes,x=>x.id,x=>JSON.stringify([x.path,x.text,x.design]));
  for(const scene of next.scenes??[])if(previous?.scenes?.some(s=>s.id===scene.id)&&JSON.stringify(sceneTags(previous,scene.id))!==JSON.stringify(sceneTags(next,scene.id)))scenes.push(`タグ変更: ${scene.id}`);
  const settings=changes(previous?.settings,next.settings,x=>x.id,x=>JSON.stringify([x.path,x.text]));
  const references=changes(previous?.references,next.references,x=>x.path,x=>JSON.stringify([x.hash,x.name]));
  const structure=JSON.stringify(previous?.manifest)!==JSON.stringify(next.manifest);
  return {scenes,settings,references,structure,changed:!previous||structure||!!(scenes.length+settings.length+references.length)};
}
