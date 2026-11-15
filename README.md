# Neurolap

An isometric racing game where you don't drive the car. You tune it, and a population of
small neural networks learns to drive it, crashing and evolving generation by generation
until it finds the fastest way round a procedurally generated circuit.

Then you can race them: run the pit wall in an eight-car race (pace, tyres, pit stops,
changing weather).

**Play it:** https://t3dboy.github.io/neurolap/

## What's in it

- **Practice:** watch the drivers learn. Every circuit comes from a seed, in one of six
  styles: fast flowing classic, temple of speed, street circuit, technical, figure of eight,
  and the Green hell: 4 to 6 km of forest, crests and 40 m climbs in the spirit of the Nordschleife.
- **Ghosts:** the best lap of earlier generations replays alongside the current one, so you
  can see the drivers get better.
- **Draw your own circuit:** sketch a loop and it becomes a real track, with arcs for corners,
  a pit straight, hills and scenery.
- **Brain transfer:** take the drivers to a new circuit or car and see how quickly what they
  learned carries over.
- **Driver personalities:** breed for aggression or tyre care. Temperament shows in races:
  lunges down the inside, longer stints, and in the team radio.
- **Seven car classes,** from an open-wheel formula racer to a family saloon, each with its
  own setup, suspension and handling. Every setting can be tuned.
- **Setup challenges:** a circuit, a car and a parts budget. Spend it well enough that the
  drivers can beat the target time.
- **Weather and time of day:** dry, rain or snow, live. Water lies on the road, cars throw
  spray and push it aside to form a dry line. Lamps and headlights at night.
- **Race:** qualifying, a standing start, contact, tyre wear, pit stops, team radio, a
  director camera that cuts to the battles, points and a season table.
- **Championship:** a season across several circuits. The drivers keep learning between
  rounds and points buy upgrades, while the rivals develop their cars too.
- **Share:** a link holds the circuit (even a drawn one), the car, the setup and your best lap
  for a friend to beat.

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

`npx tsx scripts/simtest.ts` and `scripts/racetest.ts` check, without a browser, that every
track style and car can be learned and that races run. `scripts/tracktest.ts` checks track
generation and drawn circuits; `scripts/challengecal.ts` sets the challenge targets.
