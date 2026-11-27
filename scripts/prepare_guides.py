#!/usr/bin/env python3
"""MorphoGem Clean-Room Mask Overlay Compositor & Orthographic Head-Ratio Ruler (MIT License).

Subcommands:
  1. mask-overlay:
     Composites a character/prop concept image with a user-supplied Mask image
     (binary B/W, alpha mask, painted overlay, or multi-color ID mask) to produce
     an unmistakable visual extraction guide:
       - Target masked component stays at 100% crisp original colors.
       - Outside-mask regions are dimmed to 20% low-contrast dark slate.
       - A 3px bright cyan/rose contour outlines the exact mask boundary.

  2. ratio-ruler:
     Generates a 1024x1024 orthographic proportion chart divided into exact head
     units (0.0H .. R*H) with a neutral mannequin silhouette matching R heads tall.
"""
import argparse
import math
from pathlib import Path
from PIL import Image, ImageDraw


def parse_hex_rgb(hex_str: str) -> tuple[int, int, int]:
    s = (hex_str or '#ff3b30').strip().lstrip('#')
    if len(s) == 3:
        s = ''.join(ch * 2 for ch in s)
    if len(s) != 6:
        return (255, 59, 48)
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return (255, 59, 48)


def extract_binary_mask(mask_img: Image.Image, mode: str, color_hex: str) -> list[int]:
    rgba = mask_img.convert('RGBA')
    w, h = rgba.size
    data = list(rgba.getdata())
    n = w * h

    mode = (mode or 'auto').lower()
    if mode == 'auto':
        transparent_cnt = sum(1 for _, _, _, a in data[::16] if a < 128)
        opaque_cnt = sum(1 for _, _, _, a in data[::16] if a >= 128)
        sample_total = max(1, transparent_cnt + opaque_cnt)
        if 0.03 <= (opaque_cnt / sample_total) <= 0.94 and transparent_cnt > 0:
            mode = 'alpha'
        else:
            # Check if colorful vs B&W
            sat_cnt = sum(1 for r, g, b, a in data[::16] if a >= 64 and (max(r, g, b) - min(r, g, b)) > 45)
            if sat_cnt / sample_total > 0.04:
                # High-saturation painted mask over dark/white background
                out = [0] * n
                for i, (r, g, b, a) in enumerate(data):
                    if a >= 64 and (max(r, g, b) - min(r, g, b)) > 40:
                        out[i] = 1
                return out
            # B&W mask: if background corners are white, dark pixels might be target unless majority is black
            corners = [data[0], data[w - 1], data[(h - 1) * w], data[n - 1]]
            corner_lum = sum((c[0] + c[1] + c[2]) / 3.0 for c in corners) / 4.0
            bright_ratio = sum(1 for r, g, b, _ in data[::16] if (r + g + b) > 380) / sample_total
            if corner_lum > 220 and bright_ratio > 0.55:
                # Black-on-white silhouette mask
                return [1 if (a >= 64 and (r + g + b) < 380) else 0 for r, g, b, a in data]
            mode = 'white'

    if mode == 'alpha':
        return [1 if a >= 96 else 0 for _, _, _, a in data]

    if mode == 'color':
        tr, tg, tb = parse_hex_rgb(color_hex)
        tol_sq = 68 * 68
        out = [0] * n
        for i, (r, g, b, a) in enumerate(data):
            if a < 48:
                continue
            d2 = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2
            if d2 <= tol_sq:
                out[i] = 1
        return out

    # Default 'white': bright pixels = target component
    return [1 if (a >= 64 and (r + g + b) >= 360) else 0 for r, g, b, a in data]


