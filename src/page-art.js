// Page-space image placement shared by Canvas output and the publication exporter.
import { bounds, contentBox, PAGE } from './layout.js';
import { containRect } from './image-input.js';
import { cropRect } from './image-crop.js';
export function frameRect(points) {
 const b=bounds(points);
 return {x:b.x*PAGE.width,y:b.y*PAGE.height,width:b.width*PAGE.width,height:b.height*PAGE.height};
}
export function panelArtRect(points,width,height,crop) {
 if(crop){const {x,y,width:w,height:h}=cropRect(width,height,frameRect(points),crop);return {x,y,width:w,height:h};}
 const box=contentBox(points),scale=Math.min(box.width/720,box.height/1030),fit=containRect(width,height,716,716);
 return {x:box.x+(box.width-720*scale)/2+(2+fit.x)*scale,y:box.y+(box.height-1030*scale)/2+(2+fit.y)*scale,width:fit.width*scale,height:fit.height*scale};
}
