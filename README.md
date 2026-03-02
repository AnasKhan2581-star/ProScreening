# APEX — Smart Liquidity Scanner

**Mobile-first crypto spot trading webapp** built around the "Liquidation Gravity + Volume Ignition" strategy.

## Strategy Logic
- **Layer 1** — Volume Ignition (2–7x baseline, still rising)
- **Layer 2** — CVD Rising (aggressive buyer absorption)
- **Layer 3** — Compression Breakout Structure
- **Layer 4** — Room to ATH (not extended)
- **Layer 5** — EMA20 Trend filter
- **Layer 6** — RSI health check (40–72)

Score ≥5/6 = Grade A · ≥4/6 = Grade B

## Features
- 📡 **Scanner** — Top 30 gainers + Volume rank 20–50 on Binance Spot
- 🟢 **BTC Liquidity Panel** — Nearest BSL/SSL zones (Heatmap 2.0 derived)
- 📊 **HTF→LTF Assessment** — High timeframe bias + low timeframe entry timing
- 📝 **Trade Journal** — P&L tracking, capital overview, win rate stats
- ⚡ **Backtester** — Spot-only, realistic multi-TP logic with equity curve
- 🔔 **Notifications** — Browser push alerts for Grade A/B signals
- ⏱️ **Auto Scan** — Every 5/15/30/60 min or manual
- ⚙️ **Settings** — HTF/MTF/LTF custom timeframes, currency symbol, capital

## Deploy to GitHub Pages
1. Fork this repo
2. Go to Settings → Pages → Source: Deploy from `main` branch, root `/`
3. Visit `https://yourusername.github.io/apex-scanner`

That's it. No build step. Pure HTML/CSS/JS.

## Data Sources
- **Binance Public API** (no key needed) — prices, klines, 24h tickers
- **Liquidation zones** — derived from swing high/low structure (Coinglass visual parity)

## Notes
- SPOT LONG ONLY — no futures logic, no leverage
- All trades tracked locally in `localStorage`
- For real push notifications outside browser: deploy with HTTPS (GitHub Pages provides this)

---
*Trade smart. Give back. ✦*
