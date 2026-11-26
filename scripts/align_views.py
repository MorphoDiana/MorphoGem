#!/usr/bin/env python3
"""MorphoGem Clean-Room Orthographic Multi-View Alpha & Baseline Aligner (MIT License).

Performs:
1. Exterior border pure-white flood-fill removal -> clean RGBA alpha channel.
2. Enclosed interior pure-white background pocket punching (e.g. hair loops, ribbon gaps,
   armpit/ankle gaps) when bounded by dark linework contours.
3. Orthographic unified world-scale normalization & pixel-exact vertical baseline lock
   so `front`, `left`, `right`, and `back` share the exact same `topY` and `bottomY`.

Usage:
  python scripts/align_views.py \
    --front raw_front.png --left raw_left.png --right raw_right.png --back raw_back.png \
    --out-dir images/ --size 1024 --prefix part_views_01
"""
import argparse
import json
from collections import deque
from pathlib import Path
from PIL import Image


def remove_white_background_and_pockets(img: Image.Image, punch_pockets: bool = True) -> Image.Image:
    rgba = img.convert('RGBA')
    w, h = rgba.size
    px = rgba.load()

    # Check if image already has meaningful transparency on corners
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    already_transparent = sum(1 for cx, cy in corners if px[cx, cy][3] < 16) >= 3

    visited = bytearray(w * h)

    def idx(x: int, y: int) -> int:
        return y * w + x

    # 1. Exterior flood-fill from image borders for near-white background pixels
    if not already_transparent:
        q = deque()
        for x in range(w):
            for y in (0, h - 1):
                r, g, b, a = px[x, y]
                if a > 0 and r >= 244 and g >= 244 and b >= 244:
                    i = idx(x, y)
                    if not visited[i]:
                        visited[i] = 1
                        q.append((x, y))
        for y in range(h):
            for x in (0, w - 1):
                r, g, b, a = px[x, y]
                if a > 0 and r >= 244 and g >= 244 and b >= 244:
                    i = idx(x, y)
                    if not visited[i]:
                        visited[i] = 1
                        q.append((x, y))

        while q:
            cx, cy = q.popleft()
            px[cx, cy] = (0, 0, 0, 0)
            for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    ni = idx(nx, ny)
                    if not visited[ni]:
                        r, g, b, a = px[nx, ny]
                        if a == 0 or (r >= 245 and g >= 245 and b >= 245):
                            visited[ni] = 1
                            q.append((nx, ny))
                        elif r >= 232 and g >= 232 and b >= 232:
                            # Soft anti-aliased fringe attenuation right on silhouette boundary
                            lum = (r + g + b) / 3.0
                            new_a = max(0, min(255, int((246.0 - lum) / 16.0 * a)))
                            px[nx, ny] = (r, g, b, new_a)

    # 2. Scan for enclosed pure-white background pockets surrounded by dark outline strokes
    if punch_pockets:
        seen_pocket = bytearray(w * h)
        for sy in range(1, h - 1):
            for sx in range(1, w - 1):
                si = idx(sx, sy)
                if visited[si] or seen_pocket[si]:
                    continue
                r0, g0, b0, a0 = px[sx, sy]
                if a0 < 200 or r0 < 250 or g0 < 250 or b0 < 250:
                    continue

                comp = []
                boundary_lums = []
                touches_edge = False
                pq = deque([(sx, sy)])
                seen_pocket[si] = 1

                while pq:
                    cx, cy = pq.popleft()
                    comp.append((cx, cy))
                    if cx == 0 or cy == 0 or cx == w - 1 or cy == h - 1:
                        touches_edge = True
                    for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                        if 0 <= nx < w and 0 <= ny < h:
                            ni = idx(nx, ny)
                            if seen_pocket[ni]:
                                continue
                            nr, ng, nb, na = px[nx, ny]
                            if na >= 200 and nr >= 250 and ng >= 250 and nb >= 250:
                                seen_pocket[ni] = 1
                                pq.append((nx, ny))
                            elif na >= 120:
                                boundary_lums.append((nr + ng + nb) / 3.0)

                # Clear pocket only if sizable and clearly enclosed by dark linework (not a soft white highlight)
                if not touches_edge and len(comp) >= 36 and boundary_lums:
                    dark_ratio = sum(1 for v in boundary_lums if v < 155.0) / len(boundary_lums)
                    if dark_ratio >= 0.55:
                        for kx, ky in comp:
                            px[kx, ky] = (0, 0, 0, 0)

    return rgba


