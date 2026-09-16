from PIL import Image, ImageDraw, ImageFont
import sys
im=Image.new('RGBA',(800,1120));d=ImageDraw.Draw(im)
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',20)
for i,x in enumerate([420,30,420,30]):
 y=30 if i<2 else 570
 d.rectangle((x,y,x+350,y+510),outline='#243a40',width=3)
 d.text((x+20,y+375),['A quiet afternoon.','Touch this panel.','Time is in your hands.','Read at your own pace.'][i],font=font,fill='#243a40')
im.save(sys.argv[1]);base=Image.open(sys.argv[3]).convert('RGBA');base.alpha_composite(im);base.convert('RGB').save(sys.argv[2])
