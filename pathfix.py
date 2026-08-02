#!/usr/bin/env python3
"""Repair Subway Builder "No Valid Path" saves.

Tracks in Subway Builder connect only when their endpoint coordinates match
exactly. A misalignment of a few millionths of a degree (invisible in game)
splits the network and breaks route pathfinding. This tool finds endpoint
pairs closer than a threshold (default 1 m), snaps them together, and writes
a repaired copy of the save with a new name and ID. The original file is
never modified.

Works on native .metro saves and on "Legacy JSON" exports. Stdlib only.

Usage:
    python3 pathfix.py "path/to/save.metro" [-o OUT] [--threshold 1.0]
                       [--aggressive] [--dry-run]
"""

import argparse
import json
import math
import struct
import sys
import time
import uuid
import zlib
from pathlib import Path

NAME_OFFSET = 0x28  # save name, zero-padded, ends before city code at 0x128
NAME_MAX = 255
PAYLOAD_OFFSET = 0x18  # u32 LE: gzip payload offset (after optional thumbnail)
LEN_OFFSET = 0x1C  # u32 LE: gzip payload byte length
TS_OFFSET = 0x20  # u64 LE: save timestamp in ms
CRC_OFFSET = 0x390  # u32 LE: CRC32 of the gzip payload — the game refuses to
# load a save whose payload doesn't match this ("Checksum verification failed")
MAX_ELEVATION_DELTA = 0.5
# For gaps beyond this, the two track ends must roughly point at each other
# (within 60 degrees) or the pair is refused: a sideways near-miss is parallel
# tracks, not a broken joint. Below it, coordinates are rounded too coarsely
# (~0.1 m) for direction to mean anything.
ALIGNMENT_CHECK_MIN_M = 1.5
ALIGNMENT_MIN_COS = 0.5


def parse_save_file(data: bytes):
    if data[:4] == b"METR":
        version = struct.unpack_from("<I", data, 0x0C)[0]
        payload_offset = struct.unpack_from("<I", data, PAYLOAD_OFFSET)[0]
        payload_length = struct.unpack_from("<I", data, LEN_OFFSET)[0]
        if not 0x30 <= payload_offset < len(data):
            raise ValueError(f"Corrupt .metro header: payload offset {payload_offset:#x}")
        # Slice by the recorded length (falling back to EOF); the header copy up
        # to the payload keeps any embedded PNG thumbnail intact.
        end = (payload_offset + payload_length
               if payload_length and payload_offset + payload_length <= len(data)
               else len(data))
        save = json.loads(zlib.decompress(data[payload_offset:end], 31))
        return {"kind": "metro", "header": bytearray(data[:payload_offset]),
                "save": save, "version": version}
    return {"kind": "json", "header": None, "save": json.loads(data), "version": None}


def get_game_data(save):
    for candidate in (save.get("mainSave", {}).get("data"), save.get("data"), save):
        if isinstance(candidate, dict) and "tracks" in candidate:
            return candidate
    raise ValueError("Unrecognized save structure: no track data found")


