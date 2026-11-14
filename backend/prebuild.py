"""Build the demo targets' time-lapses ahead of time, so they open instantly and don't depend
on IRSA being up during the demo. Results are kept for 7 days in backend/.cache/timelapse.

Run while the server is running:
    python prebuild.py                      # the 5 challenge targets + Orion, all 6 detectors
    python prebuild.py --det 2 5            # only some detectors
    python prebuild.py "Upper Sco" "M31"    # other objects (anything the search box accepts)
    python prebuild.py --follow Vesta 2P    # asteroids/comets for the "Follow it" panel (default: Vesta Ceres Psyche)

A fresh time-lapse downloads ~40-50 MB per detector (about 4-10 s each on a good connection).
"""

import argparse
import json
import os
import sys
import time

import httpx

SERVER = os.environ.get("SERVER", "http://localhost:8000").rstrip("/")
TARGETS = ["Barnard's Star", "eps Ind B", "WISE J085510.83-071442.5", "RW Aur", "R Dra", "M42"]


def build(client: httpx.Client, t: dict, det: int, fov: float) -> str:
    t0 = time.perf_counter()
    params = {"ra": f"{t['ra']:.5f}", "dec": f"{t['dec']:.5f}", "fov": fov, "det": det}
    with client.stream("GET", f"{SERVER}/api/timelapse", params=params, timeout=900) as r:
        for line in r.iter_lines():
            if not line:
                continue
            msg = json.loads(line)
            if "result" in msg:
                res = msg["result"]
                return f"{len(res['visits'])} visits, {len(res['exposures'])} exposures, {time.perf_counter() - t0:.1f} s"
            if "error" in msg:
                return f"FAILED: {msg['error']}"
    return "no answer"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="*", default=TARGETS)
    ap.add_argument("--det", type=int, nargs="+", default=[1, 2, 3, 4, 5, 6])
    ap.add_argument("--fov", type=float, default=6.0, help="arcminutes (the time-lapse panel opens at 6)")
    ap.add_argument("--follow", nargs="*", default=["Vesta", "Ceres", "Psyche"],
                    help="asteroids/comets to follow through their exposures (the 'Follow it' panel; ~30-60 s each)")
    args = ap.parse_args()
    with httpx.Client() as client:
        try:
            client.get(f"{SERVER}/api/health", timeout=5).raise_for_status()
        except httpx.HTTPError:
            sys.exit(f"The Lumasphere server isn't answering at {SERVER}. Start it first.")
        for q in args.targets:
            r = client.get(f"{SERVER}/api/resolve", params={"q": q}, timeout=60)
            if r.status_code != 200:
                print(f"{q}: not found ({r.status_code})")
                continue
            t = r.json()
            if t.get("moving"):
                print(f"{q}: skipped (moves across the sky, no fixed patch)")
                continue
            for det in args.det:
                print(f"{t['name']:28s} detector {det}: {build(client, t, det, args.fov)}", flush=True)
        for name in args.follow:
            t0 = time.perf_counter()
            result = None
            with client.stream("GET", f"{SERVER}/api/track", params={"q": name, "fov": 12}, timeout=900) as r:
                for line in r.iter_lines():
                    if line.startswith('{"result"'):
                        result = json.loads(line)["result"]
                    elif line.startswith('{"error"'):
                        print(f"follow {name}: FAILED: {json.loads(line)['error']}")
            if result:
                print(f"follow {result['name']:21s}: {len(result['frames'])} frames, visible in {result.get('seen', '?')}, "
                      f"{time.perf_counter() - t0:.1f} s", flush=True)


if __name__ == "__main__":
    main()