def alpha_bbox(rgba: Image.Image, alpha_threshold: int = 16):
    alpha = rgba.getchannel('A')
    lut = [255 if i >= alpha_threshold else 0 for i in range(256)]
    mask = alpha.point(lut)
    box = mask.getbbox()
    if not box:
        raise ValueError('Image contains no opaque subject pixels after background removal.')
    return box  # (x0, y0, x1, y1)


def align_orthographic_views(view_paths: dict, out_dir: Path, size: int = 1024, prefix: str = 'part', margin: float = 0.06, punch_pockets: bool = True):
    out_dir.mkdir(parents=True, exist_ok=True)
    crops = {}
    raw_sizes = {}

    for key, p in view_paths.items():
        if not p:
            continue
        cleaned = remove_white_background_and_pockets(Image.open(p), punch_pockets=punch_pockets)
        x0, y0, x1, y1 = alpha_bbox(cleaned)
        cropped = cleaned.crop((x0, y0, x1, y1))
        crops[key] = cropped
        raw_sizes[key] = (x1 - x0, y1 - y0)

    if not crops:
        raise ValueError('No input views provided.')

    anchor_key = 'front' if 'front' in crops else next(iter(crops.keys()))
    _, anchor_h = raw_sizes[anchor_key]

    # Step 1: Match every view's vertical height to anchor_h so all views share identical orthographic scale
    norm_dims = {}
    for key, (cw, ch) in raw_sizes.items():
        rel_scale = anchor_h / max(1, ch)
        norm_dims[key] = (cw * rel_scale, float(anchor_h))

    # Step 2: Fit the widest/tallest normalized extent cleanly inside canvas `size * (1 - 2 * margin)`
    usable = max(64.0, size * (1.0 - 2.0 * margin))
    max_extent = max([ float(anchor_h) ] + [ nw for nw, _ in norm_dims.values() ])
    global_fit = usable / max(1.0, max_extent)

    target_h = max(1, int(round(anchor_h * global_fit)))
    locked_top_y = (size - target_h) // 2

    results = {}
    for key, cropped in crops.items():
        cw, ch = cropped.size
        scale = target_h / max(1.0, float(ch))
        target_w = max(1, min(size, int(round(cw * scale))))
        resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)

        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        paste_x = (size - target_w) // 2
        canvas.paste(resized, (paste_x, locked_top_y), resized)

        out_file = out_dir / f'{prefix}-{key}.png'
        canvas.save(out_file, format='PNG')
        fx0, fy0, fx1, fy1 = alpha_bbox(canvas, alpha_threshold=16)
        results[key] = {
            'path': str(out_file),
            'width': size,
            'height': size,
            'bbox': [fx0, fy0, fx1, fy1],
            'topY': fy0,
            'bottomY': fy1,
        }

    return results


def main():
    parser = argparse.ArgumentParser(description='MorphoGem Orthographic Multi-View Aligner')
    parser.add_argument('--front', required=True, help='Front view PNG/JPG')
    parser.add_argument('--left', default='', help='Character-left view PNG/JPG')
    parser.add_argument('--right', default='', help='Character-right / side view PNG/JPG')
    parser.add_argument('--back', required=True, help='Back view PNG/JPG')
    parser.add_argument('--side', default='', help='Optional 3-view side alias')
    parser.add_argument('--out-dir', required=True, help='Destination folder for aligned RGBA PNGs')
    parser.add_argument('--size', type=int, default=1024, help='Output square resolution (1024 or 2048)')
    parser.add_argument('--prefix', default='part', help='Output filename prefix (<prefix>-front.png)')
    parser.add_argument('--margin', type=float, default=0.06, help='Canvas margin fraction (default 0.06)')
    parser.add_argument('--keep-pockets', action='store_true', help='Disable automatic interior white-pocket punching')
    args = parser.parse_args()

    view_map = {'front': args.front, 'back': args.back}
    if args.left:
        view_map['left'] = args.left
    if args.right:
        view_map['right'] = args.right
    if args.side and 'side' not in view_map:
        view_map['side'] = args.side

    summary = align_orthographic_views(
        view_paths=view_map,
        out_dir=Path(args.out_dir).resolve(),
        size=args.size,
        prefix=args.prefix,
        margin=args.margin,
        punch_pockets=not args.keep_pockets,
    )
    print(json.dumps({'ok': True, 'aligned': summary}, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
