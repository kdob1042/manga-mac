import type {Manifest} from './types';
export type Preview = {
  format:'live-manga-preview'; schemaVersion:'1.0.0'; savedAt:string;
  manifest:Manifest;
  scenes:{id:string;tags:string[]}[];
  panels:{id:string;sceneIds:string[];art:'ready'|'pending';lettering:'ready'|'pending'|'none';motion:'ready'|'pending'|'stale'|'none'}[];
};
