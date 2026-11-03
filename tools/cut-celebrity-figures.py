"""Cut each celebrity out of its standee portrait so the board can show the real figure.

    assets/portraits/celebrity-<key>.webp  ->  assets/figures/celebrity-<key>.webp   (transparent)

and adds a `figure-celebrity-<key>` row per figure to assets/manifest.json.

Needs rembg (AI background removal), which is NOT a project dependency. Run it from a
throwaway virtual environment:

    python -m venv venv && venv/Scripts/python -m pip install "rembg[cpu]" pillow
    venv/Scripts/python tools/cut-celebrity-figures.py [key ...]

With no keys it cuts all 18. build-assets.py registers whatever figures are already on
disk (see build_celebrity_figures there), so a full asset rebuild keeps them.
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageFilter
from rembg import new_session, remove

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "assets"
MAX_SIDE = 440          # the board shows the figure at roughly 100-200 device pixels tall
TARGET_BYTES = 60_000


def trim_alpha(img, pad=2):
    bb = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bb:
        img = img.crop((max(0, bb[0] - pad), max(0, bb[1] - pad), min(img.width, bb[2] + pad), min(img.height, bb[3] + pad)))
    return img


def encode(img):
    for q in (86, 80, 74, 68, 62):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=6, alpha_quality=90)
        if buf.tell() <= TARGET_BYTES:
            break
    return buf.getvalue()


def cut(session, key):
    src = Image.open(ASSETS / "portraits" / f"celebrity-{key}.webp").convert("RGB")
    # alpha matting gives a cleaner edge on the soft clay outlines
    out = remove(src, session=session, alpha_matting=True, alpha_matting_foreground_threshold=240,
                 alpha_matting_background_threshold=12, alpha_matting_erode_size=8)
    a = out.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    out.putalpha(a)
    out = trim_alpha(out)
    if max(out.size) > MAX_SIDE:
        k = MAX_SIDE / max(out.size)
        out = out.resize((round(out.width * k), round(out.height * k)), Image.LANCZOS)
    data = encode(out)
    rel = f"figures/celebrity-{key}.webp"
    (ASSETS / rel).write_bytes(data)
    return {
        "id": f"figure-celebrity-{key}",
        "file": rel,
        "width": out.width,
        "height": out.height,
        "bytes": len(data),
        "status": "real",
        "source": f"assets/portraits/celebrity-{key}.webp (rembg cut-out)",
        "shows": f"Transparent cut-out of celebrity {key}: the full-body clay figure from its standee portrait, background removed",
        "usedIn": "celebrity figure standing in its hall on the board",
    }


def main():
    keys = sys.argv[1:] or sorted(p.stem.removeprefix("celebrity-") for p in (ASSETS / "portraits").glob("celebrity-*.webp"))
    session = new_session("isnet-general-use")
    rows = []
    for key in keys:
        row = cut(session, key)
        rows.append(row)
        print(f"{row['id']}: {row['width']}x{row['height']}, {row['bytes']:,} bytes")
    path = ASSETS / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf8"))
    new_ids = {r["id"] for r in rows}
    manifest["assets"] = sorted([a for a in manifest["assets"] if a["id"] not in new_ids] + rows, key=lambda a: a["id"])
    path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf8", newline="\n")


if __name__ == "__main__":
    main()