def meters_vector(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return ((b[0] - a[0]) * 111320 * math.cos(lat), (b[1] - a[1]) * 110540)


def meters_between(a, b):
    return math.hypot(*meters_vector(a, b))


def unit(v):
    m = math.hypot(*v)
    return (v[0] / m, v[1] / m) if m else None


def outward_direction(ref):
    """Direction a track 'exits' through this endpoint, from its last leg."""
    track, end = ref
    cs = track["coords"]
    return unit(meters_vector(cs[1], cs[0]) if end == "start"
                else meters_vector(cs[-2], cs[-1]))


def ends_point_at_each_other(ea, eb):
    g = unit(meters_vector(ea["coord"], eb["coord"]))
    if g is None:
        return True

    def facing(e, direction):
        for ref in e["refs"]:
            d = outward_direction(ref)
            if d is None or d[0] * direction[0] + d[1] * direction[1] >= ALIGNMENT_MIN_COS:
                return True
        return False

    return facing(ea, g) and facing(eb, (-g[0], -g[1]))


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        p = self.parent.setdefault(x, x)
        if p != x:
            self.parent[x] = p = self.find(p)
        return p

    def union(self, a, b):
        self.parent[self.find(a)] = self.find(b)


def coord_key(c):
    return (c[0], c[1])


def valid_tracks(data):
    return [t for t in data["tracks"]
            if isinstance(t.get("coords"), list) and len(t["coords"]) >= 2]


def build_endpoint_index(tracks):
    endpoints = {}  # key -> {"coord": [lon, lat], "refs": [(track, end)]}
    for t in tracks:
        for end, c in (("start", t["coords"][0]), ("end", t["coords"][-1])):
            e = endpoints.setdefault(coord_key(c), {"coord": [c[0], c[1]], "refs": []})
            e["refs"].append((t, end))
    return endpoints


def build_union_find(tracks):
    uf = UnionFind()
    for t in tracks:
        uf.union(coord_key(t["coords"][0]), coord_key(t["coords"][-1]))
    return uf


def describe_components(data):
    """Station names grouped by connected component, largest first."""
    tracks = valid_tracks(data)
    uf = build_union_find(tracks)
    track_by_id = {t["id"]: t for t in tracks}
    groups = {uf.find(coord_key(t["coords"][0])): set() for t in tracks}
    for s in data.get("stations") or []:
        for tid in s.get("trackIds") or []:
            t = track_by_id.get(tid)
            if t is not None:
                groups[uf.find(coord_key(t["coords"][0]))].add(s["name"])
                break
    return sorted((sorted(names) for names in groups.values()),
                  key=len, reverse=True)


def near_miss_pairs(endpoints, threshold):
    cell_size = 2e-4  # ~11-22 m per cell; 3x3 neighborhood covers any sane threshold
    grid = {}
    for k, e in endpoints.items():
        cell = (math.floor(e["coord"][0] / cell_size), math.floor(e["coord"][1] / cell_size))
        grid.setdefault(cell, []).append(k)
    pairs, seen = [], set()
    for k, e in endpoints.items():
        cx, cy = math.floor(e["coord"][0] / cell_size), math.floor(e["coord"][1] / cell_size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for k2 in grid.get((cx + dx, cy + dy), []):
                    if k2 == k or (pk := (min(k, k2), max(k, k2))) in seen:
                        continue
                    seen.add(pk)
                    d = meters_between(e["coord"], endpoints[k2]["coord"])
                    if 0 < d <= threshold:
                        pairs.append((d, k, k2))
    return sorted(pairs)


def elev_of(ref):
    track, end = ref
    return track.get("startElevation" if end == "start" else "endElevation")


def analyze_and_fix(save, threshold=5.0, aggressive=False):
    data = get_game_data(save)
    tracks = valid_tracks(data)
    endpoints = build_endpoint_index(tracks)
    # Eligibility uses the component structure BEFORE any fixes: a double-track
    # break is two parallel gaps across the same divide, and closing the first
    # must not disqualify the second.
    uf = build_union_find(tracks)
    root_before = {k: uf.find(k) for k in endpoints}
    islands_before = describe_components(data)

    fixes, skipped = [], []
    for d, a, b in near_miss_pairs(endpoints, threshold):
        ea, eb = endpoints.get(a), endpoints.get(b)
        if ea is None or eb is None:  # one side already merged into an earlier fix
            continue
        pair = {"distanceMeters": d, "coords": [ea["coord"], eb["coord"]]}

        if not aggressive and root_before[a] == root_before[b]:
            skipped.append({**pair, "reason": "already-connected"})
            continue
        tracks_at_a = {t["id"] for t, _ in ea["refs"]}
        if any(t["id"] in tracks_at_a for t, _ in eb["refs"]):
            skipped.append({**pair, "reason": "same-track"})
            continue
        if d > ALIGNMENT_CHECK_MIN_M and not ends_point_at_each_other(ea, eb):
            skipped.append({**pair, "reason": "not-aligned"})
            continue
        min_delta = min(abs((elev_of(ra) or 0) - (elev_of(rb) or 0))
                        for ra in ea["refs"] for rb in eb["refs"])
        if min_delta > MAX_ELEVATION_DELTA:
            skipped.append({**pair, "reason": "elevation-mismatch", "deltaMeters": min_delta})
            continue

        # Move the endpoint fewer tracks depend on; ties move b onto a.
        winner, loser = (ea, eb) if len(ea["refs"]) >= len(eb["refs"]) else (eb, ea)
        target = winner["coord"]
        winner_elevs = [e for e in map(elev_of, winner["refs"]) if isinstance(e, (int, float))]
        lx, ly = loser["coord"]
        moved = []
        for ref in loser["refs"]:
            track, end = ref
            track["coords"][0 if end == "start" else -1] = [target[0], target[1]]
            my_elev = elev_of(ref)
            if isinstance(my_elev, (int, float)) and winner_elevs:
                closest = min(winner_elevs, key=lambda e: abs(e - my_elev))
                if closest != my_elev and abs(closest - my_elev) <= MAX_ELEVATION_DELTA:
                    track["startElevation" if end == "start" else "endElevation"] = closest
            moved.append(track["id"])
            winner["refs"].append(ref)
        for n in data.get("stNodes") or []:
            if n.get("center") and n["center"][0] == lx and n["center"][1] == ly:
                n["center"] = [target[0], target[1]]
        for s in data.get("stations") or []:
            if s.get("coords") and s["coords"][0] == lx and s["coords"][1] == ly:
                s["coords"] = [target[0], target[1]]
        del endpoints[a if loser is ea else b]
        fixes.append({"distanceMeters": d, "from": [lx, ly],
                      "to": [target[0], target[1]], "tracks": moved})

    return {
        "componentsBefore": len(islands_before),
        "componentsAfter": len(describe_components(data)),
        "islandsBefore": islands_before,
        "islandsAfter": describe_components(data),
        "fixes": fixes,
        "skipped": skipped,
    }


def rebrand(save, suffix=" FIXED"):
    ms = save.get("mainSave")
    if not ms:
        return None
    if isinstance(ms.get("name"), str) and not ms["name"].endswith(suffix):
        ms["name"] += suffix
    ms["id"] = str(uuid.uuid4())
    return {"name": ms["name"], "id": ms["id"]}


def suggest_filename(parsed):
    ms = (parsed["save"].get("mainSave") or {}) if isinstance(parsed["save"], dict) else {}
    slug = "".join(ch if ch.isalnum() else "_" for ch in str(ms.get("name", "save")).lower())
    while "__" in slug:
        slug = slug.replace("__", "_")
    slug = slug.strip("_") or "save"
    if parsed["kind"] == "json" or not ms.get("id"):
        return slug + "_fixed.json"
    return f"{slug}_{ms['id'].replace('-', '')}.metro"


def serialize_save(parsed):
    json_bytes = json.dumps(parsed["save"], separators=(",", ":"),
                            ensure_ascii=False).encode()
    if parsed["kind"] == "json":
        return json_bytes
    comp = zlib.compressobj(9, zlib.DEFLATED, 31)
    payload = bytearray(comp.compress(json_bytes) + comp.flush())
    payload[4:8] = b"\x00\x00\x00\x00"  # zero gzip MTIME, matching the game
    header = bytearray(parsed["header"])
    struct.pack_into("<I", header, LEN_OFFSET, len(payload))
    struct.pack_into("<I", header, CRC_OFFSET, zlib.crc32(bytes(payload)))
    struct.pack_into("<Q", header, TS_OFFSET, int(time.time() * 1000))
    name = (parsed["save"].get("mainSave") or {}).get("name")
    if isinstance(name, str):
        header[NAME_OFFSET:NAME_OFFSET + NAME_MAX + 1] = b"\x00" * (NAME_MAX + 1)
        encoded = name.encode()[:NAME_MAX]
        header[NAME_OFFSET:NAME_OFFSET + len(encoded)] = encoded
    return bytes(header) + bytes(payload)


def format_coord(c):
    return f"({c[0]:.6f}, {c[1]:.6f})"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("save", help="path to a .metro save or Legacy JSON export")
    ap.add_argument("-o", "--output", help="output path (default: alongside input)")
    ap.add_argument("--threshold", type=float, default=5.0,
                    help="max gap in meters to snap shut (default 5.0)")
    ap.add_argument("--aggressive", action="store_true",
                    help="also snap near-misses within already-connected sections")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing anything")
    ap.add_argument("--keep-identity", action="store_true",
                    help="keep the original save name and ID (risks colliding "
                         "with the original in the save list)")
    args = ap.parse_args()

    src = Path(args.save)
    parsed = parse_save_file(src.read_bytes())
    report = analyze_and_fix(parsed["save"], threshold=args.threshold,
                             aggressive=args.aggressive)

    print(f"Connected sections: {report['componentsBefore']} -> {report['componentsAfter']}")
    if report["componentsBefore"] > 1:
        for i, names in enumerate(report["islandsBefore"]):
            label = ", ".join(names) if names else "(no stations)"
            print(f"  island {i + 1}: {label}")
    for f in report["fixes"]:
        print(f"  FIXED  {f['distanceMeters']:.3f} m gap at {format_coord(f['from'])}"
              f" -> {format_coord(f['to'])}  [{len(f['tracks'])} track end(s) moved]")
    for s in report["skipped"]:
        print(f"  skipped {s['distanceMeters']:.3f} m gap at {format_coord(s['coords'][0])}"
              f": {s['reason']}")

    if not report["fixes"]:
        print("Nothing to fix." if report["componentsAfter"] == 1 else
              "No fixable gaps under threshold; network is still disconnected. "
              "Try a larger --threshold, and check for genuinely unbuilt links.")
        return 0
    if report["componentsAfter"] > 1:
        print("Warning: network still has disconnected sections after fixing; "
              "they may be farther apart than the threshold.")
    if args.dry_run:
        print("Dry run: no file written.")
        return 0

    if not args.keep_identity:
        rebrand(parsed["save"])
    out = Path(args.output) if args.output else src.parent / suggest_filename(parsed)
    if out.resolve() == src.resolve():
        print("Refusing to overwrite the input file.", file=sys.stderr)
        return 1
    out.write_bytes(serialize_save(parsed))
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
