#!/usr/bin/env python3
"""Stress test for the core invariant: a finalized invoice is exactly the usage that was accepted.

Many events are fired at a customer while its invoice is finalized at a random moment mid-flood.
For every trial:   units on invoice == units of events that were accepted == units stored.
If ingestion and finalization were not serialised, an event could be accepted yet missed by the
invoice (silent lost revenue) or billed yet rejected. This test must fail if the lock is removed.

    python scripts/race.py [--trials 20] [--events 120]
"""
import argparse
import calendar
import datetime as dt
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

p = argparse.ArgumentParser()
p.add_argument("--url", default="http://localhost:4000")
p.add_argument("--trials", type=int, default=20)
p.add_argument("--events", type=int, default=600)
p.add_argument("--ingest-key", default="dev-ingest-key")
args = p.parse_args()
RUN = uuid.uuid4().hex[:8]


def call(method, path, body=None, token=None, key=None):
    h = {"content-type": "application/json"}
    if token: h["authorization"] = f"Bearer {token}"
    if key: h["x-api-key"] = key
    req = urllib.request.Request(args.url + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode(); return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


T = call("POST", "/auth/login", {"email": "admin@meterbill.dev", "password": "admin1234"})[1]["accessToken"]
today = dt.datetime.now(dt.timezone.utc).date()
prev_last = today.replace(day=1) - dt.timedelta(days=1)
PREV = prev_last.strftime("%Y-%m")
start = (prev_last.replace(day=1) - dt.timedelta(days=1)).replace(day=1).isoformat()
plan = call("POST", "/v1/plans", {"name": f"Race {RUN}", "baseFeeCents": 100, "usagePricing": [
    {"metric": "api_calls", "label": "API", "tiers": [{"upTo": None, "unitPrice": "0.001"}]}]}, T)[1]

bad = contested = 0
for trial in range(args.trials):
    cust = call("POST", "/v1/customers", {"name": f"R{trial}", "email": f"r{trial}-{RUN}@example.com"}, T)[1]
    call("POST", "/v1/subscriptions", {"customerId": cust["id"], "planId": plan["id"], "startedOn": start}, T)
    call("POST", "/v1/invoices/generate", {"period": PREV}, T)
    inv = call("GET", f"/v1/invoices?period={PREV}&customerId={cust['id']}", token=T)[1][0]

    def send(i):
        when = dt.datetime(prev_last.year, prev_last.month, 5, i % 24, tzinfo=dt.timezone.utc).isoformat()
        s, r = call("POST", "/v1/events", {"events": [{"customerId": cust["id"], "metric": "api_calls", "quantity": 7,
                    "timestamp": when, "idempotencyKey": f"t{trial}-{i}"}]}, key=args.ingest_key)
        return r["results"][0]["status"] if s == 200 else f"http-{s}"

    # Fire finalize once a random 10-60% of the events have completed, so it always lands mid-flood.
    done, lock = [0], threading.Lock()
    threshold = random.randint(args.events // 10, args.events * 6 // 10)  # leaves plenty still unsent
    go = threading.Event()

    def tracked(i):
        go.wait()
        out = send(i)
        with lock:
            done[0] += 1
        return out

    result = {}

    def fin():
        go.wait()
        while done[0] < threshold:
            time.sleep(0.0005)
        result["code"] = call("POST", f"/v1/invoices/{inv['id']}/finalize", token=T)[0]

    # Finalize runs on its OWN thread. (Submitting it to the same pool as the events would queue it
    # behind every event, so it could not start until they were all dispatched: no race at all.)
    finalizer = threading.Thread(target=fin)
    finalizer.start()
    with ThreadPoolExecutor(32) as ex:  # far fewer threads than events: many are still unsent when finalize fires
        sends = [ex.submit(tracked, i) for i in range(args.events)]
        go.set()
        statuses = [x.result() for x in sends]
    finalizer.join()
    fin_code = result.get("code")

    accepted = statuses.count("accepted") * 7
    final = call("GET", f"/v1/invoices/{inv['id']}", token=T)[1]
    billed = sum(l["quantity"] for l in final["lines"] if l["kind"] == "usage")
    stored = next((x["quantity"] for x in call("GET", f"/v1/customers/{cust['id']}/usage?period={PREV}", token=T)[1]), 0)
    ok = fin_code == 200 and billed == accepted == stored and final["status"] == "finalized"
    bad += not ok
    mid = 0 < statuses.count("accepted") < args.events
    rejected = statuses.count("rejected")
    contested += mid
    print(f"trial {trial:>2}: accepted={accepted // 7:>3} rejected={rejected:>3} | billed={billed:>5} stored={stored:>5} units {'mid-flood' if mid else 'EDGE (not contested)'} {'OK' if ok else '*** INVARIANT BROKEN ***'}")

print(f"\n{contested}/{args.trials} trials were genuinely contested (finalize landed mid-flood)")
print(f"{'ALL TRIALS HELD' if not bad else str(bad) + ' TRIAL(S) BROKE THE INVARIANT'}")
sys.exit(1 if bad else 0)
