"""Check a trusted raw Green receipt for the fixed Canary workload."""

import argparse
import csv
import json
import re
from decimal import Decimal


MIB = 1024**2
MAX_RECEIPT_BYTES = MIB
MIN_DRIVER_SECONDS = Decimal("262.5")  # 105 fixed 2.5-second sleeps
MAX_DRIVER_SECONDS = 360
MIN_SAMPLE_GAP_SECONDS = 5
MAX_SAMPLE_GAP_SECONDS = 8  # 5-second interval plus sampling and launch overhead
IDLE_LIMIT_BYTES = 128 * MIB
ACTIVE_LIMIT_BYTES = 160 * MIB
CPU_LIMIT_PERCENT = 15
ROUTE_LIMIT_MS = 350
PROFILE = "green-2000-task-v2"
WORKLOAD_SHA256 = "d060f566d2ab6c8a90537b21f049cc1215b97ea9328e23e428b56aa1246fa50b"
PARENT_SHA256 = "60b394f364c7f43a0038c0fb4376abd1a435a1760cf2bcd7ca29404e12ea6869"
FIXED_HELPER = (
    "sha256:5ce98efbe0fdb68edf92f3b98dfe78a70739a412d76083a42bfefbde8410824f architecture=arm64 "
    "layer=sha256:5070b31eb4c50bf7d0297a1a5aee25bc13ff29894e87354610f6b8b6a445e07e"
)
EXPECTED_REQUESTS = (
    ("today", "200"), ("list", "200"), ("search", "200"), ("open", "200"),
    ("create", "201"), ("complete", "200"), ("readback", "200"),
)
MEMORY_EVENTS = ("max", "oom", "oom_kill")
REQUIRED_FIELDS = {"phase", "epoch", "memory_current", "swap", "cpu_usec", *MEMORY_EVENTS}


