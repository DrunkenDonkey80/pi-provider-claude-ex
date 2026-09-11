"""
Which pooled account should we switch to next?

Compares the shipped picker (max headroom = 100 - max(pct5, pct7)) against a
time-aware "slack" score, over a simulated month of bursty weekday work.

    slack_w = leftover_fraction - remaining_time_fraction        (per window)
    score   = A * slack_7d + B * slack_5h

slack > 0 means "you have more quota left than time left to spend it" — burn it.
slack < 0 means "you're ahead of budget" — save it. Scale-free, so the 5h and
7d windows are directly comparable without unit juggling.

    python pick-sim.py
"""

import random
from statistics import mean

HOUR = 3600
W5 = 5 * HOUR
W7 = 7 * 24 * HOUR
STEP = 300  # 5 minutes
WEEKS = 4


class Account:
    """One pooled login: a 5-hour window that starts on first use and a fixed
    weekly window."""

    def __init__(self, name, cap5, cap7, week_start):
        self.name = name
        self.cap5, self.cap7 = cap5, cap7
        self.used5 = self.used7 = 0.0
        self.reset5 = None  # None => 5h window not started yet
        self.reset7 = week_start
        self.wasted = 0.0

    def tick(self, t):
        if self.reset5 is not None and t >= self.reset5:
            self.used5, self.reset5 = 0.0, None
        if t >= self.reset7:
            self.wasted += self.cap7 - self.used7
            self.used7 = 0.0
            self.reset7 += W7

    @property
    def room(self):
        return max(0.0, min(self.cap5 - self.used5, self.cap7 - self.used7))

    def consume(self, t, units):
        if self.reset5 is None:
            self.reset5 = t + W5
        take = min(units, self.room)
        self.used5 += take
        self.used7 += take
        return take

    # What the extension actually sees: percentages plus reset timestamps.
    def view(self, t):
        return {
            "pct5": 100 * self.used5 / self.cap5,
            "pct7": 100 * self.used7 / self.cap7,
            "t5": (self.reset5 - t) if self.reset5 else W5,
            "t7": self.reset7 - t,
        }


# ─── pickers ────────────────────────────────────────────────────────────────
def pick_headroom(accounts, t):
    """Shipped today: most remaining quota in the tightest window."""
    return max(accounts, key=lambda a: 100 - max(a.view(t)["pct5"], a.view(t)["pct7"]))


def slack_picker(A, B):
    def pick(accounts, t):
        def score(a):
            v = a.view(t)
            slack7 = (1 - v["pct7"] / 100) - v["t7"] / W7
            slack5 = (1 - v["pct5"] / 100) - v["t5"] / W5
            return A * slack7 + B * slack5

        return max(accounts, key=score)

    pick.__name__ = f"slack(A={A},B={B})"
    return pick


def pick_random(accounts, t):
    return random.choice(accounts)


# ─── simulation ─────────────────────────────────────────────────────────────
def run(picker, seed, plans, demand_scale=1.0, sticky=True):
    rng = random.Random(seed)
    accounts = [
        Account(f"{p}{i}", cap5, cap7, week_start=(i % 3) * 2 * 24 * HOUR)
        for i, (p, cap5, cap7) in enumerate(plans)
    ]
    active = accounts[0]
    served = lost = 0.0

    for step in range(WEEKS * 7 * 24 * HOUR // STEP):
        t = step * STEP
        for a in accounts:
            a.tick(t)

        hour = (t // HOUR) % 24
        weekday = (t // (24 * HOUR)) % 7 < 5
        busy = weekday and 9 <= hour < 19 and rng.random() < 0.55
        demand = rng.uniform(0.5, 1.5) * demand_scale if busy else 0.0
        if not demand:
            continue

        # The pool keeps using the pinned account while it still has room —
        # a switch only happens when it runs dry (mirrors pickActive).
        if not sticky or active.room <= 0:
            usable = [a for a in accounts if a.room > 0]
            if not usable:
                lost += demand
                continue
            active = picker(usable, t)

        got = active.consume(t, demand)
        served += got
        lost += demand - got

    # Unused weekly quota still sitting in the open window at sim end.
    wasted = sum(a.wasted for a in accounts)
    return served, lost, wasted


def evaluate(picker, plans, scale, seeds=range(12), sticky=True):
    rows = [run(picker, s, plans, scale, sticky) for s in seeds]
    return (
        mean(r[0] for r in rows),
        mean(r[1] for r in rows),
        mean(r[2] for r in rows),
    )


# Caps are in the same units as demand (~1 unit per busy 5-minute step, ~330
# units of demand per week), sized so BOTH windows actually bind: a busy day
# drains a 5h window in a few hours, and the weekly budget is the scarce one.
POOLS = {
    "flex's pool (pro + 2 team)": [
        ("pro", 20, 110),
        ("team", 30, 200),
        ("team", 30, 200),
    ],
    "three equal pro": [("pro", 20, 110)] * 3,
    "one big + two small": [("team", 40, 260), ("pro", 15, 80), ("pro", 15, 80)],
}

if __name__ == "__main__":
    candidates = [
        ("current (max headroom)", pick_headroom),
        ("random", pick_random),
        ("slack 7d only", slack_picker(1.0, 0.0)),
        ("slack 5h only", slack_picker(0.0, 1.0)),
        ("slack A=1 B=1", slack_picker(1.0, 1.0)),
        ("slack A=2 B=1", slack_picker(2.0, 1.0)),
        ("slack A=3 B=1", slack_picker(3.0, 1.0)),
        ("slack A=1 B=2", slack_picker(1.0, 2.0)),
        ("slack A=1 B=3", slack_picker(1.0, 3.0)),
        ("slack A=4 B=1", slack_picker(4.0, 1.0)),
    ]
    # Non-sticky: re-pick on every burst. This is the only regime where the 5h
    # term can discriminate — sticky use drains a 5h window to zero before
    # abandoning it, so every rival's slack5 is identical.
    plans = POOLS["flex's pool (pro + 2 team)"]
    for scale, label in ((1.5, "demand ≈ capacity"), (2.2, "demand > capacity")):
        print(f"\n=== NON-STICKY (re-pick every burst) — {label} ===")
        print(f"{'picker':24} {'served':>9} {'lost':>8} {'wasted wk':>10}")
        for name, picker in candidates:
            served, lost, wasted = evaluate(picker, plans, scale, sticky=False)
            print(f"{name:24} {served:9.0f} {lost:8.0f} {wasted:10.0f}")

    for pool_name, plans in POOLS.items():
        for scale, label in (
            (1.0, "demand < capacity"),
            (1.5, "demand ≈ capacity"),
            (2.2, "demand > capacity"),
        ):
            print(f"\n=== {pool_name} — {label} ===")
            print(f"{'picker':24} {'served':>9} {'lost':>8} {'wasted wk':>10}")
            for name, picker in candidates:
                served, lost, wasted = evaluate(picker, plans, scale)
                print(f"{name:24} {served:9.0f} {lost:8.0f} {wasted:10.0f}")
