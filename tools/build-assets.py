"""build-assets.py - builds the game's runtime art in assets/ from the parent Superfans folder.

Re-runnable. Reads (never writes) ../images, ../Rulebook/assets, ../AI-Art, ../TTS, ../Sell Sheet and, via
psd_tools, three PSDs in ../pieces (Game Board v11, standees v1, Icons v1) plus Website Logo v1.
Writes web-sized WebP files (each <= 200 KB) and assets/manifest.json and assets/STILL-NEEDED.md.

Usage (run with -I, from anywhere):
    python -I tools/build-assets.py              # everything
    python -I tools/build-assets.py --skip-psd   # leave PSD-derived files alone (fast); their manifest
                                                 # entries are carried over from the existing manifest

Manifest ids (the UI asks for art by id; nothing else knows a path):
    card-celebrity-<franchise>-<nn>   nn 01=rank C, 02=B, 03=A       card-achievement-<nn>
    card-swag-<green|red|orange>-<nn> (file colour words blue/pink/grey are mapped here)
    card-club-<nn>  card-pass  card-aid-<actions|gifts|parade>
    back-celebrity-<a|b|c>  back-achievement  back-swag-<colour>  back-club  back-pass  back-aid
    board-full  hall-<slug>  icon-*  token-*  marker-*  portrait-celebrity-*  logo-*  cover-*  scene-*  ui-*
    placeholder-*  (labelled stand-ins for art that does not exist yet; see STILL-NEEDED.md)
"""
import io
import json
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
PARENT = REPO.parent
ASSETS = REPO / "assets"
MAX_BYTES = 200_000
TARGET_BYTES = 192_000          # aim a little under the hard cap
SKIP_PSD = "--skip-psd" in sys.argv

GAME_BOARD_PSD = "pieces/Game Board v11.psd"
STANDEES_PSD = "pieces/standees v1.psd"
ICONS_PSD = "pieces/Icons v1.psd"
LOGO_PSD = "pieces/Website Logo v1.psd"

entries = []          # manifest rows
still_needed = []     # rows for STILL-NEEDED.md
carried_psd = []      # PSD-derived rows carried over when --skip-psd


# ---------------------------------------------------------------- helpers
def rel(p):
    return str(Path(p).as_posix())


def open_src(rel_path):
    p = PARENT / rel_path
    if not p.exists():
        raise FileNotFoundError(f"source missing: {p}")
    return Image.open(p)


def encode(img, quality):
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality, method=6, alpha_quality=92)
    return buf.getvalue()


def fit_webp(img, out_rel, size=None, max_side=None, qualities=(84, 78, 72, 66, 60, 54)):
    """Resize (exact `size` or `max_side` longest edge), encode WebP <= TARGET_BYTES, shrinking if needed."""
    img = img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")
    if size:
        img = img.resize(size, Image.LANCZOS)
    elif max_side and max(img.size) > max_side:
        k = max_side / max(img.size)
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    cur = img
    for _ in range(8):
        for q in qualities:
            data = encode(cur, q)
            if len(data) <= TARGET_BYTES:
                out = ASSETS / out_rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
                return cur.width, cur.height, len(data)
        cur = cur.resize((round(cur.width * 0.9), round(cur.height * 0.9)), Image.LANCZOS)
    raise RuntimeError(f"cannot fit {out_rel} under {MAX_BYTES} bytes")


def add(id_, file_, wh_b, status, source, shows, used_in, first_paint=False, notes=None, stale=None):
    w, h, b = wh_b
    row = {"id": id_, "file": file_, "width": w, "height": h, "bytes": b, "status": status,
           "source": source, "shows": shows, "usedIn": used_in}
    if first_paint:
        row["firstPaint"] = True
    if stale:
        row["staleText"] = stale
    if notes:
        row["notes"] = notes
    entries.append(row)
    return row


def trim_alpha(img, pad=0):
    img = img.convert("RGBA")
    bb = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bb:
        img = img.crop((max(0, bb[0] - pad), max(0, bb[1] - pad), min(img.width, bb[2] + pad), min(img.height, bb[3] + pad)))
    return img


