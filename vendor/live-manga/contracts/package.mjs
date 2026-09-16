import { validate } from './validate.mjs';
import { createHash } from 'node:crypto';
import { readFile, lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export function probe(path) {
  const result=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path],{maxBuffer:1024*1024,timeout:30000}).toString());
  const videos=result.streams.filter(s=>s.codec_type==='video');
  if(videos.length!==1)throw Error('Exactly one visual stream required');
  const v=videos[0];return {width:v.width,height:v.height,codec:v.codec_name,audio:result.streams.some(s=>s.codec_type==='audio'),duration:Number(result.format.duration)};
}
export async function verifyPackage(directory) {
  const root=resolve(directory);if((await lstat(root)).isSymbolicLink())throw Error('Symlink package');
  const manifestPath=join(root,'live-manga.json');if((await lstat(manifestPath)).isSymbolicLink()||(await lstat(manifestPath)).size>4*1024*1024)throw Error('Invalid manifest file');
  const manifest=validate(JSON.parse(await readFile(manifestPath,'utf8')));
  const expected=new Set(['live-manga.json',...manifest.assets.map(a=>a.path)]);
  async function walk(dir,prefix='') {for(const ent of await readdir(dir,{withFileTypes:true})){const p=prefix+ent.name;if(ent.isSymbolicLink())throw Error('Symlink asset');if(ent.isDirectory()){if(p!=='assets')throw Error('Unexpected directory');await walk(join(dir,ent.name),p+'/');}else if(!ent.isFile()||!expected.has(p))throw Error('Unexpected public file: '+p);}}
  await walk(root);
  for(const a of manifest.assets) {
    const file=join(root,a.path),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==a.bytes||!(await realpath(file)).startsWith(await realpath(root)+'/'))throw Error('Invalid asset file');
    const b=await readFile(file);if(sha256(b)!==a.sha256)throw Error('Asset hash mismatch');
    const p=probe(file);if(p.width!==a.width||p.height!==a.height)throw Error('Asset dimensions mismatch');
    const codec={'image/png':'png','image/jpeg':'mjpeg','image/webp':'webp','video/mp4':'h264'}[a.mime];
    if(p.codec!==codec)throw Error('Actual codec mismatch');
    if(a.mime==='video/mp4'&&(p.audio!==a.audio||Math.abs(p.duration-a.duration)>.05||b.toString('ascii',4,8)!=='ftyp'))throw Error('Video metadata mismatch');
  }
  return manifest;
}
