[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Vins1206/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Vins1206/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Scalp-plus-Runner — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. The house replays it on 6 hours of real pump.fun market data; highest net PnL wins.

## What it does

A fresh coin's price spikes within its first few slots (median +27% inside 100 slots on the dev window, 22% of coins 2x), then usually reverts to its create price. So this bot:

- **Buys once, very early, small** — 0.05 SOL per clean launch (creator hasn't sold, creator's opening buy isn't huge, at most 3 distinct early buyers, real SOL already ≥ 0.3 so the 1%-of-reserve cap lets a real order through).
- **Banks the spike fast** — sells half the tokens at +30%, cuts the whole position at −20%, or times out after 3 slots.
- **Lets the rest ride** — the remaining half trails with a 25% trailing stop (up to 3000 slots), so a rare 5–10x can pay while losers stay small.
- **Buys with a tight 10% slippage cap** — a buy whose price jumps more than that in the 2-slot latency is refused for free, instead of filling at the top of a vertical spike. This improved net PnL on all three dev slices tested.

Everything is deterministic: no clock, no randomness, no I/O, no environment reads, so the two graded executions produce byte-identical action logs.

## Dev-window results (local sim port, mean over 4 failed-tx draws)

| Bot | Net PnL | Trips / Coins | Wins | Max drawdown |
| --- | --- | --- | --- | --- |
| **This bot** | **−0.012 SOL** | 91 / 91 | 16 | 0.7% |
| Sniper (kit pilot) | −0.133 SOL | 134 / 135 | 19 | 1.7% |
| Momentum (kit pilot) | −9.42 SOL | 82 / 49 | 6 | 95% |
| Reversion (kit pilot) | −1.68 SOL | 171 / 70 | 48 | 17% |

The number is still slightly negative: the ~2.5% round-trip fee drag sits just above the gross edge, so on the fresh 6-hour final window this entry wins only if a runner catches a real moonshot — which is exactly what the runner half is for. Parameters sit on a flat plateau (tp/sl/hold/stake all within ~0.005 SOL of this point), not a knife-edge. A 60-SOL "ride the completion" variant was tested and rejected: it lost ~0.09 SOL per trip on the dev window.

Guardrails: 91 distinct coins with round trips ≥ 0.01 SOL (bar is 20), max drawdown 0.7% (bar is 50%).

## How to run

Requires Node 22.18+ (the grader runs Node 22.23.4, which runs TypeScript as-is — no build, no install, stdlib only).

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`). The strategy lives in `strategy.ts`; `main.ts` is the entrypoint.

## Layout

- `main.ts` — entrypoint: runs the strategy through the harness shim.
- `strategy.ts` — the scalp-plus-runner strategy (all parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `LICENSE` — MIT.
