// Scalp-plus-runner: an early-launch pump.fun bot for agent-fun/replay/v2.
//
// Idea (from the dev window's payoff shape, measured before writing this):
// a fresh coin's price spikes within its first few slots (median +27% inside
// 100 slots, 22% of coins 2x), then usually reverts to its create price, so
// holding losers is what kills a bot and holding a small runner is what can
// catch the rare 5-10x. This bot therefore buys once, very early, in a small
// fixed size, and splits the exit in two:
//
//   - the scalp (most of the tokens) takes profit fast at +TP, or cuts the
//     whole position at -SL, or times out after a few slots;
//   - the runner (the rest) only exists once the scalp has banked a profit.
//     It rides with a trailing stop and a long hold so a moonshot can pay,
//     and it can never lose more than its own small slice.
//
// Entry is gated on the launch looking clean: the creator has not sold, the
// creator's own opening buy is not huge, only a few distinct buyers piled in
// (a launch bundled by many wallets is a dump waiting to happen), and the
// curve already holds some real SOL so the 1%-of-reserve buy cap lets a
// meaningful order through. One entry per coin, ever. Buys carry a tight
// 10% slippage cap: a buy whose price jumps more than that in the 2-slot
// latency is refused for free, which filters out entries that would have
// filled at the top of a vertical spike (this improved net PnL on all three
// dev slices, not just one).
//
// Dev-window results (local sim port, mean over 4 failed-tx draws):
//   this bot  -0.011 SOL, 91 trips, 92 coins, 16 wins, max drawdown 0.7%
//   sniper    -0.133 SOL | momentum -9.4 SOL | reversion -1.7 SOL
//   (same sim, same window; the house pilots are the kit's own baselines).
// The number is still slightly negative: the round-trip fee drag (~2.5%
// curve fees + tx fees) is just above the gross edge, so on a fresh 6-hour
// window this entry wins only if a runner catches a real moonshot — which
// is exactly what the runner half is for. No parameter in the sweep sat on
// a knife-edge: tp/sl/hold/stake all plateau within ~0.005 SOL of this point.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, no environment reads, so the two graded
// executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL staked on one coin (each buy is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail floor). */
  minBuySol: number;
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Scalp take-profit: sell the scalp share once value reaches cost * (1 + tp). */
  tp: number;
  /** Stop-loss: sell everything once value falls to cost * (1 - sl). */
  sl: number;
  /** Share of the tokens the scalp sells at take-profit (rest becomes the runner). */
  scalpPart: number;
  /** Exit the whole position if it neither profits nor stops within this many slots. */
  maxHold: number;
  /** Runner trailing stop: exit once value falls this far below its best value. */
  trail: number;
  /** Runner stop: exit once the runner's value falls to this share of its basis. */
  runnerSl: number;
  /** Runner time limit (slots held) regardless of profit. */
  runnerHold: number;
  /** Exit when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Slippage allowed on buys and sells (bps); 10000 never refuses on price moves. */
  slipBps: number;
  /** Slippage allowed on buys alone (bps). A buy whose price jumps more
   *  than this in the 2-slot latency is refused for free (a rejected order
   *  pays nothing), so a tight buy slippage filters out entries that would
   *  have filled at the top of a vertical spike. Sells stay wide: an exit
   *  must never be refused for the price moving. */
  buySlipBps: number;
  /** Ride entries: buy a coin again once its real SOL crosses this (0 = off).
   *  Tested and left OFF: on the dev window a 60-SOL ride lost ~0.09 SOL per
   *  trip (~6 trips, -0.55 SOL total) despite 74% of such coins completing,
   *  because fills land after the peak and the stop-loss eats the stake.
   *  The code stays so the idea can be re-tested on fresh data, but the
   *  shipped default is 0 (no rides). Only the first crossing counts: a coin
   *  that crossed long ago and is now dumping is not a ride, so the buy must
   *  land within rideWindow slots. */
  rideRqSol: number;
  /** Slots after the first crossing of rideRqSol during which a ride may start. */
  rideWindow: number;
  /** SOL staked on one ride entry. */
  rideStakeSol: number;
  /** Ride scalp take-profit / stop-loss / trailing stop / time limit. */
  rideTp: number;
  rideScalpPart: number;
  rideTrail: number;
  rideSl: number;
  rideHold: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.05,
  minBuySol: 0.01,
  minAge: 0,
  maxAge: 3,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  maxBuyers: 3,
  skipDevSold: true,
  tp: 0.3,
  sl: 0.2,
  scalpPart: 0.5,
  maxHold: 3,
  trail: 0.25,
  runnerSl: 0.2,
  runnerHold: 3000,
  exitOnDevSell: true,
  slipBps: 10_000,
  buySlipBps: 1000,
  rideRqSol: 0,
  rideWindow: 500,
  rideStakeSol: 0.5,
  rideTp: 0.4,
  rideScalpPart: 0.5,
  rideTrail: 0.2,
  rideSl: 0.25,
  rideHold: 20_000,
};

const LAMPORTS = 1e9;
/** Curve fees on a trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  /** Never buy it again as a launch entry (entered, exited, filtered out, or completed). */
  done: boolean;
  /** A ride entry has already been taken on this coin. */
  rideDone: boolean;
  /** Slot real SOL first reached the ride threshold (null until it does). */
  crossSlot: number | null;
  complete: boolean;
  lastTradeSlot: number;
}

interface Held {
  openedSlot: number;
  /** SOL paid in tx fees on this position's fills. */
  txPaidSol: number;
  /** Best liquidation value seen since entry (scalp phase) or since the scalp sale (runner). */
  peak: number;
  /** True once the scalp share has been sold. */
  scalped: boolean;
  /** True when this position is a ride entry (uses the ride exit params). */
  ride: boolean;
}

