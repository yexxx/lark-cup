"""Render measured capacity and resource charts from retained JSON artifacts."""
import os
from pathlib import Path
os.environ.setdefault("MPLCONFIGDIR", str(Path(".local/load/matplotlib").resolve()))
import argparse
import json
import re
import datetime as dt
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="test-results/load")
parser.add_argument("--output", default="docs/stress-assets")
options = parser.parse_args()
source, output = Path(options.input), Path(options.output)
output.mkdir(parents=True, exist_ok=True)

def passes(r):
    if r.get("execution", {}).get("executionPauses", 0):
        return False
    if r.get("fixtureBudgetExhaustions", 0):
        return False
    if r["actionSuccessRate"] < .99:
        return False
    if any(r.get("successfulActionCounts", {}).get(k, 0)/v < .99 for k, v in r.get("actionCounts", {}).items() if v):
        return False
    for kind, s in r["requests"].items():
        errors = sum(v for k, v in s["statusCodes"].items() if k == "0" or (int(k) >= 500 and k != "503"))
        limit = {"auth": 2000, "vote": 800, "upload": 5000}.get(kind, 300)
        if errors / s["count"] > .001 or s["p95Ms"] > limit:
            return False
    return r["scheduling"]["over100Ms"] / r["planned"] <= .01

records = []
pattern = re.compile(r"^(baseline|baseline-quality|fixed)-(small|large)-(cached|database|mixed)-(?:[\d.]+|confirm(?:-[\d.]+)?)\.json$")
for file in sorted(source.glob("*.json")):
    match = pattern.match(file.name)
    if match:
        r = json.loads(file.read_text())
        r.update(phase="baseline" if match[1]=="baseline-quality" else match[1], size=match[2], file=file.name, passed=passes(r), confirmation="confirm" in file.name)
        records.append(r)

# Group repeated checkpoints by the measured scenario and rate. Prefer the
# business-specific baseline confirmation when comparing mixed workloads.
records = [r for r in records if not (r["phase"] == "baseline" and r["scenario"] == "mixed" and not r["file"].startswith("baseline-quality-"))]
latest = {}
for r in records:
    if r.get("execution", {}).get("executionPauses", 0) or r.get("fixtureBudgetExhaustions", 0):
        continue
    key = (r["phase"], r["size"], r["scenario"], r["targetActionsPerSecond"], r["confirmation"])
    if key not in latest or r["date"] > latest[key]["date"]:
        latest[key] = r
records = list(latest.values())

colors = {"baseline": "#c35142", "fixed": "#227d75"}
for scenario in ["cached", "database", "mixed"]:
    fig, axes = plt.subplots(1, 2, figsize=(11, 4), constrained_layout=True)
    for axis, size in zip(axes, ["small", "large"]):
        for phase in ["baseline", "fixed"]:
            rows = [r for r in records if r["scenario"] == scenario and r["size"] == size and r["phase"] == phase and not r["confirmation"]]
            rows.sort(key=lambda r: r["targetActionsPerSecond"])
            if rows:
                value=lambda r:min([r["actionSuccessRate"]]+[r["successfulActionCounts"].get(k,0)/v for k,v in r.get("actionCounts",{}).items() if v]) if scenario=="mixed" else r["actionSuccessRate"]
                axis.plot([r["targetActionsPerSecond"] for r in rows], [value(r)*100 for r in rows], "o-", color=colors[phase], label=phase)
            confirmed = [r for r in records if r["scenario"] == scenario and r["size"] == size and r["phase"] == phase and r["confirmation"] and r["passed"]]
            if confirmed:
                best = max(confirmed, key=lambda r: r["targetActionsPerSecond"])
                value = min([best["actionSuccessRate"]] + [best["successfulActionCounts"].get(k, 0)/v for k, v in best["actionCounts"].items() if v])
                axis.scatter([best["targetActionsPerSecond"]], [value*100], marker="*", s=110, color=colors[phase], zorder=4)
                axis.annotate(f'{phase}: {best["targetActionsPerSecond"]:g}', (best["targetActionsPerSecond"], value*100), xytext=(0, -24 if phase == "baseline" else -12), textcoords="offset points", fontsize=8, ha="center", color=colors[phase])
        axis.axhline(99, color="#777", linewidth=1, linestyle="--", label="99% threshold")
        axis.set(xscale="log", ylim=(0, 102), xlabel="Planned business actions / second", ylabel="Lowest business action success (%)" if scenario=="mixed" else "Completed business actions (%)", title=f"{scenario}: {size} fixture")
        axis.grid(alpha=.15)
        axis.legend(fontsize=8)
    fig.savefig(output / f"{scenario}-capacity.png", dpi=160)
    plt.close(fig)

confirmations = {}
for r in records:
    if r["confirmation"] and r["passed"]:
        key = (r["phase"], r["size"], r["scenario"])
        if key not in confirmations or r["targetActionsPerSecond"] > confirmations[key]["targetActionsPerSecond"]:
            confirmations[key] = r
