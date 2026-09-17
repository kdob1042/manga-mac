// Canonical v1 contract. Shared verbatim by pinned, hash-verified consumers.
export const VERSION = '1.0.0';
export const LIMITS = Object.freeze({ pages: 100, panels: 32, dimension: 8192, assets: 4000, imageBytes: 32*1024*1024, videoBytes: 128*1024*1024, totalBytes: 1024*1024*1024 });
const fail = message => { throw Error(`Live Manga: ${message}`); };
const obj = (v, required, optional=[]) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k=>!(k in v)) || Object.keys(v).some(k=>![...required,...optional].includes(k))) fail('unknown or missing fields');
};
const text = (s, max=2000) => { if(typeof s!=='string'||!s.trim()||s.length>max||/[<>\u0000-\u0008]/.test(s)) fail('invalid text'); };
const panelText = s => { if(typeof s!=='string'||s.length>2000||/[<>\u0000-\u0008]/.test(s)) fail('invalid panel text'); };
const id = s => { if(typeof s!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(s)) fail('invalid ID'); };
const integer = (n,min,max) => { if(!Number.isSafeInteger(n)||n<min||n>max) fail('invalid integer'); };
const array = (v,min,max) => { if(!Array.isArray(v)||v.length<min||v.length>max) fail('invalid collection'); };
const unique = values => { if(new Set(values).size!==values.length) fail('duplicate ID'); };
function rect(r, width, height) {
  obj(r,['x','y','width','height']);
  if(Object.values(r).some(n=>typeof n!=='number'||!Number.isFinite(n))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>width+.001||r.y+r.height>height+.001) fail('rectangle outside page');
}
export function validate(manifest) {
  obj(manifest,['format','schemaVersion','releaseId','workId','episodeId','title','language','pages','assets']);
  if(manifest.format!=='live-manga'||manifest.schemaVersion!==VERSION) fail('unsupported schema version');
  for(const k of ['releaseId','workId','episodeId']) id(manifest[k]);
  text(manifest.title,200); if(!['ja','en'].includes(manifest.language)) fail('unsupported language');
  array(manifest.assets,1,LIMITS.assets); array(manifest.pages,1,LIMITS.pages);
  unique(manifest.assets.map(a=>a.id)); unique(manifest.assets.map(a=>a.path));
  let total=0; const assets=new Map();
  for(const a of manifest.assets) {
    obj(a,['id','path','sha256','mime','bytes','width','height'],['duration','codec','audio']);
    if(!/^[0-9a-f]{64}$/.test(a.sha256)||a.id!==a.sha256) fail('invalid hash');
    const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4'}[a.mime];
    if(!ext||a.path!==`assets/${a.sha256}.${ext}`) fail('unsafe asset path or MIME');
    integer(a.bytes,1,a.mime==='video/mp4'?LIMITS.videoBytes:LIMITS.imageBytes);
    integer(a.width,1,LIMITS.dimension); integer(a.height,1,LIMITS.dimension);
    if(a.mime==='video/mp4') { if(a.codec!=='h264'||a.audio!==false||typeof a.duration!=='number'||!Number.isFinite(a.duration)||a.duration<=0||a.duration>30) fail('unsupported video profile'); }
    else if(['duration','codec','audio'].some(k=>k in a)) fail('video fields on image');
    assets.set(a.id,a);total+=a.bytes;
  }
  if(total>LIMITS.totalBytes) fail('package too large');
  const used=new Set(), ids=[];
  const asset=(key,kind)=>{const a=assets.get(key);if(!a||!a.mime.startsWith(kind)) fail('missing or wrong asset reference');used.add(key);return a;};
  for(const p of manifest.pages) {
    obj(p,['id','width','height','art','overlay','fallback','panels']);id(p.id);ids.push(p.id);
    integer(p.width,1,LIMITS.dimension);integer(p.height,1,LIMITS.dimension);array(p.panels,1,LIMITS.panels);
    for(const k of ['art','overlay','fallback']) {const a=asset(p[k],'image/');if(a.width!==p.width||a.height!==p.height) fail('page layer dimensions differ');if(k==='overlay'&&a.mime!=='image/png')fail('overlay must be PNG');}
    for(const panel of p.panels) {
      obj(panel,['id','frame','artRect','poster','text'],['motion']);id(panel.id);ids.push(panel.id);panelText(panel.text);
      rect(panel.frame,p.width,p.height);rect(panel.artRect,p.width,p.height);
      const f=panel.frame,r=panel.artRect;
      if(r.x<f.x||r.y<f.y||r.x+r.width>f.x+f.width+.001||r.y+r.height>f.y+f.height+.001)fail('art outside panel');
      const poster=asset(panel.poster,'image/');
      if(Math.abs(poster.width/poster.height-r.width/r.height)>.001)fail('poster ratio mismatch');
      if(panel.motion) {obj(panel.motion,['asset','end']);if(panel.motion.end!=='poster')fail('unsupported end behavior');const v=asset(panel.motion.asset,'video/');if(v.width*poster.height!==v.height*poster.width)fail('motion ratio mismatch');}
    }
  }
  unique(ids);if(used.size!==assets.size)fail('unreferenced asset');
  return manifest;
}
