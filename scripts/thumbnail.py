"""배경 이미지(1920x1080)와 유튜브 썸네일(1280x720)을 생성한다.
사용: python thumbnail.py spec.json
spec: {style, title, subtitle, out_background, out_thumbnail, background_image(optional), font, seed}
"""
import json, math, random, sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

STYLES = {
    'night':  {'colors': [(18, 24, 48), (62, 32, 92), (12, 60, 90)], 'accent': (255, 196, 110), 'text': (255, 255, 255)},
    'warm':   {'colors': [(72, 32, 20), (150, 70, 40), (230, 150, 80)], 'accent': (255, 240, 200), 'text': (255, 250, 240)},
    'mono':   {'colors': [(20, 20, 22), (60, 60, 64), (110, 110, 116)], 'accent': (230, 230, 230), 'text': (245, 245, 245)},
    'neon':   {'colors': [(10, 6, 30), (120, 10, 90), (0, 140, 160)], 'accent': (0, 255, 200), 'text': (255, 255, 255)},
    'paper':  {'colors': [(240, 232, 216), (220, 205, 180), (196, 176, 150)], 'accent': (90, 60, 40), 'text': (50, 40, 30)},
    'forest': {'colors': [(10, 30, 24), (26, 70, 50), (90, 130, 80)], 'accent': (230, 220, 160), 'text': (245, 250, 240)},
    'ocean':  {'colors': [(6, 20, 40), (10, 60, 110), (40, 140, 170)], 'accent': (255, 230, 170), 'text': (255, 255, 255)},
}

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\malgunbd.ttf', r'C:\Windows\Fonts\malgun.ttf', r'C:\Windows\Fonts\NotoSansKR-VF.ttf',
    r'C:\Windows\Fonts\arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']


