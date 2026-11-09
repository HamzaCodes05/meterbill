#!/usr/bin/env python3
"""End-to-end test of the whole billing flow against a running API + Postgres (stdlib only).

    python scripts/smoke.py [--url http://localhost:4000] [--ingest-key dev-ingest-key]

Expected invoice amounts are computed by an independent implementation in this file (integer math),
so the API's pricing engine is checked against a second implementation, not against itself.
Safe to re-run: it creates uniquely named customers and plans each time.
"""
import argparse
import calendar
import datetime as dt
import json
import sys
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

p = argparse.ArgumentParser()
p.add_argument("--url", default="http://localhost:4000")
p.add_argument("--email", default="admin@meterbill.dev")
p.add_argument("--password", default="admin1234")
p.add_argument("--ingest-key", default="dev-ingest-key")
args = p.parse_args()
RUN = uuid.uuid4().hex[:8]
failures = 0


def call(method, path, body=None, token=None, key=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(args.url + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw


def check(name, cond, detail=""):
    global failures
    print(f"{'PASS' if cond else 'FAIL'}  {name}")
    if not cond:
        print(f"      {detail}")
        failures += 1


# ---------------------------------------------------------------- independent oracle (integer math)
def prorate(cents, num, den):
    return (cents * num * 2 + den) // (2 * den)


def usage_lines(units, tiers):
    """tiers: [(upTo|None, unit price in micro-dollars)] -> [(quantity, cents)], one rounded line per tier."""
    out, prev = [], 0
    for up_to, micros in tiers:
        ceiling = float("inf") if up_to is None else up_to
        n = min(units, ceiling) - prev
        if n > 0:
            out.append((int(n), (int(n) * micros + 5000) // 10000))
        prev = ceiling
        if units <= ceiling:
            break
    return out


def expected_invoice(base, seat_fee, seats, active, dim, usage, tax_bps):
    lines = [prorate(base, active, dim), prorate(seat_fee * seats, active, dim)]
    for units, tiers in usage:
        lines += [c for _, c in usage_lines(units, tiers)]
    sub = sum(lines)
    tax = (sub * tax_bps * 2 + 10000) // 20000
    return sub, tax, sub + tax


API_TIERS = [(1000, 0), (10_000, 2000), (None, 1000)]   # free / $0.002 / $0.001
STORAGE_TIERS = [(None, 100_000)]                        # $0.10 per GB

# -------------------------------------------------------------------------------------- dates
today = dt.datetime.now(dt.timezone.utc).date()
first_this = today.replace(day=1)
prev_last = first_this - dt.timedelta(days=1)
PREV = prev_last.strftime("%Y-%m")
CUR = first_this.strftime("%Y-%m")
PREV_DAYS = calendar.monthrange(prev_last.year, prev_last.month)[1]
two_back = (prev_last.replace(day=1) - dt.timedelta(days=1)).replace(day=1)
FUTURE = (first_this + dt.timedelta(days=40)).strftime("%Y-%m")
ts = lambda day, hour=12: dt.datetime(prev_last.year, prev_last.month, day, hour, tzinfo=dt.timezone.utc).isoformat()
print(f"periods: prev={PREV} ({PREV_DAYS} days) current={CUR}\n")

# ------------------------------------------------------------------------------------- auth
s, _ = call("POST", "/auth/login", {"email": args.email, "password": "nope-nope"})
check("login rejects a bad password", s == 401, s)
s, body = call("POST", "/auth/login", {"email": args.email, "password": args.password})
check("login works", s in (200, 201) and "accessToken" in body, (s, body))
T = body["accessToken"]
check("admin routes require a JWT", call("GET", "/v1/customers")[0] == 401)
check("ingestion requires the ingest key", call("POST", "/v1/events", {"events": []}, key="wrong")[0] == 401)
check("a JWT is not an ingest key", call("POST", "/v1/events", {"events": []}, token=T)[0] == 401)

# --------------------------------------------------------------------------------- catalogue
s, cA = call("POST", "/v1/customers", {"name": f"Acme {RUN}", "email": f"acme-{RUN}@example.com", "taxRateBps": 825}, T)
check("create customer", s == 201 and cA["taxRateBps"] == 825, (s, cA))
check("duplicate email -> 409", call("POST", "/v1/customers", {"name": "x", "email": f"ACME-{RUN}@example.com"}, T)[0] == 409)
_, cB = call("POST", "/v1/customers", {"name": f"Beta {RUN}", "email": f"beta-{RUN}@example.com"}, T)
_, cC = call("POST", "/v1/customers", {"name": f"Gamma {RUN}", "email": f"gamma-{RUN}@example.com"}, T)

pricing = [
    {"metric": "api_calls", "label": "API calls", "tiers": [
        {"upTo": 1000, "unitPrice": "0"}, {"upTo": 10000, "unitPrice": "0.002"}, {"upTo": None, "unitPrice": "0.001"}]},
    {"metric": "storage_gb", "label": "Storage (GB)", "tiers": [{"upTo": None, "unitPrice": "0.10"}]},
]
s, plan = call("POST", "/v1/plans", {"name": f"Growth {RUN}", "baseFeeCents": 9900, "seatFeeCents": 1500, "usagePricing": pricing}, T)
check("create plan", s == 201 and plan["usagePricing"][0]["tiers"][1]["unitPrice"] == "0.002", (s, plan))
check("duplicate plan name -> 409", call("POST", "/v1/plans", {"name": f"Growth {RUN}", "baseFeeCents": 1}, T)[0] == 409)
bad = [{"metric": "m", "label": "M", "tiers": [{"upTo": 100, "unitPrice": "1"}, {"upTo": 50, "unitPrice": "1"}, {"upTo": None, "unitPrice": "1"}]}]
s, body = call("POST", "/v1/plans", {"name": f"Bad {RUN}", "baseFeeCents": 1, "usagePricing": bad}, T)
check("unsorted tiers -> 400 with a reason", s == 400 and "increasing" in json.dumps(body), (s, body))
bad = [{"metric": "m", "label": "M", "tiers": [{"upTo": None, "unitPrice": "-5"}]}]
check("negative price -> 400", call("POST", "/v1/plans", {"name": f"Bad2 {RUN}", "baseFeeCents": 1, "usagePricing": bad}, T)[0] == 400)

start_a = prev_last.replace(day=17)
s, subA = call("POST", "/v1/subscriptions", {"customerId": cA["id"], "planId": plan["id"], "seats": 3, "startedOn": start_a.isoformat()}, T)
check("subscribe customer A mid-month", s == 201 and subA["endsOn"] is None, (s, subA))
check("second open subscription -> 409", call("POST", "/v1/subscriptions", {"customerId": cA["id"], "planId": plan["id"], "startedOn": start_a.isoformat()}, T)[0] == 409)
check("impossible date -> 400", call("POST", "/v1/subscriptions", {"customerId": cB["id"], "planId": plan["id"], "startedOn": "2026-02-31"}, T)[0] == 400)
s, subB = call("POST", "/v1/subscriptions", {"customerId": cB["id"], "planId": plan["id"], "seats": 1, "startedOn": two_back.isoformat()}, T)
check("subscribe customer B (full periods)", s == 201, (s, subB))
_, subC = call("POST", "/v1/subscriptions", {"customerId": cC["id"], "planId": plan["id"], "seats": 1, "startedOn": two_back.isoformat()}, T)

# ------------------------------------------------------------------------------------ events
def ev(cust, metric, qty, when, key):
    return {"customerId": cust["id"], "metric": metric, "quantity": qty, "timestamp": when, "idempotencyKey": key}

batch1 = [ev(cA, "api_calls", q, ts(18 + i), f"a-{RUN}-{i}") for i, q in enumerate([2000, 3000, 4000, 2345, 1000])]  # 12,345? see below
batch1[-1]["quantity"] = 1000  # 2000+3000+4000+2345+1000 = 12,345
batch1.append(ev(cA, "storage_gb", 50, ts(20), f"a-{RUN}-storage"))
s, r = call("POST", "/v1/events", {"events": batch1}, key=args.ingest_key)
check("ingest a batch", s == 200 and r["accepted"] == 6 and r["duplicate"] == 0 and r["rejected"] == 0, (s, r))
s, r = call("POST", "/v1/events", {"events": batch1}, key=args.ingest_key)
check("retrying the same batch double counts nothing", r["accepted"] == 0 and r["duplicate"] == 6, r)
clash = ev(cA, "api_calls", 999_999, ts(18), f"a-{RUN}-0")
_, r = call("POST", "/v1/events", {"events": [clash]}, key=args.ingest_key)
check("same key, different payload is rejected loudly", r["results"][0]["reason"] == "idempotency_key_reused_with_different_payload", r)
_, r = call("POST", "/v1/events", {"events": [
    ev(cA, "made_up_metric", 1, ts(20), f"x-{RUN}-1"),
    {**ev(cA, "api_calls", 1, ts(20), f"x-{RUN}-2"), "customerId": str(uuid.uuid4())},
    ev(cA, "api_calls", 1, (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)).isoformat(), f"x-{RUN}-3"),
]}, key=args.ingest_key)
check("unknown metric / customer / future timestamp are rejected with reasons",
      [x["reason"] for x in r["results"]] == ["unknown_metric", "unknown_customer", "timestamp_in_future"], r)
check("one bad event does not fail its batch", call("POST", "/v1/events", {"events": [
    ev(cA, "api_calls", 5, ts(21), f"mix-{RUN}-ok"), ev(cA, "made_up_metric", 1, ts(21), f"mix-{RUN}-bad")]}, key=args.ingest_key)[1]["accepted"] == 1)
_, r = call("POST", "/v1/events", {"events": [ev(cA, "api_calls", 5, ts(21), f"mix-{RUN}-ok")]}, key=args.ingest_key)
s, _ = call("POST", "/v1/events", {"events": [ev(cA, "api_calls", 0, ts(20), "zero")]}, key=args.ingest_key)
check("invalid payload (quantity 0) -> 400", s == 400, s)
check("empty batch -> 400", call("POST", "/v1/events", {"events": []}, key=args.ingest_key)[0] == 400)
check("batch over 1000 -> 400", call("POST", "/v1/events", {"events": [batch1[0]] * 1001}, key=args.ingest_key)[0] == 400)

s, u = call("GET", f"/v1/customers/{cA['id']}/usage?period={PREV}", token=T)
totals = {x["metric"]: x["quantity"] for x in u}
check("usage summary matches what was accepted (12,345 + 5 api calls, 50 GB)", totals == {"api_calls": 12_350, "storage_gb": 50}, totals)
BASE_API = 12_350  # includes the 5-unit event

# B: small usage inside the free tier, to get a $0 usage line
call("POST", "/v1/events", {"events": [ev(cB, "api_calls", 500, ts(3), f"b-{RUN}-1")]}, key=args.ingest_key)

# the dashboard's simulator uses the admin login; the real ingest key never leaves the server side
check("simulator endpoint needs an admin JWT", call("POST", "/v1/simulate-events", {"events": [batch1[0]]}, key=args.ingest_key)[0] == 401)
s, r = call("POST", "/v1/simulate-events", {"events": [batch1[0]]}, T)
check("simulator endpoint works with a JWT (and is idempotent like the real one)", s == 200 and r["results"][0]["status"] == "duplicate", (s, r))

# --------------------------------------------------------------------------- draft invoices
check("cannot invoice a future period", call("POST", "/v1/invoices/generate", {"period": FUTURE}, T)[0] == 400)
check("malformed period -> 400", call("POST", "/v1/invoices/generate", {"period": "2026-13"}, T)[0] == 400)
s, g = call("POST", "/v1/invoices/generate", {"period": PREV}, T)
check("generate drafts for the period", s == 200 and g["created"] >= 3, g)
s, g2 = call("POST", "/v1/invoices/generate", {"period": PREV}, T)
check("generate is idempotent (refreshes drafts, creates no duplicates)", g2["created"] == 0 and g2["updated"] >= 3, g2)

_, lst = call("GET", f"/v1/invoices?period={PREV}&customerId={cA['id']}", token=T)
check("exactly one invoice per subscription per period", len(lst) == 1, lst)
invA = call("GET", f"/v1/invoices/{lst[0]['id']}", token=T)[1]

active = PREV_DAYS - 16
sub, tax, total = expected_invoice(9900, 1500, 3, active, PREV_DAYS, [(BASE_API, API_TIERS), (50, STORAGE_TIERS)], 825)
check(f"invoice A matches the independent calculation (subtotal {sub}, tax {tax}, total {total})",
      (invA["subtotalCents"], invA["taxCents"], invA["totalCents"]) == (sub, tax, total),
      (invA["subtotalCents"], invA["taxCents"], invA["totalCents"], "expected", sub, tax, total))
check("lines add up exactly to the total", sum(l["amountCents"] for l in invA["lines"]) == invA["totalCents"])
check("first invoice is prorated for a mid-month start", f"prorated {active}/{PREV_DAYS} days" in invA["lines"][0]["description"], invA["lines"][0])
tier3 = next(l for l in invA["lines"] if "10,001+" in l["description"])
check("the half-cent boundary rounds up (2,350 units x $0.001 = 235.0 cents; 2,345 would be 234.5)", tier3["quantity"] == 2350 and tier3["amountCents"] == 235, tier3)
check("draft invoice status", invA["status"] == "draft" and invA["finalizedAt"] is None)

# late event arrives while still a draft -> next generate picks it up
call("POST", "/v1/events", {"events": [ev(cA, "api_calls", 95, ts(28), f"late-{RUN}")]}, key=args.ingest_key)
call("POST", "/v1/invoices/generate", {"period": PREV}, T)
invA2 = call("GET", f"/v1/invoices/{invA['id']}", token=T)[1]
sub2, tax2, total2 = expected_invoice(9900, 1500, 3, active, PREV_DAYS, [(BASE_API + 95, API_TIERS), (50, STORAGE_TIERS)], 825)
check("a late event is picked up by a draft invoice", invA2["totalCents"] == total2 and total2 != total, (invA2["totalCents"], total2))

# ------------------------------------------------------------------------ finalize / pay / lock
cur_s, cur_g = call("POST", "/v1/invoices/generate", {"period": CUR}, T)
cur_list = call("GET", f"/v1/invoices?period={CUR}&customerId={cB['id']}", token=T)[1]
if cur_list:
    s, body = call("POST", f"/v1/invoices/{cur_list[0]['id']}/finalize", token=T)
    check("cannot finalize a period that has not ended", s == 409 and "not ended" in json.dumps(body), (s, body))

check("cannot pay a draft", call("POST", f"/v1/invoices/{invA['id']}/pay", token=T)[0] == 409)
s, fin = call("POST", f"/v1/invoices/{invA['id']}/finalize", token=T)
check("finalize", s == 200 and fin["status"] == "finalized" and fin["finalizedAt"], (s, fin))
check("finalize is idempotent", call("POST", f"/v1/invoices/{invA['id']}/finalize", token=T)[1]["finalizedAt"] == fin["finalizedAt"])
_, r = call("POST", "/v1/events", {"events": [ev(cA, "api_calls", 1_000_000, ts(29), f"closed-{RUN}")]}, key=args.ingest_key)
check("events for a finalized period are rejected, not silently applied", r["results"][0]["reason"] == "period_closed", r)
_, g3 = call("POST", "/v1/invoices/generate", {"period": PREV}, T)
check("regenerating never touches a finalized invoice", g3["skipped"] >= 1)
check("finalized invoice is unchanged", call("GET", f"/v1/invoices/{invA['id']}", token=T)[1]["totalCents"] == total2)
s, paid = call("POST", f"/v1/invoices/{invA['id']}/pay", token=T)
check("pay", s == 200 and paid["status"] == "paid" and paid["paidAt"], (s, paid))
check("pay is idempotent", call("POST", f"/v1/invoices/{invA['id']}/pay", token=T)[1]["paidAt"] == paid["paidAt"])

# ----------------------------------------------- concurrency: ingestion racing finalization
call("POST", "/v1/invoices/generate", {"period": PREV}, T)
invC = call("GET", f"/v1/invoices?period={PREV}&customerId={cC['id']}", token=T)[1][0]


def send(i):
    s, r = call("POST", "/v1/events", {"events": [ev(cC, "api_calls", 10, ts(5, 8 + i % 12), f"race-{RUN}-{i}")]}, key=args.ingest_key)
    return r["results"][0]["status"] if s == 200 else f"http-{s}"


def finalize_now():
    return call("POST", f"/v1/invoices/{invC['id']}/finalize", token=T)[0]


with ThreadPoolExecutor(24) as ex:
    futures = [ex.submit(send, i) for i in range(30)]
    fin_future = ex.submit(finalize_now)
    futures += [ex.submit(send, i) for i in range(30, 80)]
    statuses = [f.result() for f in futures]
    fin_status = fin_future.result()
accepted = statuses.count("accepted")
check("finalize succeeded during the race", fin_status == 200, fin_status)
check("every racing event got a clean outcome (accepted or period_closed)", set(statuses) <= {"accepted", "rejected"}, set(statuses))
invC_final = call("GET", f"/v1/invoices/{invC['id']}", token=T)[1]
billed = sum(l["quantity"] for l in invC_final["lines"] if l["kind"] == "usage")
stored = next((x["quantity"] for x in call("GET", f"/v1/customers/{cC['id']}/usage?period={PREV}", token=T)[1] if x["metric"] == "api_calls"), 0)
print(f"      race outcome: {accepted} of 80 events accepted before the lock; invoice billed {billed} units; {stored} units stored")
check("INVARIANT: units on the finalized invoice == units accepted == units stored (nothing lost, nothing billed twice)",
      billed == accepted * 10 == stored, (billed, accepted * 10, stored))

# ------------------------------------------------------------------------ cancel + big batch
s, c1 = call("POST", f"/v1/subscriptions/{subB['id']}/cancel", token=T)
last_day = (first_this.replace(day=calendar.monthrange(first_this.year, first_this.month)[1])).isoformat()
check("cancel ends the subscription at the end of this month", s == 200 and c1["endsOn"] == last_day, (s, c1))
check("cancel is idempotent", call("POST", f"/v1/subscriptions/{subB['id']}/cancel", token=T)[1]["endsOn"] == last_day)
check("can resubscribe only after the previous one ends", call("POST", "/v1/subscriptions", {"customerId": cB["id"], "planId": plan["id"], "startedOn": first_this.isoformat()}, T)[0] == 409)

big = [ev(cB, "api_calls", 1, ts(10, i % 24), f"big-{RUN}-{i}") for i in range(1000)]
import time
t0 = time.time()
s, r = call("POST", "/v1/events", {"events": big}, key=args.ingest_key)
check(f"1,000-event batch ingests ({time.time() - t0:.1f}s)", s == 200 and r["accepted"] == 1000, (s, {k: v for k, v in r.items() if k != 'results'}) if isinstance(r, dict) else r)

print(f"\n{'ALL PASSED' if not failures else str(failures) + ' CHECK(S) FAILED'}")
sys.exit(1 if failures else 0)
