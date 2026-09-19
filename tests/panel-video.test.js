import {test} from 'node:test';
import assert from 'node:assert/strict';
import {template} from '../src/layout.js';
import {frameRect} from '../src/page-art.js';
import {containCrop} from '../src/image-crop.js';
import {pageClipPath,tileClipPath,videoBox,videoPageStyle,videoRatio} from '../src/panel-video.js';

test('panel video covers the home frame and clips to the home polygon, not overflow',()=>{
 const [home,neighbor]=template(2,['red','blue']);
 home.overflow={points:[[0.2,0.02],[0.98,0.02],[0.98,0.98],[0.2,0.98]]};
 const box=videoBox(home,960,960);
 const frame=frameRect(home.points);
 assert.ok(box.x<=frame.x&&box.y<=frame.y&&box.x+box.width>=frame.x+frame.width&&box.y+box.height>=frame.y+frame.height);
 const overflow=frameRect(home.overflow.points);
 assert.ok(box.width<overflow.width||box.height<overflow.height);
 const clip=pageClipPath(home.points);
 assert.match(clip,/polygon\(/);
 assert.doesNotMatch(clip,/0\.2%/);
 const tile=tileClipPath(home.points);
 assert.match(tile,/^polygon\(0% 0%/);
 const contained=videoBox(home,960,960,containCrop());
 assert.ok(contained.width<box.width||contained.height<box.height);
 assert.deepEqual(videoRatio('720:1280'),[720,1280]);
 const style=videoPageStyle(box);
 assert.match(style.left,/%$/);
});
