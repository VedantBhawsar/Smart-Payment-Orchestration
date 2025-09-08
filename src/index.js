/**
 * server.js
 * Minimal Express server that exposes a /decide endpoint.
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /decide
 *     payload: {
 *       amount_cents: 1250,
 *       currency: "usd",
 *       payment_method: "card" | "ach",
 *       merchant: { id: "m_1", cash_flow_sensitivity: 0.7 }, // 0..1 high means needs faster settlement
 *       metadata: {}
 *     }
 *
 * Response:
 *   { chosen: "Stripe", details: {...}, expected_net_cents: 1200, reason: "..." }
 */

const express = require("express");
const bodyParser = require("body-parser");
const orchestrator = require("./orchestrator");

const app = express();
app.use(bodyParser.json());

app.post("/decide", async (req, res) => {
  try {
    const payload = req.body;
    const decision = orchestrator.decide(paymentInputFromPayload(payload));
    res.json(decision);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function paymentInputFromPayload(p) {
  return {
    amount_cents: p.amount_cents,
    currency: p.currency || "usd",
    payment_method: p.payment_method || "card",
    merchant: p.merchant || { id: "m_default", cash_flow_sensitivity: 0.5 },
    metadata: p.metadata || {}
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Payment orchestrator listening on ${PORT}`);
});
