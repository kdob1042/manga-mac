// Update lock.json only from a reviewed canonical commit/checksum bundle, then run --sync.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {dirname} from 'node:path';
const root=new URL('../vendor/live-manga/',import.meta.url),lock=JSON.parse(await readFile(new URL('lock.json',root)));
if(lock.repository!=='kdob1042/live-manga'||!/^[0-9a-f]{40}$/.test(lock.commit))throw Error('Invalid canonical lock');
for(const [path,hash] of Object.entries(lock.files)){
 if(!/^(contracts|scripts)\/[a-zA-Z0-9_.-]+$/.test(path)||!/^[a-f0-9]{64}$/.test(hash))throw Error('Unsafe contract entry');
 let bytes;if(process.argv.includes('--sync')){const r=await fetch(`https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${path}`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Contract fetch failed');bytes=Buffer.from(await r.arrayBuffer());}else bytes=await readFile(new URL(path,root));
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error(`Contract checksum mismatch: ${path}`);
 if(process.argv.includes('--sync')){const dest=new URL(path,root);await mkdir(dirname(dest.pathname),{recursive:true});await writeFile(dest,bytes);}
}
console.log(`Live Manga ${lock.version} @ ${lock.commit}: checksums verified`);