summary = [{"phase": phase, "size": size, "scenario": scenario, "rate": r["targetActionsPerSecond"], "requestsPerSecond": r["requestsPerSecond"], "successRate": r["actionSuccessRate"], "file": r["file"], "requestP95Ms": {k: v["p95Ms"] for k, v in r["requests"].items()}, "actionCounts": r.get("actionCounts"), "successfulActionCounts": r.get("successfulActionCounts")} for (phase, size, scenario), r in sorted(confirmations.items())]
(output / "capacity-summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False)+"\n")

fig, axes = plt.subplots(1, 2, figsize=(11, 4), constrained_layout=True)
for phase in ["baseline", "fixed"]:
    stages, confirmations = {}, {}
    for file in source.glob(f"{phase}-maxfiles-large-upload-*.json"):
        r = json.loads(file.read_text())
        if "actionSuccessRate" not in r or r.get("execution", {}).get("executionPauses", 0) or r.get("fixtureBudgetExhaustions", 0):
            continue
        bucket = confirmations if "confirm" in file.name else stages
        rate = r["targetActionsPerSecond"]
        if rate not in bucket or r["date"] > bucket[rate]["date"]:
            bucket[rate] = r
    rows = sorted(stages.values(), key=lambda r: r["targetActionsPerSecond"])
    if not rows:
        continue
    rates = [r["targetActionsPerSecond"] for r in rows]
    axes[0].plot(rates, [r["actionSuccessRate"]*100 for r in rows], "o-", color=colors[phase], label=phase)
    axes[1].plot(rates, [r["requests"]["upload"]["p95Ms"] for r in rows], "o-", color=colors[phase], label=phase)
    passed = [r for r in confirmations.values() if passes(r)]
    if passed:
        best = max(passed, key=lambda r: r["targetActionsPerSecond"])
        axes[0].scatter([best["targetActionsPerSecond"]], [best["actionSuccessRate"]*100], marker="*", s=120, color=colors[phase], zorder=4)
        axes[0].annotate(f'{phase}: {best["targetActionsPerSecond"]:g} confirmed', (best["targetActionsPerSecond"], best["actionSuccessRate"]*100), xytext=(0, -24 if phase == "baseline" else -12), textcoords="offset points", fontsize=8, ha="center", color=colors[phase])
axes[0].axhline(99, color="#777", linewidth=1, linestyle="--", label="99% threshold")
axes[0].set(ylim=(0, 102), ylabel="Completed submission actions (%)", title="Near-5MiB HTML: full submission capacity")
axes[1].set(ylabel="Upload request p95 (ms)", title="Near-5MiB HTML: upload latency")
for axis in axes:
    axis.set(xscale="log", xlabel="Planned submission actions / second")
    axis.grid(alpha=.15)
    axis.legend(fontsize=8)
fig.savefig(output / "near-limit-upload-capacity.png", dpi=160)
plt.close(fig)

soak_file = source / "fixed-soak.json"
resource_file = source / "fixed-soak-resources.jsonl"
server_file = source / "fixed-soak-server.jsonl"
if soak_file.exists() and resource_file.exists() and server_file.exists():
    soak = json.loads(soak_file.read_text())
    resources = [json.loads(s) for s in resource_file.read_text().splitlines() if s]
    server = [json.loads(s) for s in server_file.read_text().splitlines() if s]
    timestamp = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    start = timestamp(soak["execution"]["startedAt"]) + soak["warmupSeconds"]
    end = start + soak["durationSeconds"]
    server = [r for r in server if start <= timestamp(r["date"]) <= end]
    resources = [r for r in resources if start <= timestamp(r["date"]) <= end]
    fig, axes = plt.subplots(2, 2, figsize=(11, 7), constrained_layout=True)
    minutes = [(timestamp(r["date"])-start)/60 for r in server]
    axes[0, 0].plot(minutes, [r["memory"]["rss"]/2**20 for r in server], label="RSS")
    axes[0, 0].plot(minutes, [r["memory"]["heapUsed"]/2**20 for r in server], label="JS heap")
    axes[0, 0].set(ylabel="MiB", title="API memory")
    axes[0, 1].plot(minutes, [r["eventLoopP95Ms"] for r in server])
    axes[0, 1].set(ylabel="ms", title="API event loop p95 (20ms sampling resolution)")
    for name in ["api", "db", "web", "redis"]:
        points = [(timestamp(r["date"]), float(c["CPUPerc"].replace("%", ""))) for r in resources if isinstance(r.get("containers"), list) for c in r["containers"] if c["Name"] == f"lark-cup-load-{name}-1"]
        if points:
            axes[1, 0].plot([(t-start)/60 for t, _ in points], [v for _, v in points], label=name)
    axes[1, 0].set(ylabel="% of one CPU", title="Container CPU")
    points = [(timestamp(r["date"]), int(r["database"]["asset_bytes"] or 0)/2**20) for r in resources if "asset_bytes" in r.get("database", {})]
    axes[1, 1].plot([(t-start)/60 for t, _ in points], [v for _, v in points])
    axes[1, 1].set(ylabel="MiB", title="Persisted upload bytes (reconciled with files)")
    for axis in axes.flat:
        axis.set_xlabel("Minutes")
        axis.grid(alpha=.15)
        if axis.get_legend_handles_labels()[0]: axis.legend(fontsize=8)
    fig.savefig(output / "soak-resources.png", dpi=160)
    plt.close(fig)
print(json.dumps({"records": len(records), "confirmations": summary, "output": str(output)}, ensure_ascii=False))