def font(size, pref=None):
    for f in ([pref] if pref else []) + FONT_CANDIDATES:
        if f and os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(w, h, colors, seed):
    rnd = random.Random(seed)
    # 작은 해상도로 그라데이션을 만들고 확대(속도)
    sw, sh = w // 8, h // 8
    img = Image.new('RGB', (sw, sh), colors[0])
    px = img.load()
    ang = rnd.uniform(0, math.pi)
    cx, cy = math.cos(ang), math.sin(ang)
    for y in range(sh):
        for x in range(sw):
            t = ((x / sw - 0.5) * cx + (y / sh - 0.5) * cy) + 0.5
            t = max(0.0, min(1.0, t))
            px[x, y] = lerp(colors[0], colors[1], t * 2) if t < 0.5 else lerp(colors[1], colors[2], (t - 0.5) * 2)
    img = img.resize((w, h), Image.BICUBIC)
    # 부드러운 빛 덩어리
    glow = Image.new('RGB', (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for _ in range(4):
        r = rnd.randint(w // 6, w // 3)
        x, y = rnd.randint(0, w), rnd.randint(0, h)
        gd.ellipse([x - r, y - r, x + r, y + r], fill=lerp(colors[2], (255, 255, 255), 0.25))
    glow = glow.filter(ImageFilter.GaussianBlur(w // 10))
    img = Image.blend(img, Image.composite(glow, img, glow.convert('L')), 0.4)
    # 미세 노이즈
    noise = Image.effect_noise((w, h), 18).convert('RGB')
    img = Image.blend(img, noise, 0.05)
    # 비네트
    vig = Image.new('L', (w, h), 0)
    ImageDraw.Draw(vig).ellipse([-w * 0.2, -h * 0.3, w * 1.2, h * 1.3], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(w // 6))
    dark = Image.blend(img, Image.new('RGB', (w, h), (0, 0, 0)), 0.55)
    return Image.composite(img, dark, vig)


def fit_cover(src, w, h):
    sw, sh = src.size
    s = max(w / sw, h / sh)
    img = src.resize((int(sw * s) + 1, int(sh * s) + 1), Image.LANCZOS)
    x = (img.width - w) // 2
    y = (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def wrap(draw, text, fnt, maxw):
    words = text.split(' ')
    lines, cur = [], ''
    for wd in words:
        t = (cur + ' ' + wd).strip()
        if draw.textlength(t, font=fnt) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines[:3]


def strip_symbols(s):
    """글꼴에 없는 이모지/기호(두부 글자 방지) 제거"""
    out = []
    for ch in s:
        o = ord(ch)
        if o >= 0x1F000 or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF or o in (0xFE0F, 0x200D):
            continue
        out.append(ch)
    return ' '.join(''.join(out).split())


def draw_title(img, title, subtitle, st, fontpath):
    title = strip_symbols(title)
    subtitle = strip_symbols(subtitle or '')
    w, h = img.size
    d = ImageDraw.Draw(img, 'RGBA')
    size = int(h * 0.13)
    f = font(size, fontpath)
    lines = wrap(d, title, f, int(w * 0.84))
    while len(lines) > 2 and size > 30:
        size = int(size * 0.88)
        f = font(size, fontpath)
        lines = wrap(d, title, f, int(w * 0.84))
    lh = int(size * 1.18)
    sub_h = int(h * 0.11) if subtitle else int(h * 0.03)
    total = lh * len(lines) + sub_h
    y0 = (h - total) // 2
    d.rectangle([0, y0 - int(h * 0.05), w, y0 + total + int(h * 0.05)], fill=(0, 0, 0, 95))
    y = y0
    for ln in lines:
        tw = d.textlength(ln, font=f)
        x = (w - tw) // 2
        d.text((x + 4, y + 4), ln, font=f, fill=(0, 0, 0, 170))
        d.text((x, y), ln, font=f, fill=st['text'])
        y += lh
    y += int(h * 0.02)
    d.rectangle([w * 0.44, y, w * 0.56, y + int(h * 0.007)], fill=st['accent'])
    if subtitle:
        fs = font(int(h * 0.045), fontpath)
        tw = d.textlength(subtitle, font=fs)
        d.text(((w - tw) // 2, y + int(h * 0.02)), subtitle, font=fs, fill=st['accent'])
    return img


def darken_photo(path, W, H):
    """사진을 1920x1080으로 맞추고 자막 가독성을 위해 어둡게 + 하단 그라데이션"""
    base = fit_cover(Image.open(path).convert('RGB'), W, H)
    base = Image.blend(base, Image.new('RGB', (W, H), (0, 0, 0)), 0.32)
    grad = Image.new('L', (1, H), 0)
    for yy in range(H):
        grad.putpixel((0, yy), int(max(0, (yy - H * 0.72) / (H * 0.28)) * 140))
    return Image.composite(Image.new('RGB', (W, H), (0, 0, 0)), base, grad.resize((W, H)))


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    st = STYLES.get(spec.get('style') or 'night', STYLES['night'])
    seed = spec.get('seed', 1)
    W, H = 1920, 1080
    bg = spec.get('background_image')
    slides_out = []
    if spec.get('slides'):
        # 슬라이드쇼: 각 사진을 어둡게 처리해 slides_dir 에 저장, 첫 장을 대표 배경으로
        os.makedirs(spec['slides_dir'], exist_ok=True)
        for i, p in enumerate(spec['slides']):
            if not os.path.exists(p):
                continue
            outp = os.path.join(spec['slides_dir'], f'slide_{i + 1:02d}.png')
            darken_photo(p, W, H).save(outp)
            slides_out.append(outp)
        base = Image.open(slides_out[0]).convert('RGB') if slides_out else gradient(W, H, st['colors'], seed)
    elif bg and os.path.exists(bg):
        base = darken_photo(bg, W, H)
    else:
        base = gradient(W, H, st['colors'], seed)
    base.save(spec['out_background'], quality=95)
    thumb = base.resize((1280, 720), Image.LANCZOS)
    thumb = draw_title(thumb, spec.get('title', ''), spec.get('subtitle', ''), st, spec.get('font'))
    thumb.convert('RGB').save(spec['out_thumbnail'], quality=92)
    print(json.dumps({'ok': True, 'background': spec['out_background'], 'thumbnail': spec['out_thumbnail'], 'slides': slides_out, 'styles': list(STYLES)}))


if __name__ == '__main__':
    main()
