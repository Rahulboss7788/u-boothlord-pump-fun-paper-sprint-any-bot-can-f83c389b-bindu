// DipSnap — mean-reversion dip-buy paper trader for pump.fun (paper only, no real funds).
//
// Idea: fresh pump.fun coins spike fast, then retrace. This bot never chases a
// spike. It waits for a coin that has already printed a clear peak, fallen a
// measured amount off that peak, and started to bounce off its trough — then
// buys the dip with a small fixed stake and exits on a tight stop, a modest
// take-profit, or a stale-position timeout. Every decision is a pure function
// of the harness state (no clock, no environment, no randomness), so the two
// graded executions agree byte for byte.
//
// Entry (all must hold):
//   - the coin has traded at least MIN_TRADES times (enough price history),
//   - its price is DIP_BPS..MAX_DIP_BPS below its rolling peak (a real dip,
//     not a dead coin that fell off a cliff),
//   - the peak is recent (within PEAK_FRESH_TRADES trades),
//   - the price has bounced at least BOUNCE_BPS off the trough set since the
//     peak (sellers exhausted, buyers stepping back in),
//   - the coin's latest trade in this batch is a buy (real demand right now,
//     not just a bounce printed by a sell),
//   - the size cap lets the bot buy at least MIN_BUY_LAMPORTS.
// Exits (checked every batch for every open position):
//   - take-profit at +TAKE_BPS over the filled entry price,
//   - tight stop-loss at -STOP_BPS under the filled entry price,
//   - stale exit: STALE_TRADES trades after entry without reaching +2%.
// The exits are deliberately tight: on the dev window the round-trip cost
// (curve fees plus tx fee) is ~2.6% of a 0.15 SOL stake, so wide stops bled
// the strategy; short, selective trades with quick exits kept drawdown low
// (see the local replay numbers in the build report).
// Position sizing: min(STAKE_LAMPORTS, the per-mint size cap), so a buy never
// breaches hello.caps.max_order_bps_of_real_reserve. At most
// hello.caps.max_open_positions coins are held at once, and a coin is only
// re-entered after it prints a fresh peak and dips again (cooldown in trades).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tuning ---------------------------------------------------------------
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n; // 0.15 SOL per dip
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: guardrail round trip
const MIN_TRADES = 8;
const DIP_BPS = 1000; // buy only >= 10% below the rolling peak
const MAX_DIP_BPS = 3500; // deeper than 35% off peak: likely dead, skip
const BOUNCE_BPS = 400; // >= 4% bounce off the trough since the peak
const PEAK_FRESH_TRADES = 30; // peak must be within the last 30 trades
const REENTRY_COOLDOWN_TRADES = 15; // trades to wait after an exit before re-entry
const STOP_BPS = 500; // tight stop: -5% vs entry
const TAKE_BPS = 1000; // take profit: +10% vs entry
const STALE_TRADES = 50; // exit if not +2% after this many trades
const MAX_SLIPPAGE_BPS = 800; // 8%: tight enough to protect the dip edge

// --- per-coin price memory -------------------------------------------------
interface CoinMemory {
  peak: number; // highest SOL-per-token seen
  peakTrades: number; // trade count when the peak printed
  trough: number; // lowest price since the peak printed
  lastPrice: number;
}

interface EntryMemory {
  entryPrice: number; // SOL per token actually filled at
  entryTrades: number; // trade count at fill time
}

const coins = new Map<string, CoinMemory>();
const entries = new Map<string, EntryMemory>();
const exitedAtTrades = new Map<string, number>();

/** SOL per token from a curve's virtual reserves (relative moves only). */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function dipBps(peak: number, price: number): number {
  if (peak <= 0) return 0;
  return Math.floor(((peak - price) / peak) * 10_000);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: (BuyInput | SellInput)[] = [];

    // 1. Record fills: a filled buy fixes the entry price for the exit rules.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      const tokens = BigInt(fill.token_amount);
      const quote = BigInt(fill.quote_lamports);
      if (fill.side === 'buy' && tokens > 0n) {
        const curve = state.curves.get(fill.mint);
        entries.set(fill.mint, {
          entryPrice: Number(quote) / Number(tokens),
          entryTrades: curve === undefined ? 0 : curve.trades,
        });
      } else if (fill.side === 'sell') {
        entries.delete(fill.mint);
        const curve = state.curves.get(fill.mint);
        exitedAtTrades.set(fill.mint, curve === undefined ? 0 : curve.trades);
      }
    }

    // 2. Refresh price memory for every mint touched by this batch.
    const touched = new Set<string>();
    for (const e of batch.events) {
      touched.add(e.mint);
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, { peak: 0, peakTrades: 0, trough: 0, lastPrice: 0 });
        }
      }
    }
    for (const mint of touched) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || curve.trades === 0) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      const mem = coins.get(mint) ?? { peak: 0, peakTrades: 0, trough: 0, lastPrice: 0 };
      if (price > mem.peak) {
        mem.peak = price;
        mem.peakTrades = curve.trades;
        mem.trough = price; // a new peak resets the trough
      } else if (price < mem.trough) {
        mem.trough = price;
      }
      mem.lastPrice = price;
      coins.set(mint, mem);
    }

    // 3. Exits first: free slots (and stop losses) before any new entry.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      // No recorded fill yet (buy still settling): hold, do not sell blind.
      if (entry === undefined) continue;
      const gainBps = Math.floor(((price - entry.entryPrice) / entry.entryPrice) * 10_000);
      const ageTrades = curve.trades - entry.entryTrades;
      const stopHit = gainBps <= -STOP_BPS;
      const takeHit = gainBps >= TAKE_BPS;
      const stale = ageTrades >= STALE_TRADES && gainBps < 200;
      if (stopHit || takeHit || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        slots += 1; // this slot frees up for a new dip buy below
      }
    }

    // 4. Entries: dip + bounce, in the batch's event order.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (e.event === 'CompleteEvent') continue;
      const mint = e.mint;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (state.pending.has(mint)) continue;
      if (curve.trades < MIN_TRADES) continue;
      const mem = coins.get(mint);
      if (mem === undefined || !(mem.peak > 0) || !(mem.lastPrice > 0)) continue;
      // Re-entry cooldown: the coin must trade on after the last exit.
      const lastExit = exitedAtTrades.get(mint);
      if (lastExit !== undefined && curve.trades - lastExit < REENTRY_COOLDOWN_TRADES) continue;
      // The peak must be fresh: a dip off an ancient peak is not a dip.
      if (curve.trades - mem.peakTrades > PEAK_FRESH_TRADES) continue;
      const dip = dipBps(mem.peak, mem.lastPrice);
      if (dip < DIP_BPS || dip > MAX_DIP_BPS) continue;
      // Bounce off the trough since the peak: buyers returning.
      if (mem.trough <= 0) continue;
      const bounceBps = Math.floor(((mem.lastPrice - mem.trough) / mem.trough) * 10_000);
      if (bounceBps < BOUNCE_BPS) continue;
      // The mint's latest trade in this batch must be a buy: real demand now.
      let lastIsBuy = false;
      for (let i = batch.events.length - 1; i >= 0; i--) {
        const ev = batch.events[i];
        if (ev.mint !== mint) continue;
        lastIsBuy = ev.event === 'TradeEvent' && ev.is_buy === true;
        break;
      }
      if (!lastIsBuy) continue;
      // Size: the cap is 1% of real SOL reserve; buy at most the stake.
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
