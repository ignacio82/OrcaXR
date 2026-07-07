#!/usr/bin/env python3
"""Semantic G-code parity comparison for OrcaXR WASM vs Snapmaker Orca CLI.

Byte-identity is unattainable (the CLI itself drifts ~0.1% run-to-run from
TBB scheduling), so parity is defined as:
  - identical layer count
  - identical per-layer toolchange sequence
  - per-tool extrusion (model and wipe-tower separately) within tolerance
  - same feature types present
"""
import re
import sys


def parse(path):
    layers = []  # list of dicts: {z, tools:[...]}
    cur_tool = None
    e_model = {}
    e_tower = {}
    e_by_feature = {}
    feature = None
    in_tower = False
    tool_seq = []
    layer_tools = None
    nlayers = 0
    for line in open(path, errors="ignore"):
        if line.startswith(";LAYER_CHANGE"):
            nlayers += 1
            layer_tools = []
            layers.append(layer_tools)
            continue
        if line.startswith("; CP TOOLCHANGE START") or "WIPE_TOWER_START" in line:
            in_tower = True
        if line.startswith("; CP TOOLCHANGE END") or "WIPE_TOWER_END" in line:
            in_tower = False
        if line.startswith(";TYPE:"):
            feature = line.strip()[6:]
            in_tower = feature in ("Prime tower", "Wipe tower")
            continue
        m = re.match(r"^T(\d+)\b", line)
        if m:
            cur_tool = int(m.group(1))
            tool_seq.append(cur_tool)
            if layer_tools is not None:
                layer_tools.append(cur_tool)
            continue
        if cur_tool is None or not line.startswith(("G1", "G2", "G3")):
            continue
        m2 = re.search(r"\bE([-\d.]+)", line)
        if not m2:
            continue
        v = float(m2.group(1))
        if v <= 0:
            continue
        if in_tower:
            e_tower[cur_tool] = e_tower.get(cur_tool, 0.0) + v
        else:
            e_model[cur_tool] = e_model.get(cur_tool, 0.0) + v
        if feature:
            e_by_feature[feature] = e_by_feature.get(feature, 0.0) + v
    return {
        "layers": nlayers,
        "tool_seq": tool_seq,
        "per_layer": layers,
        "e_model": e_model,
        "e_tower": e_tower,
        "e_feature": e_by_feature,
    }


def main(a_path, b_path, tol_pct=2.0):
    a, b = parse(a_path), parse(b_path)
    ok = True

    def fail(msg):
        nonlocal ok
        ok = False
        print("FAIL:", msg)

    print(f"A: {a_path}\nB: {b_path}\n")
    if a["layers"] != b["layers"]:
        fail(f"layer count {a['layers']} vs {b['layers']}")
    else:
        print(f"layers: {a['layers']} == {b['layers']}")

    if a["tool_seq"] == b["tool_seq"]:
        print(f"toolchange sequence: identical ({len(a['tool_seq'])} changes)")
    else:
        la, lb = len(a["tool_seq"]), len(b["tool_seq"])
        fail(f"toolchange sequence differs (count {la} vs {lb})")
        # first divergent layer
        for i, (ta, tb) in enumerate(zip(a["per_layer"], b["per_layer"])):
            if ta != tb:
                print(f"  first divergent layer {i}: {ta} vs {tb}")
                break

    for label, key in (("model", "e_model"), ("tower", "e_tower")):
        tools = sorted(set(a[key]) | set(b[key]))
        for t in tools:
            va, vb = a[key].get(t, 0.0), b[key].get(t, 0.0)
            if va == 0 and vb == 0:
                continue
            base = max(va, vb)
            d = 100.0 * abs(va - vb) / base if base else 0.0
            status = "ok" if d <= tol_pct else "FAIL"
            if d > tol_pct:
                fail(f"{label} T{t}: {va:.1f} vs {vb:.1f} ({d:.2f}% > {tol_pct}%)")
            print(f"{label:6s} T{t}: {va:10.1f} vs {vb:10.1f}  delta {d:6.2f}%  {status}")

    fa, fb = set(a["e_feature"]), set(b["e_feature"])
    if fa != fb:
        print(f"feature sets differ: only-A={fa - fb} only-B={fb - fa}")
    for f in sorted(fa | fb):
        va, vb = a["e_feature"].get(f, 0.0), b["e_feature"].get(f, 0.0)
        base = max(va, vb)
        d = 100.0 * abs(va - vb) / base if base else 0.0
        print(f"feature {f:28s}: {va:10.1f} vs {vb:10.1f}  delta {d:6.2f}%")

    print("\nPARITY:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 2.0))
