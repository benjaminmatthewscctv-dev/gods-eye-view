#!/usr/bin/env python3
"""ALDOT's traffic cameras (ALGO Traffic, algotraffic.com) as a God's Eye View camera pack.

  python3 aldot_cameras.py [--out ~/godseye/cctv_sources.aldot.json] [--near LAT,LON,KM]

Reads the public list at https://api.algotraffic.com/v4.0/Cameras (614 cameras statewide in 2026-10: coordinates, city,
route, direction, an HLS stream on Wowza and a snapshot JPEG) and writes it in the shape the globe's CCTV layer takes
(server/providers/cctv/normalize.js, normalizeSourceItem): id, name, city, provider, lat, lon, headingDeg, feedType, url,
snapshotUrl, license, credit, code. The globe reads the file named by CCTV_SOURCES_FILE (deck/godseye.env). Only
cameras marked Public are kept. --near limits the pack to a circle, e.g. --near 34.73,-86.59,120 for north Alabama.
"""
import argparse, json, math, os, sys, urllib.request

API = "https://api.algotraffic.com/v4.0/Cameras"
HEADING = {"North": 0, "Northeast": 45, "East": 90, "Southeast": 135, "South": 180, "Southwest": 225, "West": 270, "Northwest": 315}


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2); dp = p2 - p1; dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def convert(items, near=None):
    out = []
    for c in items:
        if str(c.get("accessLevel") or "Public") != "Public": continue
        loc = c.get("location") or {}; lat, lon = loc.get("latitude"), loc.get("longitude")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)): continue
        if near and haversine_km(near[0], near[1], lat, lon) > near[2]: continue
        route = str(loc.get("displayRouteDesignator") or loc.get("routeDesignator") or "").strip()
        cross = str(loc.get("displayCrossStreet") or loc.get("crossStreet") or "").strip()
        direction = str(loc.get("direction") or "").strip(); city = str(loc.get("city") or "").strip()
        name = " @ ".join(p for p in (route, cross) if p) or ("camera %s" % c.get("id"))
        if direction and direction not in ("Unknown", "None"): name += " (%s)" % direction
        hls = str((c.get("playbackUrls") or {}).get("hls") or "").strip(); snap = str(c.get("snapshotImageUrl") or "").strip()
        if not hls and not snap: continue
        item = {"id": "aldot:%s" % c.get("id"), "name": name, "city": city, "provider": "ALDOT ALGO Traffic", "lat": float(lat), "lon": float(lon),
                "feedType": "hls" if hls else "image", "url": hls, "snapshotUrl": snap, "license": "ALDOT / ALGO Traffic public camera feed",
                "credit": "ALGO Traffic (ALDOT and ALEA)", "code": (route or "AL")[:12].upper()}
        if direction in HEADING: item["headingDeg"] = HEADING[direction]; item["headingSource"] = "direction"
        out.append(item)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default=os.path.expanduser("~/godseye/cctv_sources.aldot.json"))
    ap.add_argument("--near", default="", help="LAT,LON,KM: keep only cameras within KM of the point")
    ap.add_argument("--from-file", default="", help="convert a saved API response instead of fetching")
    a = ap.parse_args()
    near = tuple(float(x) for x in a.near.split(",")) if a.near else None
    if a.from_file: data = json.load(open(a.from_file, encoding="utf-8"))
    else:
        req = urllib.request.Request(API, headers={"User-Agent": "cyberdeck/godseye (deck camera pack)", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r: data = json.loads(r.read().decode("utf-8"))
    items = data if isinstance(data, list) else (data.get("data") or data.get("items") or [])
    cams = convert(items, near)
    if not cams: print("no cameras converted; the file was left alone", file=sys.stderr); return 1
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"; json.dump(cams, open(tmp, "w", encoding="utf-8"), indent=0); os.replace(tmp, a.out)
    cities = {}
    for c in cams: cities[c["city"]] = cities.get(c["city"], 0) + 1
    print("%d ALDOT cameras -> %s (%d HLS, %d snapshot-only); top cities: %s" % (len(cams), a.out, sum(1 for c in cams if c["feedType"] == "hls"), sum(1 for c in cams if c["feedType"] == "image"),
          ", ".join("%s %d" % kv for kv in sorted(cities.items(), key=lambda kv: -kv[1])[:6])))
    return 0


if __name__ == "__main__": sys.exit(main())
