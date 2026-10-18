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

# 두꺼운 한글 제목체(유튜브 썸네일 스타일). 프로젝트에 동봉(SIL OFL) → 한글·영문만 있음
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'fonts')
DISPLAY_FONTS = [os.path.join(FONT_DIR, 'BlackHanSans-Regular.ttf')]
# 제목체에 없는 글자(가나·한자·특수기호)가 있으면 쓰는 대체 글꼴
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\malgunbd.ttf', r'C:\Windows\Fonts\malgun.ttf', r'C:\Windows\Fonts\NotoSansKR-VF.ttf',
    r'C:\Windows\Fonts\arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']

_cover_cache = {}


def _covers(path, text):
    """글꼴 파일이 text의 모든 글자를 그릴 수 있는지(.notdef 마스크와 비교)"""
    try:
        ft = ImageFont.truetype(path, 40)
    except Exception:
        return False
    def sig(ch):  # \ub9c8\uc2a4\ud06c \ud06c\uae30\u00b7\uacbd\uacc4 \uc0c1\uc790\ub85c \uae00\ub9ac\ud504 \ubaa8\uc591\uc744 \ub300\ucda9 \uc2dd\ubcc4
        m = ft.getmask(ch)
        return (m.size, m.getbbox())
    notdef = sig('\uffff')
    for ch in set(text):
        if ch.isspace():
            continue
        key = (path, ch)
        if key not in _cover_cache:
            _cover_cache[key] = sig(ch) != notdef
        if not _cover_cache[key]:
            return False
    return True


def font(size, pref=None, text=''):
    """pref(사용자 지정) → 동봉 제목체(글자가 모두 있을 때만) → 시스템 볼드 순으로 고른다"""
    order = ([pref] if pref else []) + [f for f in DISPLAY_FONTS if _covers(f, text)] + FONT_CANDIDATES
    for f in order:
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
    # 공백 없는 긴 단어(한글 제목)는 글자 단위로 다시 끊는다
    out = []
    for ln in lines:
        while draw.textlength(ln, font=fnt) > maxw and len(ln) > 1:
            n = len(ln)
            while n > 1 and draw.textlength(ln[:n], font=fnt) > maxw:
                n -= 1
            out.append(ln[:n])
            ln = ln[n:]
        out.append(ln)
    return out[:3]


def balanced_lines(draw, text, fnt, maxw):
    """제목을 두 줄로 나눌 때 두 줄 폭이 비슷해지는 지점(단어 경계)에서 자른다.
    한 줄에 다 들어가고 짧으면 한 줄, 단어가 하나뿐이면 글자 단위 wrap."""
    words = text.split(' ')
    if len(words) < 2:
        return wrap(draw, text, fnt, maxw)
    whole = draw.textlength(text, font=fnt)
    if whole <= maxw * 0.6:
        return [text]
    best, best_w = None, None
    for i in range(1, len(words)):
        a, b = ' '.join(words[:i]), ' '.join(words[i:])
        mw = max(draw.textlength(a, font=fnt), draw.textlength(b, font=fnt))
        if best_w is None or mw < best_w:
            best, best_w = [a, b], mw
    if best_w <= maxw:
        return best
    return wrap(draw, text, fnt, maxw)  # 두 줄로도 안 들어가면 일반 wrap(호출 쪽에서 글자 크기를 줄인다)


def strip_symbols(s):
    """글꼴에 없는 이모지/기호(두부 글자 방지) 제거"""
    out = []
    for ch in s:
        o = ord(ch)
        if o >= 0x1F000 or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF or o in (0xFE0F, 0x200D):
            continue
        out.append(ch)
    return ' '.join(''.join(out).split())


TITLE_FILL = (255, 255, 255)          # 1줄째: 흰색
TITLE_ACCENT = (255, 228, 0)          # 2줄째: 노랑(참고 썸네일 스타일)
TITLE_STROKE = (10, 10, 14)           # 굵은 검정 외곽선
BADGE_BG = (255, 255, 255)
BADGE_FG = (20, 24, 40)


def stroked_text(img, xy, text, fnt, fill, stroke_w, shadow=True):
    """흰 글자 + 굵은 검정 외곽선 + 부드러운 그림자 (유튜브 썸네일 제목 스타일)"""
    w, h = img.size
    x, y = xy
    if shadow:
        off = max(2, int(stroke_w * 0.7))
        layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((x + off, y + off * 1.6), text, font=fnt, fill=(0, 0, 0, 150), stroke_width=stroke_w, stroke_fill=(0, 0, 0, 150))
        layer = layer.filter(ImageFilter.GaussianBlur(max(2, stroke_w)))
        img.alpha_composite(layer)
    ImageDraw.Draw(img).text((x, y), text, font=fnt, fill=fill, stroke_width=stroke_w, stroke_fill=TITLE_STROKE)


