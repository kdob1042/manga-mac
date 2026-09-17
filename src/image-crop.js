// Non-destructive placement; source pixels and lettering are never changed.
export const defaultCrop = () => ({zoom:1,x:0.5,y:0.5});
export function validateCrop(crop) {
  if (!crop || !Number.isFinite(crop.zoom) || crop.zoom < 1 || crop.zoom > 8 ||
      ![crop.x,crop.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)) throw Error('画像配置が不正です');
  return crop;
}
export function cropRect(width,height,box,crop) {
  validateCrop(crop);
  if (![width,height,box.width,box.height].every(n=>Number.isFinite(n)&&n>0)) throw Error('画像寸法が不正です');
  const scale=Math.max(box.width/width,box.height/height)*crop.zoom;
  const w=width*scale,h=height*scale;
  return {x:box.x-(w-box.width)*crop.x,y:box.y-(h-box.height)*crop.y,width:w,height:h,scale};
}
export function panCrop(crop,rect,box,dx,dy) {
  const clamp=n=>Math.max(0,Math.min(1,n));
  return {...crop,x:rect.width>box.width?clamp(crop.x-dx/(rect.width-box.width)):crop.x,
    y:rect.height>box.height?clamp(crop.y-dy/(rect.height-box.height)):crop.y};
}
