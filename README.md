# Neurolap

An isometric racing game where you don't drive the car. You tune it, and a population of
small neural networks learns to drive it, crashing and evolving generation by generation
until it finds the fastest way round a procedurally generated circuit.

Then you can race them: run the pit wall in an eight-car race (pace, tyres, pit stops,
changing weather).

**Play it:** https://t3dboy.github.io/neurolap/

## What's in it

- **Practice:** watch the drivers learn. Every circuit comes from a seed, in one of five
  styles: fast flowing classic, temple of speed, street circuit, technical, figure of eight.
- **Seven car classes,** from an open-wheel formula racer to a family saloon, each with its
  own setup, suspension and handling. Every setting can be tuned.
- **Weather and time of day:** dry, rain or snow, live. Water lies on the road, cars throw
  spray and push it aside to form a dry line. Lamps and headlights at night.
- **Race:** qualifying, a standing start, contact, tyre wear, pit stops, team radio,
  points and a season table.

## Controls

| | Keyboard | Controller |
|---|---|---|
| Pause | Space | Options / Menu |
| Switch camera | | Share / View |
| Box this lap (race) | | Circle / B |
| Confirm / back on a menu | | Cross / A, Circle / B |

Best on a desktop or laptop with a recent Chrome, Edge or Safari.

## Running it locally

```bash
npm install
npm run dev
```

Then open http://localhost:5197.

`npx tsx scripts/simtest.ts` and `scripts/racetest.ts` check,
without a browser, that every track style and car can be learned and that races run.