def tint(img, rgb):
    """Multiply-tint a greyscale clay piece so its brightest areas reach `rgb`."""
    img = img.convert("RGBA")
    a = np.asarray(img).astype(np.float32)
    lum = a[..., :3].mean(axis=2)
    opaque = a[..., 3] > 128
    top = np.percentile(lum[opaque], 95) if opaque.any() else 255
    k = 255.0 / max(top, 1)
    out = a.copy()
    for c in range(3):
        out[..., c] = np.clip(a[..., c] * k * (rgb[c] / 255.0), 0, 255)
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def hue_shift_red(img, shift):
    """Rotate hue only on red/red-brown pixels (keeps the yellow star and neutral greys)."""
    img = img.convert("RGBA")
    rgb, alpha = img.convert("RGB"), img.getchannel("A")
    hsv = np.asarray(rgb.convert("HSV")).astype(np.int32)
    h, s = hsv[..., 0], hsv[..., 1]
    m = (s > 55) & ((h <= 16) | (h >= 238))
    hsv[..., 0] = np.where(m, (h + shift) % 256, h)
    out = Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB")
    out.putalpha(alpha)
    return out


def retouch_coffee(cup):
    """Remove the red 'Mojo' lettering from the cup sleeve by fitting a smooth beige surface over it."""
    import cv2
    a = np.asarray(cup.convert("RGBA")).astype(np.float32)
    h, w = a.shape[:2]
    rgb, al = a[..., :3], a[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    beige = (r > 180) & (g > 145) & (b > 110) & (np.abs((r - g) - 35) < 25) & (al > 200)
    y0, y1 = int(h * 0.409), int(h * 0.702)               # sleeve band (cup is ~484x690)
    yy = np.mgrid[:h, :w][0]
    band = (yy >= y0) & (yy <= y1) & (al > 128)
    inner = cv2.erode((al > 128).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    mask0 = band & ~beige & inner
    mask = cv2.dilate(mask0.astype(np.uint8), np.ones((9, 9), np.uint8), iterations=2) & (band & inner).astype(np.uint8)
    good = beige & (cv2.dilate(mask0.astype(np.uint8), np.ones((15, 15), np.uint8)) == 0) & band & inner
    ys, xs = np.where(good)

    def feats(x, y):
        x, y = (x - w / 2) / w, (y - (y0 + y1) / 2) / (y1 - y0)
        return np.stack([np.ones_like(x), x, y, x * y, x ** 2, y ** 2, x ** 2 * y, x * y ** 2, x ** 3, y ** 3], 1)

    A = feats(xs.astype(np.float32), ys.astype(np.float32))
    my, mx = np.where(mask > 0)
    F = feats(mx.astype(np.float32), my.astype(np.float32))
    out = rgb.copy()
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A, rgb[ys, xs, c], rcond=None)
        out[my, mx, c] = F @ coef
    mf = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1.5)[..., None]
    filled = rgb * (1 - mf) + out * mf
    noise = cv2.GaussianBlur(np.random.default_rng(1).normal(0, 8, (h, w)).astype(np.float32), (0, 0), 1.8)[..., None]
    filled = np.clip(filled + noise * mf, 0, 255)
    return Image.fromarray(np.dstack([filled, al]).astype(np.uint8), "RGBA")


