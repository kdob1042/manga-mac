// Page-space image placement shared by Canvas output and the publication exporter.
import { artPoints, bounds, contentBox, PAGE } from './layout.js';
import { containRect } from './image-input.js';
import { coverCrop, cropRect } from './image-crop.js';
export function frameRect(points) {
 const b=bounds(points);
 return {x:b.x*PAGE.width,y:b.y*PAGE.height,width:b.width*PAGE.width,height:b.height*PAGE.height};
}
export function panelArtRect(points,width,height,crop) {
 const cover=coverCrop(crop);
 if(cover){const {x,y,width:w,height:h}=cropRect(width,height,frameRect(points),cover);return {x,y,width:w,height:h};}
 const box=contentBox(points),scale=Math.min(box.width/720,box.height/1030),fit=containRect(width,height,716,716);
 return {x:box.x+(box.width-720*scale)/2+(2+fit.x)*scale,y:box.y+(box.height-1030*scale)/2+(2+fit.y)*scale,width:fit.width*scale,height:fit.height*scale};
}
// Live clip/frame stay on the home quad so the viewer can mask in-panel video.
// artRect uses the same placement as page rasters, including overflow-aligned cover.
export function livePanelGeometry(slot,width,height,crop) {
 const home=slot.points;
 return {
  frame:frameRect(home),
  clip:home.map(([x,y])=>[x*PAGE.width,y*PAGE.height]),
  artRect:panelArtRect(artPoints(slot),width,height,crop),
 };
}
