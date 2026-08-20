#!/usr/bin/env python3
"""Generate simple flat PNG icons (rounded indigo tile with a white bolt) for the extension."""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
BG = (99, 102, 241, 255)      # indigo
FG = (255, 255, 255, 255)     # white bolt


def in_tile(x, y, s):
    r = s * 0.18
    x0, y0, x1, y1 = r, r, s - 1 - r, s - 1 - r
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 + r <= x <= x1 - r or y0 + r <= y <= y1 - r:
        return x0 <= x <= x1 and y0 <= y <= y1
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_bolt(x, y, s):
    # lightning bolt polygon, relative coordinates
    pts = [(0.55, 0.16), (0.30, 0.55), (0.47, 0.55), (0.42, 0.84), (0.70, 0.44), (0.52, 0.44), (0.62, 0.16)]
    pts = [(px * s, py * s) for px, py in pts]
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def make_png(size, path):
    rows = []
    for y in range(size):
        row = b"\x00"
        for x in range(size):
            if not in_tile(x + 0.5, y + 0.5, size):
                row += bytes((0, 0, 0, 0))
            elif in_bolt(x + 0.5, y + 0.5, size):
                row += bytes(FG)
            else:
                row += bytes(BG)
        rows.append(row)
    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in (16, 48, 128):
        make_png(s, os.path.join(OUT_DIR, f"icon{s}.png"))

