// Build uses a checked-in, verified artificial fixture; FFmpeg is only needed to regenerate/probe it.
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import {validate} from '../contracts/validate.mjs';
const bundle=JSON.parse(await readFile(new URL('../contracts/fixture-assets.json',import.meta.url)));validate(bundle.manifest);
const root='public/demo';await rm(root,{recursive:true,force:true});await mkdir(root+'/assets',{recursive:true});
for(const a of bundle.manifest.assets){const b=Buffer.from(bundle.files[a.path],'base64');if(b.length!==a.bytes||createHash('sha256').update(b).digest('hex')!==a.sha256)throw Error('Corrupt fixture bundle');await writeFile(root+'/'+a.path,b);}
await writeFile(root+'/live-manga.json',JSON.stringify(bundle.manifest,null,2));
