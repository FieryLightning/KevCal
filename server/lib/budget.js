// A spend ceiling KevCal enforces itself.
//
// Google's own project spend cap is real but not exact: their docs say you are
// "subject to overages for around a 10 minute latency period" while billing data
// catches up. That window is worth pennies at one call per document — but it is
// the reason a cap set at the provider cannot be the only one.
//
// This ledger has no lag. It counts every call as it happens and refuses the
// next one before it is made. It is an ESTIMATE of cost, never an invoice: it
// prices tokens from a table that will drift, and it can only see what KevCal
// itself spends. Set the real cap at the provider too; this is the belt.

import { db, nowISO, getSetting } from '../db.js';
import { estimateCost, isKnownModel, TYPICAL_CALL, tokensFrom, formatUSD } from './pricing.js';

/** Calendar month in local time, because that is the month a person means. */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** null means no ceiling — track, but never refuse. */
export function limit() {
  const fromEnv = process.env.KEVCAL_MONTHLY_BUDGET;
  const raw = fromEnv !== undefined && fromEnv !== '' ? fromEnv : getSetting('monthly_budget', null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function spent(month = monthKey()) {
  const row = db.prepare(`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(in_tokens), 0) AS tokens_in,
           COALESCE(SUM(out_tokens), 0) AS tokens_out,
           COALESCE(SUM(estimated), 0) AS guessed
    FROM usage WHERE month = ?
  `).get(month);
  return { month, ...row };
}

/**
 * Priced BEFORE the call, using a typical page, because refusing afterwards is
 * how you end up over the number you chose.
 */
export function status(model = null) {
  const cap = limit();
  const used = spent();
  const nextCall = estimateCost(model, TYPICAL_CALL.in, TYPICAL_CALL.out);
  return {
    month: used.month,
    limit: cap,
    spent: used.cost,
    calls: used.calls,
    remaining: cap == null ? null : Math.max(0, cap - used.cost),
    next_call_estimate: nextCall,
    paused: cap != null && used.cost + nextCall > cap,
    estimated_prices: model ? !isKnownModel(model) : false,
  };
}

/** What to tell the user when reading is paused. */
export function pausedMessage(s) {
  return `Reading is paused: this month's estimated spend is ${formatUSD(s.spent)} of your ${formatUSD(s.limit)} budget. `
       + 'KevCal read this on-device instead. Raise KEVCAL_MONTHLY_BUDGET, or wait for next month.';
}

/**
 * Record a call. When the provider does not report tokens we bill ourselves for
 * a typical page rather than nothing — a cap that only counts what it can see
 * is not a cap.
 */
export function record({ reader, model, usage, batchId = null }) {
  const counted = tokensFrom(usage);
  const guessed = counted ? 0 : 1;
  const inTok = counted ? counted.in : TYPICAL_CALL.in;
  const outTok = counted ? counted.out : TYPICAL_CALL.out;
  const cost = estimateCost(model, inTok, outTok);
  db.prepare(`
    INSERT INTO usage (at, month, reader, model, in_tokens, out_tokens, estimated, cost, batch_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(nowISO(), monthKey(), reader || 'unknown', model || null, inTok, outTok, guessed, cost, batchId);
  return { cost, in: inTok, out: outTok, guessed: Boolean(guessed) };
}

/** For the settings screen: the last few months, newest first. */
export function history(months = 6) {
  return db.prepare(`
    SELECT month, COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost
    FROM usage GROUP BY month ORDER BY month DESC LIMIT ?
  `).all(months);
}
