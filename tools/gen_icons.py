#!/usr/bin/env python3
"""Amber A on a dark tile, plus toolbar LED variants.

Matches the popup palette (departure-board amber on #131519).
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
TILE = (19, 21, 25, 255)       # --panel #131519
BORDER = (38, 42, 50, 255)     # --line #262a32
AMBER = (255, 167, 36, 255)    # --accent #ffa724
LED = {
    None: None,
    "idle": (110, 118, 131, 255),
    "ok": (93, 220, 122, 255),
    "stream": (90, 200, 250, 255),
    "warn": (255, 209, 102, 255),
    "error": (255, 107, 107, 255),
}


def write_png(path, size, pixels):
    rows = []
    for y in range(size):
        row = b"\x00"
        for x in range(size):
            row += bytes(pixels[y][x])
        rows.append(row)
    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


def in_roundrect(x, y, s, inset=0.0):
    r = max(1.2, s * 0.18)
    x0 = inset
    y0 = inset
    x1 = s - 1 - inset
    y1 = s - 1 - inset
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 + r <= x <= x1 - r or y0 + r <= y <= y1 - r:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_A(x, y, s):
    # Geometric A, slightly left of center so the LED has the bottom-right.
    left = s * 0.20
    right = s * 0.74
    top = s * 0.18
    bot = s * 0.82
    cx = (left + right) / 2
    t = max(1.15, s * 0.13)  # stroke
    if y < top or y > bot or x < left - t or x > right + t:
        return False
    # Two legs from apex
    h = bot - top
    w = right - left
    if h <= 0:
        return False
    rel = (y - top) / h
    half = (w / 2) * rel
    xL = cx - half
    xR = cx + half
    on_left = abs(x - xL) <= t * 0.72
    on_right = abs(x - xR) <= t * 0.72
    bar_y = top + h * 0.58
    on_bar = abs(y - bar_y) <= t * 0.42 and xL + t * 0.2 <= x <= xR - t * 0.2
    return on_left or on_right or on_bar


def in_led(x, y, s):
    cx = s * 0.80
    cy = s * 0.80
    r = max(1.6, s * 0.11)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_led_core(x, y, s):
    cx = s * 0.80
    cy = s * 0.80
    r = max(1.0, s * 0.075)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size, led_name):
    pixels = []
    led = LED[led_name]
    for y in range(size):
        row = []
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            if not in_roundrect(px, py, size):
                row.append((0, 0, 0, 0))
                continue
            if not in_roundrect(px, py, size, inset=1.0 if size >= 32 else 0.6):
                row.append(BORDER)
                continue
            if led and in_led(px, py, size):
                if in_led_core(px, py, size):
                    row.append(led)
                else:
                    row.append(tuple(max(0, c - 40) if i < 3 else 255 for i, c in enumerate(led)))
                continue
            if in_A(px, py, size):
                row.append(AMBER)
            else:
                row.append(TILE)
        pixels.append(row)
    return pixels


def main():
    os.makedirs(OUT, exist_ok=True)
    # Store / manifest icons: idle LED so the mark still reads as "alive"
    for s in (16, 48, 128):
        write_png(os.path.join(OUT, f"icon{s}.png"), s, render(s, "idle"))
    led_dir = os.path.join(OUT, "led")
    os.makedirs(led_dir, exist_ok=True)
    for name in ("idle", "ok", "stream", "warn", "error"):
        for s in (16, 32, 48):
            write_png(os.path.join(led_dir, f"{s}-{name}.png"), s, render(s, name))


if __name__ == "__main__":
    main()
