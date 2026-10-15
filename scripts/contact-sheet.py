"""assets/backgrounds 의 모든 사진을 한 장의 모음 이미지로 만든다. 사용: python contact-sheet.py out.jpg"""
import os, sys, json
from PIL import Image, ImageDraw, ImageFont

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'backgrounds')
out = sys.argv[1] if len(sys.argv) > 1 else 'contact.jpg'
items = []
for preset in sorted(os.listdir(root)):
    d = os.path.join(root, preset)
    if not os.path.isdir(d):
        continue
    for f in sorted(os.listdir(d)):
        if f.endswith('.jpg'):
            title = ''
            try:
                c = json.load(open(os.path.join(d, f[:-4] + '.json'), encoding='utf-8'))
                title = f"{c.get('title','')[:38]} · {c.get('license','')}"
            except Exception:
                pass
            items.append((preset, os.path.join(d, f), title))
if not items:
    print('no images'); sys.exit(0)
W, H, COLS = 384, 216, 4
rows = (len(items) + COLS - 1) // COLS
sheet = Image.new('RGB', (COLS * W, rows * (H + 34)), (20, 20, 24))
try:
    font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 13)
except Exception:
    font = ImageFont.load_default()
d = ImageDraw.Draw(sheet)
for i, (preset, path, title) in enumerate(items):
    x, y = (i % COLS) * W, (i // COLS) * (H + 34)
    try:
        im = Image.open(path).convert('RGB').resize((W, H))
        sheet.paste(im, (x, y))
    except Exception as e:
        d.text((x + 8, y + 8), f'ERR {e}', fill=(255, 80, 80), font=font)
    d.text((x + 4, y + H + 2), f'[{preset}] {os.path.basename(path)[:20]}', fill=(230, 230, 230), font=font)
    d.text((x + 4, y + H + 17), title, fill=(160, 160, 170), font=font)
sheet.save(out, quality=85)
print(out, len(items), 'images')