def placeholder_image(label, size, kind="PLACEHOLDER", base=(222, 226, 232)):
    w, h = size
    im = Image.new("RGB", size, base)
    d = ImageDraw.Draw(im)
    step = max(12, w // 14)
    for x in range(-h, w, step):
        d.line([(x, h), (x + h, 0)], fill=(205, 210, 220), width=max(1, step // 6))
    d.rectangle([2, 2, w - 3, h - 3], outline=(120, 128, 140), width=max(2, w // 80))
    fs = max(10, w // 14)
    try:
        font = ImageFont.load_default(size=fs)
        small = ImageFont.load_default(size=max(9, fs * 2 // 3))
    except TypeError:
        font = small = ImageFont.load_default()
    words = label.replace("-", " ").upper().split()
    lines, cur = [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if d.textlength(t, font=font) > w * 0.86 and cur:
            lines.append(cur)
            cur = wd
        else:
            cur = t
    lines.append(cur)
    total = len(lines) * (fs + 4) + fs
    y = (h - total) // 2
    for ln in lines:
        d.text(((w - d.textlength(ln, font=font)) / 2, y), ln, fill=(60, 66, 80), font=font)
        y += fs + 4
    d.text(((w - d.textlength(kind, font=small)) / 2, y + 4), kind, fill=(170, 60, 60), font=small)
    return im


def add_placeholder(id_, label, size, status, shows, used_in, desc, prompt, notes=None):
    file_ = f"placeholders/{id_}.webp"
    wh = fit_webp(placeholder_image(label, size), file_)
    add(id_, file_, wh, status, "generated placeholder (tools/build-assets.py)", shows, used_in, notes=notes)
    still_needed.append({"id": id_, "status": status, "desc": desc, "prompt": prompt})


# ---------------------------------------------------------------- card data
CARD = json.loads((PARENT / "_catalogue" / "card-data.json").read_text(encoding="utf8"))
BIG, SMALL = (500, 750), (360, 544)


def build_cards():
    back_for_rank = {"A": "back-celebrity-a", "B": "back-celebrity-b", "C": "back-celebrity-c"}
    # --- backs
    backs = [
        ("back-celebrity-a", "images/character_back_a.png", BIG, "Celebrity back, rank A (Follywood sign, A in a circle)"),
        ("back-celebrity-b", "images/character_back_b.png", BIG, "Celebrity back, rank B"),
        ("back-celebrity-c", "images/character_back_c.png", BIG, "Celebrity back, rank C"),
        ("back-achievement", "images/scoring_back.png", SMALL, "Achievement back (trophy on tan)"),
        ("back-swag-green", "images/swag_back_blue.png", SMALL, "Green Swag back (file colour word is 'blue')"),
        ("back-swag-red", "images/swag_back_pink.png", SMALL, "Red Swag back (file colour word is 'pink')"),
        ("back-swag-orange", "images/swag_back_grey.png", SMALL, "Orange Swag back (file colour word is 'grey')"),
        ("back-club", "images/club_card_back.png", BIG, "Club back (collage of fan archetypes on yellow)"),
        ("back-pass", "images/card_pass_back.png", BIG, "Pass card back (Relaxation Station)"),
        ("back-aid", "images/player_aid_back.png", BIG, "Player aid back (INFO desk, red question mark)"),
    ]
    for id_, src, size, shows in backs:
        fn = "cards/" + id_ + ".webp"
        add(id_, fn, fit_webp(open_src(src), fn, size=size), "real", src, shows, "card backs, deck piles, card flips")

    # --- celebrities
    for c in CARD["decks"]["celebrities"]:
        m = re.match(r"character_(.+)_(\d\d)$", c["id"])
        key = f"{m.group(1).replace('_', '-')}-{m.group(2)}"
        fn = f"cards/celebrity-{key}.webp"
        src = c["art"]
        add(f"card-celebrity-{key}", fn, fit_webp(open_src(src), fn, size=BIG), "real", src,
            f"Celebrity card: {c['name']} ({c['franchise']}, rank {c['rank']}); canvas normalised to 945x1417 then shrunk",
            "celebrity hand/preview, walk panel, card zoom", stale=c.get("stale_terms") or None,
            notes=f"card-data id {c['id']}; rank {c['rank']}; back id {back_for_rank[c['rank']]}")
    # --- achievements
    for c in CARD["decks"]["achievements"]:
        n = f"{c['number']:02d}"
        fn = f"cards/achievement-{n}.webp"
        add(f"card-achievement-{n}", fn, fit_webp(open_src(c["art"]), fn, size=SMALL), "real", c["art"],
            f"Achievement {c['number']}: {c['name']}", "achievement hand, scoring screen, card zoom",
            stale=c.get("stale_terms") or None, notes=f"card-data id {c['id']}")
    # --- swag
    for c in CARD["decks"]["swag"]:
        m = re.match(r"swag_(green|red|orange)_(\d\d)$", c["id"])
        key = f"{m.group(1)}-{m.group(2)}"
        fn = f"cards/swag-{key}.webp"
        add(f"card-swag-{key}", fn, fit_webp(open_src(c["art"]), fn, size=SMALL), "real", c["art"],
            f"{m.group(1).capitalize()} Swag: {c['name']} (file uses colour word '{c['file_colour_word']}')",
            "swag market, swag hand, card zoom", stale=c.get("stale_terms") or None, notes=f"card-data id {c['id']}")
    # --- clubs
    for c in CARD["decks"]["clubs"]:
        n = c["id"].split("_")[1]
        fn = f"cards/club-{n}.webp"
        add(f"card-club-{n}", fn, fit_webp(open_src(c["art"]), fn, size=BIG), "real", c["art"],
            f"Club card {n}: {c['name']} (power: {c.get('power_name')})", "club row, club zoom",
            stale=c.get("stale_terms") or None, notes=f"card-data id {c['id']}")
    # --- pass card
    p = CARD["decks"]["pass_card"][0]
    fn = "cards/pass.webp"
    add("card-pass", fn, fit_webp(open_src(p["art"]), fn, size=BIG), "real", p["art"],
        "Pass card (pass ladder: first pass 2 coffee, then 1 coffee or 1 VP ...)", "pass ladder, help",
        stale=p.get("stale_terms") or ["MOJO (cup icons)"], notes="card-data id card_pass_actions")
    # --- aids
    for a in CARD["decks"]["player_aids"]:
        if a["id"] == "player_aid_back":
            continue
        k = a["id"].replace("player_aid_", "")
        fn = f"cards/aid-{k}.webp"
        add(f"card-aid-{k}", fn, fit_webp(open_src(a["art"]), fn, size=BIG), "real", a["art"],
            f"Player aid face '{a['name']}' (printed)", "help panel (the UI may replace these with HTML)",
            stale=a.get("stale_terms") or ["Selfy / Noob / MOJO (see asset map)"], notes=f"card-data id {a['id']}")


# ---------------------------------------------------------------- board (PNG) and plain sources
def build_board_and_misc():
    src = "images/Game Board.png"
    Image.MAX_IMAGE_PIXELS = None
    img = open_src(src).convert("RGB")
    fn = "board/board-full.webp"
    add("board-full", fn, fit_webp(img, fn, max_side=2000, qualities=(80, 74, 68, 62, 56, 50, 44)), "real", src,
        "Whole printed board (3x3 halls, score track, swag slots, selfie exchange). Stale: prints 7 queue slots "
        "(rulebook 5/7/8), MOJO cup on the exchange, no hall names. Use as a backdrop; draw queues in code.",
        "play area backdrop", first_paint=True, stale=["7 queue slots", "MOJO cup on Selfie Exchange"],
        notes="Hall art tiles (hall-*) are separate, clean exports from the PSD for laying out your own board.")

    for name, src, ms, id_, shows, used in [
        ("cover", "Rulebook/assets/cover.jpg", 1200, "cover-box", "Box cover / title art (clay fans at a convention)", "landing page, splash"),
        ("logo-wordmark", "Sell Sheet/v3_assets/logo.jpg", 1000, "logo-wordmark", "SUPERFANS clay wordmark, wide strip with three fans", "header, landing page"),
    ]:
        fn = f"ui/{name}.webp"
        add(id_, fn, fit_webp(open_src(src), fn, max_side=ms), "real", src, shows, used, first_paint=(id_ == "logo-wordmark"))


def build_player_colours_and_tints():
    colours = {}
    for name in ["blue", "gold", "green", "orange", "pink", "red", "yellow", "bronze"]:
        rgb = open_src(f"TTS/colour_{name}.png").convert("RGB").getpixel((10, 10))
        colours[name] = "#%02x%02x%02x" % rgb
    meeple = open_src("Rulebook/assets/ic_meeple.png").convert("RGBA")
    fn = "tokens/crew-grey.webp"
    add("token-crew-grey", fn, fit_webp(meeple, fn), "real", "Rulebook/assets/ic_meeple.png",
        "Grey clay Crew meeple, untinted (150 px source; use at small sizes)", "board tokens", first_paint=True)
    for name, hexv in colours.items():
        rgb = tuple(int(hexv[i:i + 2], 16) for i in (1, 3, 5))
        fn = f"tokens/crew-{name}.webp"
        add(f"token-crew-{name}", fn, fit_webp(tint(meeple, rgb), fn), "real", "Rulebook/assets/ic_meeple.png + TTS/colour_swatches",
            f"Crew meeple tinted {name} ({hexv})", "board tokens, player panels",
            notes="Derived: multiply-tint of the grey meeple. CSS filters would also work.")
    return colours


# ---------------------------------------------------------------- AI-Art scenes and icons
def build_ai_art():
    scenes = [
        ("scene-follywood", "AI-Art/Follywood.png", "FOLLYWOOD clay hill sign on green hills (hero banner)", "landing hero, loading screen"),
        ("scene-selfie-stick-squad", "AI-Art/Gemini_Generated_Image_1tr0af1tr0af1tr0.png", "Three clay fans with a selfie stick, 'SELFIE STICK SQUAD' sign", "landing page, selfie moment"),
        ("scene-card-traders", "AI-Art/Gemini_Generated_Image_bt7jvebt7jvebt7j.png", "Claymation Trading Card Traders Guild: crowded long tables, dragon on shelf", "landing page, club zoom backdrop"),
        ("scene-retro-gamers", "AI-Art/Gemini_Generated_Image_t4lgcot4lgcot4lg.png", "Claymation row of seated gamers with consoles", "ambience, setup screen"),
        ("scene-floor-plan", "AI-Art/Gemini_Generated_Image_5xjgat5xjgat5xjg.png", "Top-down claymation 3x3 convention floor plan (concept art, not the final board)", "ambience, how-to-play"),
        ("scene-info-desk", "AI-Art/Gemini_Generated_Image_ksu2cmksu2cmksu2.png", "Claymation INFO desk with two helpers and attendees holding cards", "help panel, tutorial"),
    ]
    for id_, src, shows, used in scenes:
        fn = f"scenes/{id_[6:]}.webp"
        add(id_, fn, fit_webp(open_src(src).convert("RGB"), fn, max_side=1280), "real", src, shows, used)
    small = [
        ("icon-entrance-sign", "AI-Art/Gemini_Generated_Image_apjvapjvapjvapjv.png", "Clay 'ENTRANCE' lettering over a brown archway with green arrow", "Entrance hall marker"),
        ("icon-hour-stopwatch", "AI-Art/Gemini_Generated_Image_zdjbbpzdjbbpzdjb.png", "Red clay stopwatch on a blue clay base", "Hour indicator"),
    ]
    for id_, src, shows, used in small:
        fn = f"icons/{id_[5:]}.webp"
        add(id_, fn, fit_webp(open_src(src).convert("RGB"), fn, max_side=384), "real", src, shows, used,
            first_paint=True, notes="Square tile on a background colour (not transparent).")


# ---------------------------------------------------------------- PSD extraction
HALLS = [  # PSD layer name -> (slug, row, col, PSD board label if it is known)
    ("clay_artists_alley", "artists-alley", 1, 1, "Artist's Alley"),
    ("clay_main_stage", "main-stage", 1, 2, "Main Stage"),
    ("clay_cosplay_corner", "cosplay-corner", 1, 3, "Cosplay Corner"),
    ("clay_autograph_hall", "autograph-hall", 2, 1, "Autographs"),
    ("clay_main_hall", "main-hall", 2, 2, "Main Hall"),
    ("clay_vendor_hall", "vendor-hall", 2, 3, "Vendor Hall"),
    ("clay_photo_op", "photo-op", 3, 1, "Photo Ops"),
    ("clay_registration", "registration", 3, 2, "Ticket Hall (bottom-middle; the Entrance row)"),
    ("clay_food", "food-trucks", 3, 3, "Food Trucks"),
]


def find_layers(layer, name, found=None):
    found = [] if found is None else found
    for x in layer:
        if x.name == name:
            found.append(x)
        if x.is_group():
            find_layers(x, name, found)
    return found


def build_psd_board():
    from psd_tools import PSDImage
    psd = PSDImage.open(PARENT / GAME_BOARD_PSD)
    for lname, slug, row, col, label in HALLS:
        layer = find_layers(psd, lname)[0]
        img = layer.composite().convert("RGB")           # 1240x1490, clean art, no queue strip
        fn = f"halls/hall-{slug}.webp"
        add(f"hall-{slug}", fn, fit_webp(img, fn, size=(620, 745), qualities=(80, 74, 68, 62, 56)), "real",
            f"{GAME_BOARD_PSD}#rooms/queues/{lname}",
            f"Clean claymation hall picture, grid row {row} col {col}. PSD board label: {label}.",
            "hall tiles in the board layout", first_paint=True,
            notes=f"grid row {row}, col {col}; PSD layer {lname}; name unconfirmed (see rulings)")
    # blank clay label plate (the hidden 'label' smart objects in room_labels)
    group = find_layers(psd, "room_labels")[0]
    plate = [x for x in group if x.name == "label" and x.visible][0].composite().convert("RGBA")  # hidden layers composite empty
    fn = "ui/hall-label-plate.webp"
    add("ui-hall-label-plate", fn, fit_webp(trim_alpha(plate), fn, max_side=420), "real",
        f"{GAME_BOARD_PSD}#room_labels/label", "Blank clay sign plate for hall names (text drawn in code)",
        "hall signs", first_paint=True)
    ent = find_layers(group, "entrance")[0].composite().convert("RGBA")
    fn = "ui/entrance-plate.webp"
    add("ui-entrance-plate", fn, fit_webp(trim_alpha(ent), fn, max_side=520), "real",
        f"{GAME_BOARD_PSD}#room_labels/entrance", "Clay plate printed on the board for the Entrance", "entrance marker", first_paint=True)


def build_psd_standees():
    from psd_tools import PSDImage
    psd = PSDImage.open(PARENT / STANDEES_PSD)
    for layer in psd:
        m = re.match(r"standee_character_(.+)_(\d\d)$", layer.name)
        key = f"{m.group(1).replace('_', '-')}-{m.group(2)}"
        img = layer.composite().convert("RGB")
        fn = f"portraits/celebrity-{key}.webp"
        add(f"portrait-celebrity-{key}", fn, fit_webp(img, fn, size=(360, 660)), "real", f"{STANDEES_PSD}#{layer.name}",
            f"Full-body clay portrait of celebrity {key} on its scene backdrop (NOT a cut-out)",
            "walk panel, celebrity tokens (circle-cropped), results screen",
            notes="Standee art as laid out in the PSD: figure plus background, 360x660. A transparent cut-out figure is still needed (STILL-NEEDED).")


ICON_LAYERS = {   # (index in Icons v1 top level, expected name) -> (id, file, max_side, shows, used)
    (0, "star"): ("icon-star", "icons/star.webp", 256, "Gold clay star (Prime Position / star marker)", "queue slot 1, scoring"),
    (1, "tick"): ("icon-tick", "icons/tick.webp", 192, "Green clay tick", "confirm, achievement met"),
    (5, "clipboard"): ("icon-security", "icons/security.webp", 192, "Clay clipboard (Security volunteer space)", "hall volunteer spaces"),
    (6, "camera"): ("icon-photographer", "icons/photographer.webp", 192, "Blue clay camera (Photographer volunteer space)", "hall volunteer spaces, selfie moment"),
    (7, "trophy"): ("icon-trophy", "icons/trophy.webp", 192, "Gold clay trophy (Achievements)", "achievement deck, scoring"),
    (9, "vp"): ("icon-vp", "icons/vp.webp", 192, "Green clay laurel wreath (victory points)", "score displays"),
    (10, "velvet_rope"): ("icon-usher", "icons/usher.webp", 192, "Clay velvet rope stanchions (Usher volunteer space)", "hall volunteer spaces, queue ropes"),
    (11, "gift"): ("icon-gift", "icons/gift.webp", 192, "Blue clay gift box", "swag gifts"),
    (12, "ticket_regular"): ("icon-badge-noob", "icons/badge-noob.webp", 192, "Grey clay ADMIT ONE ticket (N00b badge)", "Crew badge"),
    (13, "ticket_vip"): ("icon-badge-vip", "icons/badge-vip.webp", 192, "Gold clay VIP ticket (VIP badge)", "Crew badge"),
    (14, "ticket_aaa"): ("icon-badge-aaa", "icons/badge-aaa.webp", 192, "Red clay AAA ticket (AAA badge)", "Crew badge"),
    (15, "footprints"): ("icon-footprints", "icons/footprints.webp", 192, "Clay footprints (movement)", "move action"),
    (17, "rest"): ("icon-rest", "icons/rest.webp", 192, "Clay figure asleep on a bench with Zzz (Pass / Relaxation Station)", "pass action"),
    (26, "action_move"): ("icon-move-arrows", "icons/move-arrows.webp", 192, "Four clay arrows around a block", "move action"),
    (28, "cross"): ("icon-cross", "icons/cross.webp", 192, "Red clay cross (denied / full)", "blocked actions"),
    (29, "coffee_lid"): ("icon-coffee-lid", "icons/coffee-lid.webp", 192, "White clay coffee-cup lid, top-down (clean, no lettering)", "alternative coffee glyph"),
    (33, "insider"): ("icon-volunteer", "icons/volunteer.webp", 192, "Grey clay STAFF T-shirt (Volunteer)", "volunteer action, volunteer pieces"),
    (35, "swag"): ("icon-swag-green", "icons/swag-green.webp", 192, "Boxed collectible with a green-blue Blobby figure ('COLLECTIBLE')", "green Swag"),
    (36, "swag_pink"): ("icon-swag-red", "icons/swag-red.webp", 192, "Boxed collectible with a pink/red Blobby figure", "red Swag"),
    (37, "swag_orange"): ("icon-swag-orange", "icons/swag-orange.webp", 192, "Boxed collectible with an orange Blobby figure", "orange Swag"),
    (53, "selfie_movie"): ("icon-selfie-green", "icons/selfie-green.webp", 192, "Green clay polaroid with thumbs-up (green Selfie)", "selfie tokens, exchange"),
    (54, "selfie_tv"): ("icon-selfie-red", "icons/selfie-red.webp", 192, "Pink/red clay polaroid with heart (red Selfie)", "selfie tokens, exchange"),
    (55, "selfie_comic"): ("icon-selfie-orange", "icons/selfie-orange.webp", 192, "Orange clay polaroid with star (orange Selfie)", "selfie tokens, exchange"),
}


def build_psd_icons():
    from psd_tools import PSDImage
    psd = PSDImage.open(PARENT / ICONS_PSD)
    layers = list(psd)
    for (idx, name), (id_, fn, ms, shows, used) in ICON_LAYERS.items():
        layer = layers[idx]
        assert layer.name == name, f"Icons v1 layer {idx} is {layer.name!r}, expected {name!r}; the PSD changed"
        img = trim_alpha(layer.composite())
        add(id_, fn, fit_webp(img, fn, max_side=ms), "real", f"{ICONS_PSD}#{name}", shows, used, first_paint=True)

    # clean coffee cup: the 'mojo' layer with the lettering retouched out of the sleeve
    mojo = layers[16]
    assert mojo.name == "mojo"
    cup = trim_alpha(retouch_coffee(mojo.composite()))
    fn = "icons/coffee.webp"
    add("icon-coffee", fn, fit_webp(cup, fn, max_side=192), "real", f"{ICONS_PSD}#mojo (lettering retouched out)",
        "Clay takeaway coffee cup with a plain beige sleeve (the 'Mojo' lettering removed by script)", "coffee dial, costs, coffee gains",
        first_paint=True,
        notes="Derived from the MOJO icon with the sleeve text painted over (smooth fit). Check close up; fall back to icon-coffee-lid.")

    # destination markers: the red director's chair, hue-shifted for the other two colours
    chair = trim_alpha(layers[38].composite())
    assert layers[38].name == "celebrity_location"
    for colour, shift in (("red", 0), ("green", 86), ("orange", 20)):
        img = chair if shift == 0 else hue_shift_red(chair, shift)
        fn = f"markers/destination-{colour}.webp"
        add(f"marker-destination-{colour}", fn, fit_webp(img, fn, max_side=192), "real",
            f"{ICONS_PSD}#celebrity_location" + ("" if shift == 0 else " (hue-shifted)"),
            f"Director's chair with a gold star, {colour} (celebrity destination marker)",
            "hall destination marker for the celebrity's colour", first_paint=True,
            notes="Celebrity colours are an open ruling (D3). Green and orange are recoloured by script from the red chair.")

    # the exported TTS blank chair outline etc. are not needed.


def build_psd_logo():
    from psd_tools import PSDImage
    img = PSDImage.open(PARENT / LOGO_PSD).composite().convert("RGB")
    fn = "ui/logo-title.webp"
    add("logo-title", fn, fit_webp(img, fn, max_side=1400), "real", LOGO_PSD,
        "SUPERFANS clay title lettering over three excited fans in a convention hall (2423x1184 source)",
        "landing page hero, title screen")


# ---------------------------------------------------------------- placeholders for what is missing
def build_placeholders():
    sq = (256, 256)
    add_placeholder("placeholder-generic", "image missing", (256, 256), "placeholder", "Generic stand-in when an id has no art",
                    "any broken image", "(fallback only)", "-")
    still_needed.pop()   # the generic one is not a gap
    for colour in ("green", "red", "orange"):
        add_placeholder(f"placeholder-figure-celebrity-{colour}", f"celebrity figure {colour}", (256, 480), "placeholder",
                        f"Cut-out celebrity figure on a {colour} base", "celebrity token walking the hall route",
                        f"Transparent cut-out standee figure on a {colour} base, one per celebrity colour (the 18 portraits exist only on scene backdrops)",
                        f"Claymation convention celebrity standee on a {colour} round base, full body, transparent or plain background, 3/4 view, in the house clay style")
    add_placeholder("placeholder-marker-first-player", "first player marker", sq, "placeholder",
                    "First Player marker", "start-of-Hour first player token",
                    "First Player marker (3D model only: 'jumbo worker.stl')",
                    "A big gold clay Crew meeple wearing a tiny crown or sash, on a plain background, claymation style")
    add_placeholder("placeholder-overlay-vip-hat", "VIP hat overlay", sq, "placeholder", "VIP hat for a Crew piece",
                    "VIP Crew rendering", "VIP hat overlay (3D only: Hats v1.3mf). The badge ticket can be used meanwhile",
                    "A small clay top hat in gold, front view, plain background, claymation style, to sit on a meeple")
    add_placeholder("placeholder-overlay-aaa-box", "AAA box overlay", sq, "placeholder", "AAA box for a Crew piece",
                    "AAA Crew rendering", "AAA box/pedestal overlay (3D only). The badge ticket can be used meanwhile",
                    "A small red clay star-shaped podium box for a meeple to stand on, plain background, claymation style")
    for id_, label, desc, prompt in [
        ("placeholder-marker-pass", "pass marker", "Pass marker: trivially a player-coloured disc drawn in code", "Small clay disc marker, plain background"),
        ("placeholder-marker-score", "score marker", "Score marker: player-coloured disc/cube drawn in code", "Small clay cube marker, plain background"),
        ("placeholder-marker-hour", "hour markers 1-5", "Hour markers 1-5 (12pm to 4pm): draw in code; Clock Faces.psd has type only", "Five clay clock-face discs reading 12 to 4, plain background"),
    ]:
        add_placeholder(id_, label, (192, 192), "missing", label, "draw in code (shown only if code does not)", desc, prompt,
                        notes="status 'missing': the UI should draw this in code; this file only prevents a broken image")


def write_manifest(colours):
    out = {
        "version": 1,
        "generated": date.today().strftime("%d/%m/%Y"),
        "generatedBy": "tools/build-assets.py",
        "idRules": __doc__.split("Manifest ids")[1].split('"""')[0].strip() if "Manifest ids" in __doc__ else "",
        "maxFileBytes": MAX_BYTES,
        "playerColours": colours,
        "assets": entries,
    }
    (ASSETS / "manifest.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf8", newline="\n")


def write_still_needed():
    stale = [(e["id"], e["staleText"]) for e in entries if e.get("staleText")]
    lines = ["# Still needed", "",
             "Generated by `tools/build-assets.py` (do not edit by hand). Status `placeholder` = the UI shows a labelled stand-in;",
             "`missing` = draw it in code (the stand-in only prevents a broken image).", "",
             "Generate with `/generate-art` (project art skill `superfans-art`, house claymation style).", "",
             "## Missing art", "", "| Manifest id | Status | What is needed | Suggested generate-art subject |", "|---|---|---|---|"]
    for r in still_needed:
        lines.append(f"| `{r['id']}` | {r['status']} | {r['desc']} | {r['prompt']} |")
    lines += ["", "## Open art decisions", "",
              "- `icon-coffee` is a scripted retouch of the MOJO cup (lettering painted out). If it looks wrong close up, use `icon-coffee-lid` or commission a clean cup.",
              "- `marker-destination-green` and `-orange` are hue-shifted from the red director's chair; celebrity colours are unresolved (D3).",
              "- `portrait-celebrity-*` are scene portraits, not cut-outs; a circular crop works for tokens.",
              "- `board-full` still prints 7 queue slots and a MOJO exchange cup; hall tiles are clean and separate.",
              "- Player colours come from `TTS/colour_*.png` swatches (`playerColours` in the manifest); pure red/pink/yellow are garish, pick the five seat colours deliberately.",
              "", "## Printed card art that still shows stale terms (reprint pass, not blocking)", ""]
    groups = {}
    for i, t in stale:
        groups.setdefault(", ".join(t), []).append(i)
    for term, ids in groups.items():
        lines.append(f"- **{term}**: {len(ids)} assets ({', '.join(f'`{i}`' for i in ids[:6])}{' ...' if len(ids) > 6 else ''})")
    (ASSETS / "STILL-NEEDED.md").write_text("\n".join(lines) + "\n", encoding="utf8", newline="\n")


def main():
    ASSETS.mkdir(exist_ok=True)
    old = []
    if SKIP_PSD and (ASSETS / "manifest.json").exists():
        old = [e for e in json.loads((ASSETS / "manifest.json").read_text(encoding="utf8"))["assets"] if ".psd" in e["source"]]
    build_cards()
    build_board_and_misc()
    colours = build_player_colours_and_tints()
    build_ai_art()
    if SKIP_PSD:
        entries.extend(old)
    else:
        build_psd_board()
        build_psd_standees()
        build_psd_icons()
        build_psd_logo()
    build_placeholders()
    entries.sort(key=lambda e: e["id"])
    write_manifest(colours)
    write_still_needed()
    total = sum(e["bytes"] for e in entries)
    fp = sum(e["bytes"] for e in entries if e.get("firstPaint"))
    from collections import Counter
    print(f"{len(entries)} assets, {total:,} bytes total, {fp:,} bytes first paint, statuses {dict(Counter(e['status'] for e in entries))}")


if __name__ == "__main__":
    main()
