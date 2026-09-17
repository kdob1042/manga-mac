export interface Rect { x:number; y:number; width:number; height:number }
export interface Asset {id:string;path:string;sha256:string;mime:string;bytes:number;width:number;height:number;duration?:number;codec?:'h264';audio?:false}
export interface Panel {id:string;frame:Rect;artRect:Rect;poster:string;text:string;clip?:[number,number][];motion?:{asset:string;end:'poster'}}
export interface Page {id:string;width:number;height:number;art:string;overlay:string;fallback:string;panels:Panel[]}
export interface Manifest {format:'live-manga';schemaVersion:'1.0.0'|'2.0.0';releaseId:string;workId:string;episodeId:string;title:string;language:'ja'|'en';pages:Page[];assets:Asset[]}
