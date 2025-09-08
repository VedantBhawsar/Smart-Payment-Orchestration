"""
simulator.py
Simulate many transactions and compute fee savings
Requires: requests (if hitting server) OR run purely locally by importing orchestrator logic rewritten in python.
This sample runs offline comparing processors.json fees directly.
"""

import random
import json
from statistics import mean

# Load processors and rules (copy the JSON content or load files)
processors = [
    {"name":"Stripe","fee_percentage":0.029,"fee_flat_cents":30,"settlement_time_days":2,"success_rate":0.98,"supports_card":True,"supports_ach":True,"instant_payout":False},
    {"name":"LocalProcessorA","fee_percentage":0.025,"fee_flat_cents":25,"settlement_time_days":1,"success_rate":0.965,"supports_card":True,"supports_ach":False,"instant_payout":False},
    {"name":"FastPayout","fee_percentage":0.034,"fee_flat_cents":10,"settlement_time_days":0,"success_rate":0.96,"supports_card":True,"supports_ach":False,"instant_payout":True},
    {"name":"ACHProvider","fee_percentage":0.008,"fee_flat_cents":25,"settlement_time_days":3,"success_rate":0.99,"supports_card":False,"supports_ach":True,"instant_payout":False}
]

def fee_cents(proc, amount_cents):
    return round(amount_cents * proc['fee_percentage'] + proc['fee_flat_cents'])

def pick_by_simple_rules(amount_cents, method, merchant_sensitivity):
    # Simplified port of orchestrator score in python
    stripe = next(p for p in processors if p['name']=='Stripe')
    candidates = [p for p in processors if (method=='card' and p['supports_card']) or (method=='ach' and p['supports_ach'])]
    best = None
    best_score = -999
    for p in candidates:
        fee = fee_cents(p, amount_cents)
        stripe_fee = fee_cents(stripe, amount_cents)
        saving_pct_vs_stripe = (stripe_fee - fee) / stripe_fee if stripe_fee>0 else 0
        settlement_factor = max(0, 1 - (p['settlement_time_days'] * merchant_sensitivity / 5))
        settlement_score = min(1, max(0, settlement_factor))
        risk_score = p['success_rate']
        bonus = 0
        if saving_pct_vs_stripe >= 0.02:
            bonus += 1.5
        if p.get('instant_payout'):
            bonus += 1.0
        if merchant_sensitivity > 0.85 and p['settlement_time_days'] > 1:
            bonus -= 2.0
        score = (10 * max(0,saving_pct_vs_stripe)) + (4 * settlement_score) + (6 * risk_score) + bonus
        if p['success_rate'] < 0.90:
            continue
        if score > best_score:
            best_score = score
            best = p
    if best is None:
        # fallback: highest success_rate
        best = sorted(candidates, key=lambda x: -x['success_rate'])[0]
    return best

def run_simulation(n=10000):
    amounts = [random.choice([500, 1200, 2500, 10000]) for _ in range(n)]
    methods = ['card'] * n  # mostly cards for this simulator
    merchant_sensitivities = [random.uniform(0,1) for _ in range(n)]
    stripe_fees = []
    orchestrated_fees = []
    chosen_counts = {}
    for amt, mth, sens in zip(amounts, methods, merchant_sensitivities):
        stripe = next(p for p in processors if p['name']=='Stripe')
        stripe_fee = fee_cents(stripe, amt)
        stripe_fees.append(stripe_fee)
        chosen = pick_by_simple_rules(amt, mth, sens)
        orchestrated_fee = fee_cents(chosen, amt)
        orchestrated_fees.append(orchestrated_fee)
        chosen_counts[chosen['name']] = chosen_counts.get(chosen['name'],0)+1

    avg_stripe = mean(stripe_fees)
    avg_orch = mean(orchestrated_fees)
    reduction_pct = (avg_stripe - avg_orch) / avg_stripe * 100
    print("Avg stripe fee (cents):", avg_stripe)
    print("Avg orchestrated fee (cents):", avg_orch)
    print("Average per-transaction fee reduction (relative %): {:.2f}%".format(reduction_pct))
    print("Choice distribution:", chosen_counts)


if __name__ == "__main__":
    run_simulation(5000)