def build_mask_overlay(source_path: Path, mask_path: Path, out_path: Path, mode: str, color_hex: str) -> dict:
    src = Image.open(source_path).convert('RGBA')
    w, h = src.size
    msk_raw = Image.open(mask_path).convert('RGBA')
    if msk_raw.size != (w, h):
        msk_raw = msk_raw.resize((w, h), Image.Resampling.NEAREST)

    fg = extract_binary_mask(msk_raw, mode, color_hex)
    src_px = list(src.getdata())
    out_px = [(0, 0, 0, 255)] * (w * h)

    # Dilate 3px boundary ring for unmistakable contour highlight
    radius = max(2, min(5, round(max(w, h) / 360)))
    fg_count = sum(fg)

    for y in range(h):
        row = y * w
        for x in range(w):
            i = row + x
            r, g, b, a = src_px[i]
            # Composite transparent source against neutral dark backdrop first
            if a < 255:
                af = a / 255.0
                r = int(r * af + 24 * (1.0 - af))
                g = int(g * af + 28 * (1.0 - af))
                b = int(b * af + 38 * (1.0 - af))

            if fg[i]:
                # Check if within `radius` of a non-fg pixel -> crisp inner/outer boundary
                is_edge = False
                for dy in (-radius, 0, radius):
                    ny = y + dy
                    if ny < 0 or ny >= h:
                        is_edge = True
                        break
                    for dx in (-radius, 0, radius):
                        nx = x + dx
                        if nx < 0 or nx >= w or not fg[ny * w + nx]:
                            is_edge = True
                            break
                    if is_edge:
                        break
                if is_edge:
                    out_px[i] = (0, 240, 255, 255)
                else:
                    out_px[i] = (r, g, b, 255)
            else:
                # Check immediate outer halo
                near_fg = False
                for dy in (-1, 0, 1):
                    ny = y + dy
                    if 0 <= ny < h:
                        for dx in (-1, 0, 1):
                            nx = x + dx
                            if 0 <= nx < w and fg[ny * w + nx]:
                                near_fg = True
                                break
                    if near_fg:
                        break
                if near_fg:
                    out_px[i] = (255, 45, 110, 255)
                else:
                    out_px[i] = (int(r * 0.20 + 10), int(g * 0.20 + 14), int(b * 0.22 + 22), 255)

    out_img = Image.new('RGBA', (w, h))
    out_img.putdata(out_px)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(out_path, format='PNG')
    return {
        'width': w,
        'height': h,
        'coverageRatio': round(fg_count / max(1, w * h), 4),
        'output': str(out_path),
    }