def draw_badge(img, text, fontpath):
    """좌상단 작은 라벨(흰 둥근 상자 + 진한 글자): 곡 수·길이 또는 사용자 부제"""
    if not text:
        return
    w, h = img.size
    text = text.replace('·', '|')  # 제목체에 없는 가운뎃점은 세로줄로
    fs = font(int(h * 0.052), fontpath, text)
    d = ImageDraw.Draw(img, 'RGBA')
    tw = d.textlength(text, font=fs)
    bb = fs.getbbox(text)
    th = bb[3] - bb[1]
    px, py = int(h * 0.025), int(h * 0.014)
    x0, y0 = int(w * 0.03), int(h * 0.045)
    box = [x0, y0, x0 + tw + px * 2, y0 + th + py * 2]
    sh = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([box[0] + 3, box[1] + 5, box[2] + 3, box[3] + 5], radius=int(h * 0.014), fill=(0, 0, 0, 140))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(4)))
    d = ImageDraw.Draw(img, 'RGBA')
    d.rounded_rectangle(box, radius=int(h * 0.014), fill=BADGE_BG)
    d.text((x0 + px, y0 + py - bb[1]), text, font=fs, fill=BADGE_FG)


def draw_title(img, title, subtitle, st, fontpath):
    """참고 썸네일 스타일: 아주 두꺼운 제목체, 흰 글자 + 검정 외곽선, 2줄째 노랑, 좌상단 라벨.
    배경을 가리는 띠는 두지 않고, 외곽선·그림자로 가독성을 확보한다."""
    title = strip_symbols(title)
    subtitle = strip_symbols(subtitle or '')
    img = img.convert('RGBA')
    w, h = img.size
    d = ImageDraw.Draw(img)
    maxw = int(w * 0.90)
    size = int(h * 0.20)
    while True:
        f = font(size, fontpath, title)
        lines = balanced_lines(d, title, f, maxw)
        if (len(lines) <= 2 and all(d.textlength(ln, font=f) <= maxw for ln in lines)) or size <= 40:
            break
        size = int(size * 0.92)
    stroke_w = max(3, int(size * 0.085))
    lh = int(size * 1.17)
    total = lh * len(lines)
    # 세로 중앙보다 조금 아래(유튜브 재생시간 표시가 있는 우하단은 피한다)
    y = (h - total) // 2 + int(h * 0.04)
    asc = f.getbbox('가')[1]  # 글자 위 여백 보정
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=f)
        x = (w - tw) // 2
        x = max(stroke_w + 4, min(x, w - tw - stroke_w - 4))
        fill = TITLE_ACCENT if (i == 1 and len(lines) > 1) else TITLE_FILL
        stroked_text(img, (x, y - asc), ln, f, fill, stroke_w)
        y += lh
    draw_badge(img, subtitle, fontpath)
    return img


def thumb_photo(path, W, H):
    """썸네일용: 사진을 살짝만 어둡게 + 가장자리 비네트. 글자 가독성은 외곽선이 맡으므로 영상 배경보다 밝게 둔다"""
    base = fit_cover(Image.open(path).convert('RGB'), W, H)
    base = Image.blend(base, Image.new('RGB', (W, H), (0, 0, 0)), 0.12)
    vig = Image.new('L', (W, H), 0)
    ImageDraw.Draw(vig).ellipse([-W * 0.15, -H * 0.25, W * 1.15, H * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(W // 6))
    dark = Image.blend(base, Image.new('RGB', (W, H), (0, 0, 0)), 0.45)
    return Image.composite(base, dark, vig)


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
    thumb_src = None  # 썸네일에 쓸 원본 사진(있으면)
    if spec.get('slides'):
        # 슬라이드쇼: 각 사진을 어둡게 처리해 slides_dir 에 저장, 첫 장을 대표 배경으로
        os.makedirs(spec['slides_dir'], exist_ok=True)
        for i, p in enumerate(spec['slides']):
            if not os.path.exists(p):
                continue
            outp = os.path.join(spec['slides_dir'], f'slide_{i + 1:02d}.png')
            darken_photo(p, W, H).save(outp)
            slides_out.append(outp)
            thumb_src = thumb_src or p
        base = Image.open(slides_out[0]).convert('RGB') if slides_out else gradient(W, H, st['colors'], seed)
    elif bg and os.path.exists(bg):
        base = darken_photo(bg, W, H)
        thumb_src = bg
    else:
        base = gradient(W, H, st['colors'], seed)
    base.save(spec['out_background'], quality=95)
    thumb = thumb_photo(thumb_src, 1280, 720) if thumb_src else base.resize((1280, 720), Image.LANCZOS)
    thumb = draw_title(thumb, spec.get('title', ''), spec.get('subtitle', ''), st, spec.get('font'))
    thumb.convert('RGB').save(spec['out_thumbnail'], quality=92)
    print(json.dumps({'ok': True, 'background': spec['out_background'], 'thumbnail': spec['out_thumbnail'], 'slides': slides_out, 'styles': list(STYLES)}))


if __name__ == '__main__':
    main()
