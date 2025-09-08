/**
 * orchestrator.js
 * Contains the rule-evaluation and scoring logic.
 *
 * This file is intentionally small and clear:
 * - load processors and rules from JSON (could be DB / remote)
 * - score each processor for the specific payment
 * - pick top processor that satisfies must-have constraints
 */

const fs = require("fs");
const path = require("path");

const processors = require("../jsons/processors.json");
const rules = require("../jsons/rules.json");

/**
 * Main API
 * @param {Object} payment { amount_cents, currency, payment_method, merchant, metadata }
 * @returns {Object} decision { chosen, expected_net_cents, details, reason }
 */
function decide(payment) {
  // 1) Filter processors that support the payment method
  let candidates = processors.filter(p => supportsMethod(p, payment.payment_method));

  // 2) Evaluate each candidate with rules => score + fail reasons
  const evaluations = candidates.map(p => evaluateProcessor(p, payment));

  // 3) Filter out processors that fail strict rules (e.g., minimal success rate)
  const viable = evaluations.filter(e => e.passesStrict);

  if (viable.length === 0) {
    // fallback: if none are viable, return Stripe (guarantee) or highest success_rate
    const fallback = evaluations.sort((a,b)=> b.processor.success_rate - a.processor.success_rate)[0];
    return {
      chosen: fallback.processor.name,
      expected_net_cents: Math.round(payment.amount_cents - feeAmountCents(fallback.processor, payment)),
      details: fallback,
      reason: "No candidate passed strict constraints — falling back to highest success_rate"
    };
  }

  // 4) Sort viable processors by score descending
  viable.sort((a,b) => b.score - a.score);

  const winner = viable[0];

  return {
    chosen: winner.processor.name,
    expected_net_cents: Math.round(payment.amount_cents - feeAmountCents(winner.processor, payment)),
    details: winner,
    reason: `Selected by scoring rules (score=${winner.score.toFixed(3)})`
  };
}

function supportsMethod(processor, method) {
  if (method === "card") return !!processor.supports_card;
  if (method === "ach") return !!processor.supports_ach;
  return false;
}

function evaluateProcessor(processor, payment) {
  // base fee cost in cents
  const fee = feeAmountCents(processor, payment);

  // fee saving relative to reference (Stripe)
  const stripe = processors.find(p => p.name === "Stripe");
  const stripeFee = feeAmountCents(stripe, payment);
  const saving_pct_vs_stripe = (stripeFee - fee) / stripeFee; // relative

  // cash flow score: merchants with high cash_flow_sensitivity penalize slow settlement
  const settlement_factor = Math.max(0, 1 - (processor.settlement_time_days * payment.merchant.cash_flow_sensitivity / 5));
  // Protect range 0..1
  const settlement_score = Math.min(1, Math.max(0, settlement_factor));

  // risk score based on success rate & estimated chargeback risk
  const risk_score = processor.success_rate; // 0..1

  // Rule-based bonuses/penalties
  let bonus = 0;
  if (saving_pct_vs_stripe >= rules.rule_thresholds.min_relative_savings_to_switch) {
    bonus += rules.scoring_weights.switch_bonus;
  }
  if (processor.instant_payout) {
    bonus += rules.scoring_weights.instant_payout_bonus;
  }
  // If merchant requires immediate settlement (sensitivity > 0.85), penalize slow rails strongly
  if (payment.merchant.cash_flow_sensitivity > 0.85 && processor.settlement_time_days > 1) {
    bonus -= rules.scoring_weights.slow_settlement_penalty;
  }

  // final score composition
  const score = (rules.scoring_weights.fee_weight * Math.max(0, saving_pct_vs_stripe))
    + (rules.scoring_weights.settlement_weight * settlement_score)
    + (rules.scoring_weights.risk_weight * risk_score)
    + bonus;

  // strict checks (fail fast)
  const passesStrict = processor.success_rate >= rules.rule_thresholds.min_success_rate
    && (!processor.requires_whitelist || payment.merchant.whitelisted_for && payment.merchant.whitelisted_for.includes(processor.name));

  return {
    processor,
    fee_cents: fee,
    saving_pct_vs_stripe,
    settlement_score,
    risk_score,
    score,
    passesStrict
  };
}

function feeAmountCents(processor, payment) {
  // percentage fee = percentage * amount
  const pct = processor.fee_percentage || 0;
  const flat = processor.fee_flat_cents || 0;
  const fee = Math.round(payment.amount_cents * pct + flat);
  return fee;
}

module.exports = { decide, feeAmountCents };