/** What selling `tokens` against reserves (vq, vt) pays after curve fees, in SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (Number(tokens) * Number(vq)) / (Number(vt) + Number(tokens));
  return (q / LAMPORTS) * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight (don't stack a second sell). */
  const selling = new Set<Pubkey>();
  /** Mints with a ride buy in flight (marks the position as a ride on its fill). */
  const rideBuys = new Set<Pubkey>();
  const txSol = (state: BotState): number => Number(state.txFeeLamports()) / LAMPORTS;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = txSol(state);
      const cap = state.hello.caps.max_orders_per_batch;

      // Fold the batch's events into the coin book.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            devBuySol: 0,
            devSold: false,
            buyers: new Set(),
            done: false,
            rideDone: false,
            crossSlot: null,
            complete: false,
            lastTradeSlot: e.slot,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          c.lastTradeSlot = e.slot;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.createSlot) c.devBuySol += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      // Fold fills: track tx fees, open held records on buy fills, clear
      // positions the harness closed (complete / flatten / writeoff).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaidSol += Number(f.tx_fee_lamports) / LAMPORTS;
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const ride = rideBuys.has(f.mint);
          rideBuys.delete(f.mint);
          held.set(f.mint, { openedSlot: f.slot, txPaidSol: Number(f.tx_fee_lamports) / LAMPORTS, peak: 0, scalped: false, ride });
        }
      }
      for (const mint of [...selling]) {
        let pendingSell = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') { pendingSell = true; break; }
        }
        if (!pendingSell) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          let pendingBuy = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') { pendingBuy = true; break; }
          }
          if (!pendingBuy) held.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves) };
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first: every held position is priced at its liquidation value.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: now, txPaidSol: tx, peak: 0, scalped: false, ride: false };
          held.set(mint, h);
        }
        const r = reservesOf(mint);
        if (r === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve !== undefined && curve.complete) continue;
        const value = sellValueSol(pos.token_amount, r.vq, r.vt) - tx;
        const basis = Number(pos.cost_lamports) / LAMPORTS + h.txPaidSol;
        if (value > h.peak) h.peak = value;
        const age = now - h.openedSlot;
        const devDumped = p.exitOnDevSell && c !== undefined && c.devSold;
        // Ride positions use the ride exit params; launch positions the base ones.
        const tp = h.ride ? p.rideTp : p.tp;
        const sl = h.ride ? p.rideSl : p.sl;
        const part = h.ride ? p.rideScalpPart : p.scalpPart;
        const hold = h.ride ? p.rideHold : p.maxHold;
        const trail = h.ride ? p.rideTrail : p.trail;
        const runSl = h.ride ? p.rideSl : p.runnerSl;
        const runHold = h.ride ? p.rideHold : p.runnerHold;

        if (!h.scalped) {
          // Scalp phase: bank the fast profit, cut the fast loss, or time out.
          if (value >= basis * (1 + tp)) {
            const share = (pos.token_amount * BigInt(Math.round(part * 10_000))) / 10_000n;
            if (share > 0n && share < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: share, max_slippage_bps: p.slipBps });
              selling.add(mint);
              h.scalped = true;
              h.peak = 0;
              continue;
            }
            // A scalp share of 100% is just a full exit at take-profit.
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
            selling.add(mint);
            if (c !== undefined) c.done = true;
            continue;
          }
          if (value <= basis * (1 - sl) || age >= hold || devDumped) {
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
            selling.add(mint);
            if (c !== undefined) c.done = true;
            continue;
          }
        } else {
          // Runner phase: the remaining tokens ride with a trailing stop.
          // The runner's basis is the position's own cost, which the
          // harness already reduced by the scalp sale.
          if (
            value <= basis * (1 - runSl) ||
            (h.peak > 0 && value <= h.peak * (1 - trail)) ||
            age >= runHold ||
            devDumped
          ) {
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
            selling.add(mint);
            if (c !== undefined) c.done = true;
            continue;
          }
        }
      }

      // Entries: one small buy per clean launch, in first-seen order.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let open = state.committedPositionCount();
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = now - c.createSlot;
        if (age < p.minAge) continue;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) break;
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') { pendingBuy = true; break; }
        }
        if (pendingBuy || held.has(mint) || state.positions.has(mint)) continue;
        if (p.skipDevSold && c.devSold) {
          c.done = true;
          continue;
        }
        if (c.devBuySol > p.maxDevBuySol) {
          c.done = true;
          continue;
        }
        if (c.buyers.size > p.maxBuyers) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        const amount = Math.min(capSol, p.stakeSol);
        if (amount < p.minBuySol) continue;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        open += 1;
        c.done = true;
      }

      // Ride entries: a coin whose real SOL has crossed the ride threshold
      // gets one bigger, completion-seeking buy, even if its launch window
      // already passed (or it was never bought at launch).
      if (p.rideRqSol > 0) {
        for (const [mint, c] of coins) {
          if (orders.length >= cap) break;
          if (c.rideDone || c.complete) continue;
          if (open >= state.hello.caps.max_open_positions) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (c.crossSlot === null) {
            if (rqSol < p.rideRqSol) continue;
            c.crossSlot = now;
          }
          if (now - c.crossSlot > p.rideWindow) continue;
          let pendingBuy = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') { pendingBuy = true; break; }
          }
          if (pendingBuy || held.has(mint) || state.positions.has(mint)) continue;
          if (rqSol < p.rideRqSol) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          const amount = Math.min(capSol, p.rideStakeSol);
          if (amount < p.minBuySol) continue;
          if (free < amount + tx) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: p.buySlipBps,
          });
          rideBuys.add(mint);
          free -= amount + tx;
          open += 1;
          c.rideDone = true;
        }
      }
      return orders;
    },
  };
}