def summarize(values):
    ordered = sorted(values)
    count = len(ordered)
    p95_rank = (95 * count + 99) // 100
    return {
        "samples": count,
        "p50": ordered[(count - 1) // 2],
        "p95": ordered[p95_rank - 1],
        "p95_rank": p95_rank,
        "max": ordered[-1],
    }


def evaluate_driver(lines, *, workload_bounds=False):
    def unique(prefix):
        records = [line for line in lines if line.startswith(prefix)]
        if len(records) != 1:
            raise ValueError(f"Expected one valid {prefix.rstrip(',')} record")
        return records[0]

    timing = unique("driver_seconds,")
    if not re.fullmatch(r"driver_seconds,[0-9]{1,3}\.[0-9]{3}(?:,[0-9]{1,3}\.[0-9]{3}){2}", timing):
        raise ValueError("Expected one valid driver_seconds record")
    seconds = tuple(Decimal(value) for value in timing.split(",")[1:])
    if workload_bounds and not MIN_DRIVER_SECONDS <= seconds[0] <= MAX_DRIVER_SECONDS:
        raise ValueError("Driver wall time is outside the fixed workload bounds")

    clock = unique("driver_clock,")
    clock_keys = ("uptime_start_cs", "uptime_end_cs", "user_start_usec", "system_start_usec", "user_end_usec", "system_end_usec")
    match = re.fullmatch("driver_clock,v1," + ",".join(key + r"=([0-9]{1,18})" for key in clock_keys), clock)
    if not match:
        raise ValueError("Invalid driver clock counters")
    start, end, user_start, system_start, user_end, system_end = map(int, match.groups())
    if end < start or user_end < user_start or system_end < system_start:
        raise ValueError("Driver clock and CPU counters must be monotonic")
    expected = (Decimal(end - start) / 100,
                Decimal((user_end - user_start) // 1000) / 1000,
                Decimal((system_end - system_start) // 1000) / 1000)
    if seconds != expected:
        raise ValueError("Driver timing does not match monotonic uptime and CPU counter deltas")

    cgroup = unique("driver_cgroup_receipt,")
    if not re.fullmatch(
        r"driver_cgroup_receipt,v1,workload_status=0,receipt_status=0,"
        r"memory\.max=83886080,memory\.swap\.max=0,memory\.swap\.current=0,"
        r"cpu\.max=100000 100000,max=0,oom=0,oom_kill=0,oom_group_kill=(?:absent|0)", cgroup
    ):
        raise ValueError("Invalid final driver cgroup receipt: require successful child, exact limits and zero events/swap")
    return {
        "wall_seconds": seconds[0], "user_seconds": seconds[1], "system_seconds": seconds[2],
        "clock": dict(zip(clock_keys, map(int, match.groups()), strict=True)),
        "memory_max_bytes": 80 * MIB, "memory_swap_max_bytes": 0, "memory_swap_current_bytes": 0,
        "cpu_max": "100000 100000", "max": 0, "oom": 0, "oom_kill": 0,
        "oom_group_kill": None if cgroup.endswith("=absent") else 0,
    }


def evaluate_receipt(lines, config_id, version):
    def matching_lines(prefix):
        return [line.removeprefix(prefix) for line in lines if line.startswith(prefix)]

    if matching_lines("benchmark_profile=") != [PROFILE]:
        raise ValueError(f"Expected benchmark profile {PROFILE}")
    driver = evaluate_driver(lines, workload_bounds=True)
    driver_seconds = driver["wall_seconds"]

    headers = matching_lines("cgroup_fields,")
    if len(headers) != 1:
        raise ValueError("Expected one cgroup sample header")
    header, = csv.reader(headers)
    if not REQUIRED_FIELDS.issubset(header) or len(set(header)) != len(header):
        raise ValueError("Incomplete or duplicate cgroup columns")

    samples = {"idle": [], "active": []}
    ordered = []
    for values in csv.reader(matching_lines("cgroup,"), strict=True):
        sample = dict(zip(header, values, strict=True))
        phase = sample.pop("phase")
        if phase not in samples or any(not re.fullmatch(r"[0-9]{1,20}", value) for value in sample.values()):
            raise ValueError("Invalid cgroup sample")
        sample = {key: int(value) for key, value in sample.items()}
        if not sample["memory_current"] or sample["memory_current"] > 192 * MIB:
            raise ValueError("Invalid cgroup memory reading")
        samples[phase].append(sample)
        ordered.append(sample)

    idle = samples["idle"]
    active = samples["active"]
    if len(idle) != 12 or len(active) < 50 or idle + active != ordered or any(
        not MIN_SAMPLE_GAP_SECONDS <= newer["epoch"] - older["epoch"] <= MAX_SAMPLE_GAP_SECONDS
        or newer["cpu_usec"] < older["cpu_usec"]
        for older, newer in zip(ordered, ordered[1:])
    ):
        raise ValueError("Expected ordered idle and active samples 5–8 seconds apart with monotonic counters")
    active_seconds = active[-1]["epoch"] - active[0]["epoch"]
    if abs(active_seconds - driver_seconds) > MAX_SAMPLE_GAP_SECONDS:
        raise ValueError("Active sample window does not match driver wall time")

    latencies = {route: [] for route, _ in EXPECTED_REQUESTS}
    requests = list(csv.reader(matching_lines("http,"), strict=True))
    if len(requests) != 105 * len(EXPECTED_REQUESTS):
        raise ValueError("Expected 105 complete request cycles")
    for (route, status, elapsed), expected in zip(requests, EXPECTED_REQUESTS * 105, strict=True):
        if (route, status) != expected or not re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,9})?", elapsed):
            raise ValueError("Invalid route, response status, or latency in request cycle")
        latencies[route].append(Decimal(elapsed) * 1000)
    request_seconds = sum(sum(values) for values in latencies.values()) / 1000
    if MIN_DRIVER_SECONDS + request_seconds > driver_seconds + Decimal("0.01"):
        raise ValueError("Driver wall time cannot contain the recorded requests and sleeps")

    idle_memory = summarize([sample["memory_current"] for sample in idle])
    active_memory = summarize([sample["memory_current"] for sample in active])
    cpu_usec = active[-1]["cpu_usec"] - active[0]["cpu_usec"]
    cpu_percent = Decimal(cpu_usec) / (active_seconds * 10_000)
    route_timings = {
        route: {**summarize(values), "over_limit": sum(value > ROUTE_LIMIT_MS for value in values)}
        for route, values in latencies.items()
    }

    images = matching_lines("image=")
    health = [json.loads(line) for line in lines if line.startswith('{"status":')]
    before = matching_lines("installed_canary_before=")
    after = matching_lines("installed_canary_after=")
    terminal_prefixes = (
        "workload,completed,", "driver_clock,", "driver_seconds,", "driver_cgroup_receipt,",
        *(f"{key} " for key in MEMORY_EVENTS), "probe_state=",
        "installed_canary_after=", "probe_cleanup=",
    )
    terminal_positions = [
        [index for index, line in enumerate(lines) if line.startswith(prefix)] for prefix in terminal_prefixes
    ]
    last_measurement = max(index for index, line in enumerate(lines) if line.startswith(("cgroup,", "http,")))
    terminal_ordered = all(len(positions) == 1 for positions in terminal_positions) and all(
        left[0] < right[0] for left, right in zip(terminal_positions, terminal_positions[1:])
    ) and last_measurement < terminal_positions[0][0]
    conditions = {
        "exact ARM64 config ID": len(images) == 1 and re.fullmatch(
            rf"{config_id} architecture=arm64 bytes=[1-9][0-9]*", images[0]
        ) is not None,
        "matching Canary version": len(health) == 1 and health[0].get("status") == "ok"
        and health[0].get("service") == "meitheal-web" and health[0].get("version") == version,
        "versioned measurement profile": matching_lines("benchmark_profile=") == [PROFILE],
        "exact parent checksum": matching_lines("driver_parent_script_sha256=") == [PARENT_SHA256]
        and sum(re.fullmatch(rf"{PARENT_SHA256}  .+/(?:green-canary-driver-parent|driver-parent-wrapper)\.sh", line) is not None for line in lines) == 1,
        "exact workload checksum": matching_lines("seed_and_driver_script_sha256=") == [WORKLOAD_SHA256]
        and sum(re.fullmatch(rf"{WORKLOAD_SHA256}  .+/seed-and-run\.sh", line) is not None for line in lines) == 1,
        "192 MiB, one CPU, zero swap": matching_lines("limits,") == ["201326592,0,100000 100000"],
        "seeded 2,000 tasks": lines.count('{"synthetic_tasks":2000}') == 1,
        "105 complete cycles": matching_lines("workload,completed,") == ["105"],
        "idle below 128 MiB": idle_memory["p95"] < IDLE_LIMIT_BYTES,
        "active below 160 MiB": active_memory["p95"] < ACTIVE_LIMIT_BYTES,
        "active CPU at or below 15%": cpu_percent <= CPU_LIMIT_PERCENT,
        "each route p95 at or below 350 ms": all(timing["p95"] <= ROUTE_LIMIT_MS for timing in route_timings.values()),
        "zero sampled and final memory events or swap": all(
            matching_lines(f"{key} ") == ["0"] for key in MEMORY_EVENTS
        ) and all(all(sample[key] == 0 for key in (*MEMORY_EVENTS, "swap")) for sample in ordered),
        "healthy probe and no restarts": matching_lines("probe_state=") == ["running health=healthy oom=false restarts=0"],
        "installed Canary unchanged and healthy": before == after and len(before) == 1 and re.fullmatch(
            r"sha256:[a-f0-9]{64} healthy [0-9]+ \S+ [a-f0-9]{64}", before[0]
        ) is not None,
        "terminal cleanup follows measurements and final health": terminal_ordered
        and next((line for line in reversed(lines) if line.strip()), "") == "probe_cleanup=complete",
        "pinned separate helper": matching_lines("helper_image=") == [FIXED_HELPER] and all(
            lines.count(marker) == 1 for marker in (
                "seed=separate_cgroup,same_loopback_namespace,disposable_data_volume,fixed_helper",
                "driver=separate_cgroup,same_loopback_namespace,fixed_helper",
            )
        ),
    }
    return {
        "profile": PROFILE,
        "script_sha256": {"workload": WORKLOAD_SHA256, "parent": PARENT_SHA256},
        "driver": driver,
        "config_id": config_id,
        "version": version,
        "checks": conditions,
        "driver_wall_seconds": driver_seconds,
        "active_sample_window_seconds": active_seconds,
        "memory_current_bytes": {
            "idle": {**idle_memory, "exclusive_limit": IDLE_LIMIT_BYTES},
            "active": {**active_memory, "exclusive_limit": ACTIVE_LIMIT_BYTES},
        },
        "memory_peak_bytes": max(sample["memory_peak"] for sample in ordered) if "memory_peak" in header else None,
        "active_cpu_percent_of_one_core": {
            "mean": cpu_percent,
            "inclusive_mean_limit": CPU_LIMIT_PERCENT,
            "intervals": summarize([
                Decimal(newer["cpu_usec"] - older["cpu_usec"]) / ((newer["epoch"] - older["epoch"]) * 10_000)
                for older, newer in zip(active, active[1:])
            ]),
            "throttle_count_delta": active[-1]["throttle_count"] - active[0]["throttle_count"]
            if "throttle_count" in header else None,
        },
        "loopback_full_response_ms": {"inclusive_p95_limit": ROUTE_LIMIT_MS, "routes": route_timings},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt")
    parser.add_argument("config_id", nargs="?")
    parser.add_argument("version", nargs="?")
    parser.add_argument("--driver-only", action="store_true", help="Check isolated helper telemetry only; never authorizes Green qualification")
    parser.add_argument("--report", action="store_true", help="Print JSON metrics even when a parsed receipt fails a gate")
    args = parser.parse_args()
    if args.driver_only:
        if args.config_id is not None or args.version is not None:
            parser.error("Driver-only checks do not accept image/version arguments")
    elif not re.fullmatch(r"sha256:[a-f0-9]{64}", args.config_id or "") or not re.fullmatch(r"[a-f0-9]{12}", args.version or ""):
        parser.error("Expected an exact image config ID and Canary version")
    try:
        with open(args.receipt, "rb") as receipt:
            contents = receipt.read(MAX_RECEIPT_BYTES + 1)
        if len(contents) > MAX_RECEIPT_BYTES:
            raise ValueError("Green receipt exceeds 1 MiB")
        lines = contents.decode().splitlines()
        result = evaluate_driver(lines) if args.driver_only else evaluate_receipt(lines, args.config_id, args.version)
        if args.report:
            print(json.dumps(result, indent=2, default=float))
        failures = [name for name, passed in result.get("checks", {}).items() if not passed]
        if failures:
            raise ValueError("Failed Green checks: " + ", ".join(failures))
    except (OSError, ValueError, csv.Error) as error:
        parser.exit(1, f"Green receipt rejected: {error}\n")


if __name__ == "__main__":
    main()
