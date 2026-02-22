# Smart Payment Orchestration

A rule-based payment orchestration microservice that routes transactions to the optimal payment processor to reduce per-transaction fees and improve cash flow. The engine targets approximately **5.8% fee cost reduction** relative to always using Stripe as the default processor.

---

## Table of Contents

- [Overview](#overview)
- [Design & Rationale](#design--rationale)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Running the Server](#running-the-server)
- [API Reference](#api-reference)
  - [POST /decide](#post-decide)
- [Configuration](#configuration)
  - [Processors (processors.json)](#processors-processorsjson)
  - [Rules (rules.json)](#rules-rulesjson)
- [Scoring Logic](#scoring-logic)
- [Fee Simulator](#fee-simulator)
- [Database Schema & Ledger Guidelines](#database-schema--ledger-guidelines)
- [Deployment Notes](#deployment-notes)
- [Alternatives & Extensions](#alternatives--extensions)

---

## Overview

Payment orchestration sits between your application and multiple payment processors. Instead of sending every transaction to a single provider (e.g., Stripe), the engine scores each available processor in real time and selects the best one based on:

- **Fee cost** — percentage + flat-rate fees relative to Stripe
- **Settlement speed** — how quickly funds are available (0–3 days)
- **Success rate / risk** — historical transaction success rate
- **Merchant preferences** — cash-flow sensitivity (need for immediate settlement)
- **Payment method support** — card vs. ACH

---

## Design & Rationale

### Why rule-based scoring?

Rule-based systems are transparent, auditable, and fast. Every routing decision can be explained with a human-readable reason. This is important in payments where compliance, debugging, and merchant trust are critical.

### Key tradeoffs

| Concern | Decision |
|---|---|
| Transparency vs. ML | Rule-based scoring chosen over ML for auditability and zero training data requirement |
| Fee vs. settlement speed | Both are weighted; merchants declare their sensitivity via `cash_flow_sensitivity` |
| Fallback safety | If no processor passes strict constraints, the highest-success-rate processor wins |
| Extensibility | Processors and rules live in JSON files — swappable without code changes |

### Why these weights?

The scoring formula is:

```
score = (fee_weight × fee_saving%)
      + (settlement_weight × settlement_score)
      + (risk_weight × success_rate)
      + bonuses/penalties
```

- **Fee weight (10)** is highest because reducing fees is the primary objective.
- **Risk weight (6)** is second because a failed transaction costs more than any fee.
- **Settlement weight (4)** is lower but still significant, modulated per-merchant by `cash_flow_sensitivity`.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Client Application                 │
└───────────────────────┬─────────────────────────────┘
                        │ POST /decide
                        ▼
┌─────────────────────────────────────────────────────┐
│              Express API Server (src/index.js)      │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│         Orchestrator Engine (src/orchestrator/)     │
│  1. Filter by payment method support                │
│  2. Evaluate each processor (score + strict check)  │
│  3. Return best processor + expected net amount     │
└──────────┬──────────────────────┬───────────────────┘
           │                      │
           ▼                      ▼
┌─────────────────┐    ┌──────────────────────┐
│ processors.json │    │      rules.json       │
│ (processor list │    │  (thresholds, weights)│
│  & fee config)  │    └──────────────────────┘
└─────────────────┘
```

---

## Project Structure

```
Smart-Payment-Orchestration/
├── src/
│   ├── index.js                 # Express server & /decide endpoint
│   ├── orchestrator/
│   │   └── index.js             # Scoring & decision engine
│   └── jsons/
│       ├── processors.json      # Payment processor definitions
│       └── rules.json           # Routing rules and scoring weights
├── simulator.py                 # Python fee-savings simulator
├── package.json
├── bun.lock
└── README.md
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0+ (used as the runtime and package manager)
- Python 3.8+ (only required to run the simulator)

### Installation

```bash
bun install
```

### Running the Server

```bash
bun start
```

The server starts on port **3000** by default. Override with the `PORT` environment variable:

```bash
PORT=8080 bun start
```

---

## API Reference

### POST /decide

Evaluates all eligible payment processors for the given transaction and returns the best choice.

**Request body**

```json
{
  "amount_cents": 1250,
  "currency": "usd",
  "payment_method": "card",
  "merchant": {
    "id": "m_1",
    "cash_flow_sensitivity": 0.7
  },
  "metadata": {}
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `amount_cents` | integer | ✅ | Transaction amount in cents (e.g., `1250` = $12.50) |
| `currency` | string | ❌ | Currency code, defaults to `"usd"` |
| `payment_method` | string | ❌ | `"card"` or `"ach"`, defaults to `"card"` |
| `merchant.id` | string | ❌ | Merchant identifier |
| `merchant.cash_flow_sensitivity` | float | ❌ | `0.0`–`1.0`. Higher value = merchant needs faster settlement |
| `merchant.whitelisted_for` | string[] | ❌ | List of processor names the merchant is approved for (required for processors with `requires_whitelist: true`) |
| `metadata` | object | ❌ | Arbitrary key-value data passed through |

**Response**

```json
{
  "chosen": "LocalProcessorA",
  "expected_net_cents": 1194,
  "details": {
    "processor": { "name": "LocalProcessorA", "fee_percentage": 0.025, "..." : "..." },
    "fee_cents": 56,
    "saving_pct_vs_stripe": 0.044,
    "settlement_score": 0.86,
    "risk_score": 0.965,
    "score": 6.712,
    "passesStrict": true
  },
  "reason": "Selected by scoring rules (score=6.712)"
}
```

| Field | Description |
|---|---|
| `chosen` | Name of the selected payment processor |
| `expected_net_cents` | Amount the merchant receives after fees |
| `details` | Full evaluation breakdown for the winning processor |
| `reason` | Human-readable explanation of the routing decision |

**Example with curl**

```bash
curl -X POST http://localhost:3000/decide \
  -H "Content-Type: application/json" \
  -d '{
    "amount_cents": 5000,
    "currency": "usd",
    "payment_method": "card",
    "merchant": { "id": "m_42", "cash_flow_sensitivity": 0.3 }
  }'
```

---

## Configuration

### Processors (`src/jsons/processors.json`)

Each entry defines a payment processor and its capabilities:

```json
[
  {
    "name": "Stripe",
    "fee_percentage": 0.02,
    "fee_flat_cents": 30,
    "settlement_time_days": 2,
    "success_rate": 0.98,
    "supports_card": true,
    "supports_ach": true,
    "instant_payout": false
  }
]
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique processor identifier |
| `fee_percentage` | float | Percentage of transaction amount charged as fee (e.g., `0.029` = 2.9%) |
| `fee_flat_cents` | integer | Fixed fee per transaction in cents |
| `settlement_time_days` | integer | Days until funds are available to the merchant |
| `success_rate` | float | Historical transaction success rate (0.0–1.0) |
| `supports_card` | boolean | Whether the processor handles card payments |
| `supports_ach` | boolean | Whether the processor handles ACH bank transfers |
| `instant_payout` | boolean | Whether same-day/instant payout is available |
| `requires_whitelist` | boolean | (Optional) If `true`, the merchant must be listed in `whitelisted_for` |

**Default processors**

| Processor | Fee % | Flat Fee | Settlement | Success Rate | Card | ACH | Instant |
|---|---|---|---|---|---|---|---|
| Stripe | 2.0% | $0.30 | 2 days | 98% | ✅ | ✅ | ❌ |
| LocalProcessorA | 2.5% | $0.25 | 1 day | 96.5% | ✅ | ❌ | ❌ |
| FastPayout | 3.4% | $0.10 | 0 days | 96% | ✅ | ❌ | ✅ |
| ACHProvider | 0.8% | $0.25 | 3 days | 99% | ❌ | ✅ | ❌ |

### Rules (`src/jsons/rules.json`)

Controls thresholds and scoring weights:

```json
{
  "rule_thresholds": {
    "min_relative_savings_to_switch": 0.02,
    "min_success_rate": 0.90
  },
  "scoring_weights": {
    "fee_weight": 10,
    "settlement_weight": 4,
    "risk_weight": 6,
    "switch_bonus": 1.5,
    "instant_payout_bonus": 1.0,
    "slow_settlement_penalty": 2.0
  }
}
```

| Parameter | Description |
|---|---|
| `min_relative_savings_to_switch` | Minimum fee saving relative to Stripe required to earn the switch bonus (default: 2%) |
| `min_success_rate` | Processors below this success rate are excluded from consideration (default: 90%) |
| `fee_weight` | Multiplier applied to relative fee saving in the final score |
| `settlement_weight` | Multiplier applied to the settlement score |
| `risk_weight` | Multiplier applied to the processor's success rate |
| `switch_bonus` | Bonus added to score when `min_relative_savings_to_switch` is met |
| `instant_payout_bonus` | Bonus added when the processor supports instant payouts |
| `slow_settlement_penalty` | Penalty subtracted when a high-sensitivity merchant would receive slow settlement (>1 day) |

---

## Scoring Logic

For every candidate processor, the engine calculates:

1. **Fee in cents**: `amount_cents × fee_percentage + fee_flat_cents`
2. **Relative fee saving vs. Stripe**: `(stripe_fee - candidate_fee) / stripe_fee`
3. **Settlement score** (`0`–`1`): `max(0, 1 - (settlement_time_days × cash_flow_sensitivity / 5))` — the divisor `5` is the assumed maximum settlement window in days, normalising the score to the `0`–`1` range
4. **Risk score**: processor `success_rate` (0–1)
5. **Bonuses/penalties**:
   - `+1.5` if fee saving ≥ 2% vs. Stripe
   - `+1.0` if processor supports instant payout
   - `−2.0` if merchant has high cash-flow sensitivity (`> 0.85`) and settlement takes more than 1 day

**Final score**:

```
score = (10 × max(0, fee_saving%))
      + (4 × settlement_score)
      + (6 × success_rate)
      + bonuses
```

**Strict constraints** (disqualify a processor before scoring):
- `success_rate < 0.90`
- `requires_whitelist` is `true` but the merchant is not whitelisted

If no processor passes strict constraints, the engine falls back to the processor with the highest `success_rate`.

---

## Fee Simulator

`simulator.py` runs an offline Monte Carlo simulation across thousands of transactions to estimate average fee savings without calling the live API.

```bash
python simulator.py
```

Sample output (5,000 transactions):

```
Avg stripe fee (cents): 67.4
Avg orchestrated fee (cents): 63.4
Average per-transaction fee reduction (relative %): 5.82%
Choice distribution: {'LocalProcessorA': 2103, 'Stripe': 1498, 'FastPayout': 1399}
```

Adjust the simulation parameters at the bottom of `simulator.py`:

```python
run_simulation(n=10000)  # number of transactions
```

---

## Database Schema & Ledger Guidelines

While this microservice is stateless, production deployments should persist routing decisions alongside transaction records. A minimal schema:

```sql
CREATE TABLE payment_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  merchant_id   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'usd',
  payment_method TEXT NOT NULL,
  chosen_processor TEXT NOT NULL,
  expected_net_cents INTEGER NOT NULL,
  score         NUMERIC(10,4),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON payment_decisions (merchant_id, created_at DESC);
CREATE INDEX ON payment_decisions (chosen_processor);
```

**Ledger principles**:
- Record every routing decision with a timestamp for auditability.
- Store the `score` and `reason` fields to support debugging and rule tuning.
- Use append-only writes; never update decision records.
- Periodically reconcile `expected_net_cents` against actual settled amounts to measure model accuracy.

---

## Deployment Notes

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on |

### Docker

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
EXPOSE 3000
CMD ["bun", "run", "src/index.js"]
```

```bash
docker build -t smart-payment-orchestration .
docker run -p 3000:3000 smart-payment-orchestration
```

### Health & readiness

The service is stateless — standard HTTP liveness probes on any non-`/decide` route will return a `404`, which is sufficient to confirm the process is alive. For a proper health endpoint, add:

```js
app.get('/health', (req, res) => res.json({ status: 'ok' }));
```

---

## Alternatives & Extensions

| Idea | Description |
|---|---|
| **ML-based routing** | Replace rule weights with a trained model (e.g., gradient-boosted trees) once sufficient historical data is available. |
| **A/B testing** | Route a configurable percentage of traffic to experimental processors to measure real-world performance before full rollout. |
| **Dynamic rule reloading** | Load `processors.json` and `rules.json` from a database or remote config service to enable live updates without restarts. |
| **Retry orchestration** | If the chosen processor returns a failure, automatically retry with the next-best processor. |
| **Multi-currency support** | Extend `feeAmountCents` to handle FX conversion costs when routing cross-border transactions. |
| **Webhook notifications** | Emit events (e.g., to Kafka or a webhook URL) when routing decisions are made for downstream analytics. |
| **Rate limiting** | Add per-merchant request rate limiting to protect the service under high load. |