def build_ratio_ruler(ratio: float, size: int, pose: str, out_path: Path) -> dict:
    r = max(1.5, min(9.5, float(ratio)))
    s = max(512, min(2048, int(size)))
    img = Image.new('RGBA', (s, s), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    top_y = round(s * 0.06)
    bot_y = round(s * 0.94)
    span_h = bot_y - top_y
    head_h = span_h / r
    cx = s // 2

    # Head zone vs Body+Legs zone subtle tint bands
    chin_y = round(top_y + head_h)
    draw.rectangle([round(s * 0.14), top_y, round(s * 0.86), chin_y], fill=(232, 250, 255, 255))
    draw.rectangle([round(s * 0.14), chin_y, round(s * 0.86), bot_y], fill=(245, 248, 252, 255))

    # Stylized neutral mannequin silhouette matching R heads
    head_rx = max(14, round(head_h * (0.44 if r <= 3.5 else 0.37)))
    head_cy = round(top_y + head_h * 0.5)
    head_ry = max(16, round(head_h * 0.49))
    draw.ellipse([cx - head_rx, head_cy - head_ry, cx + head_rx, head_cy + head_ry],
                 fill=(186, 230, 253, 255), outline=(14, 116, 144, 255), width=3)

    body_total = max(24.0, span_h - head_h)
    neck_h = max(4, round(head_h * (0.08 if r <= 3.2 else 0.16)))
    shoulder_y = chin_y + neck_h
    chibi_factor = max(0.0, min(1.0, (4.2 - r) / 2.2))
    torso_frac = 0.48 * chibi_factor + 0.37 * (1.0 - chibi_factor)
    crotch_y = round(shoulder_y + (bot_y - shoulder_y) * torso_frac)

    shoulder_hw = round(head_rx * (0.95 * chibi_factor + 1.55 * (1.0 - chibi_factor)))
    hip_hw = round(head_rx * (0.92 * chibi_factor + 1.18 * (1.0 - chibi_factor)))

    # Neck
    neck_hw = max(6, round(head_rx * 0.32))
    draw.rectangle([cx - neck_hw, chin_y - 2, cx + neck_hw, shoulder_y + 4], fill=(203, 213, 225, 255))

    # Torso + Pelvis polygon
    draw.polygon([
        (cx - shoulder_hw, shoulder_y),
        (cx + shoulder_hw, shoulder_y),
        (cx + hip_hw, crotch_y),
        (cx - hip_hw, crotch_y),
    ], fill=(203, 213, 225, 255), outline=(71, 85, 105, 255))

    # Arms (T-pose or A-pose)
    arm_len = round(body_total * (0.36 * chibi_factor + 0.42 * (1.0 - chibi_factor)))
    arm_thick = max(8, round(head_rx * (0.42 * chibi_factor + 0.30 * (1.0 - chibi_factor))))
    ang = math.radians(42.0 if (pose or 't').lower() == 'a' else 4.0)
    for sign in (-1, 1):
        sx0 = cx + sign * shoulder_hw
        sy0 = shoulder_y + arm_thick // 2
        ex0 = round(sx0 + sign * math.cos(ang) * arm_len)
        ey0 = round(sy0 + math.sin(ang) * arm_len)
        draw.line([(sx0, sy0), (ex0, ey0)], fill=(180, 194, 212, 255), width=arm_thick)

    # Legs (crotch_y -> bot_y)
    leg_thick = max(10, round(hip_hw * (0.72 * chibi_factor + 0.58 * (1.0 - chibi_factor))))
    leg_offset = max(leg_thick // 2 + 3, round(hip_hw * 0.56))
    for sign in (-1, 1):
        lx = cx + sign * leg_offset
        draw.line([(lx, crotch_y), (lx, bot_y - 2)], fill=(180, 194, 212, 255), width=leg_thick)

    # Horizontal Head-Unit Grid Lines (0H .. ceil(R)H + exact R*H baseline)
    whole_steps = int(math.floor(r + 1e-6))
    for k in range(0, whole_steps + 1):
        yk = round(top_y + k * head_h)
        is_crown = (k == 0)
        is_chin = (k == 1)
        color = (225, 29, 72, 255) if (is_crown or is_chin) else (100, 116, 139, 255)
        width = 3 if (is_crown or is_chin) else 2
        draw.line([(round(s * 0.06), yk), (round(s * 0.94), yk)], fill=color, width=width)
        lbl = f'{k}.0H (CROWN)' if is_crown else (f'1.0H (CHIN)' if is_chin else f'{k}.0H')
        draw.text((round(s * 0.065), max(4, yk - 14)), lbl, fill=color)

    # Exact Feet Soles line (R * H)
    draw.line([(round(s * 0.06), bot_y), (round(s * 0.94), bot_y)], fill=(225, 29, 72, 255), width=3)
    draw.text((round(s * 0.065), bot_y + 4), f'{r:g}H (FEET SOLES)  |  HEAD = 1/{r:g} TOTAL HEIGHT', fill=(225, 29, 72, 255))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, format='PNG')
    return {'ratio': r, 'size': s, 'output': str(out_path)}


def main() -> None:
    parser = argparse.ArgumentParser(description='MorphoGem Guide Image Generator')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_mask = sub.add_parser('mask-overlay')
    p_mask.add_argument('--source', required=True)
    p_mask.add_argument('--mask', required=True)
    p_mask.add_argument('--mode', default='auto')
    p_mask.add_argument('--color', default='#ff3b30')
    p_mask.add_argument('--out', required=True)

    p_ruler = sub.add_parser('ratio-ruler')
    p_ruler.add_argument('--ratio', type=float, required=True)
    p_ruler.add_argument('--size', type=int, default=1024)
    p_ruler.add_argument('--pose', default='t')
    p_ruler.add_argument('--out', required=True)

    args = parser.parse_args()
    if args.cmd == 'mask-overlay':
        build_mask_overlay(Path(args.source), Path(args.mask), Path(args.out), args.mode, args.color)
    elif args.cmd == 'ratio-ruler':
        build_ratio_ruler(args.ratio, args.size, args.pose, Path(args.out))


if __name__ == '__main__':
    main()
