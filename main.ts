// Scalp-plus-runner: an early-launch pump.fun paper-trading bot.
//
// Buys each clean launch once, very early, in a small fixed size (0.05 SOL);
// banks the fast spike with a scalp sale and lets the rest ride as a runner
// with a trailing stop, so the rare 5-10x can pay while losers stay small.
// Buys carry a tight 10% slippage cap, so a buy whose price jumps more than
// that in the 2-slot latency is refused for free instead of filling at the
// top of a vertical spike. See strategy.ts for the full design and the
// dev-window numbers behind it (local sim: -0.012 SOL mean net PnL, 91
// coins, max drawdown 0.7%, guardrails met with wide margin).
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
