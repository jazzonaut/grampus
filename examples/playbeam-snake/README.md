# Common Snake behavioural checks

Copy `behaviour.test.ts.txt` to `apps/web/tests/grampus-snake.behaviour.test.ts` in
PlayBeam and commit it before starting a comparison. Add this to the repository's
`grampus.json`, preserving its other configuration:

```json
{
  "behaviouralHarness": {
    "contract": "Drive the exported Snake definition through GameHost.setRoster and the animation clock. Observe onGameOver results. Preserve final standings for departures before a frame; remove earlier departures after play advances; pause all-held rounds. Allow a zero-duration transition frame. Do not inspect private simulation state.",
    "files": ["apps/web/tests/grampus-snake.behaviour.test.ts"],
    "checks": [
      {
        "name": "Common Snake behaviour",
        "command": "pnpm --filter @playbeam/web exec vitest run tests/grampus-snake.behaviour.test.ts"
      }
    ]
  }
}
```

The harness exercises production lifecycle wiring through an existing public API.
The canvas and animation clock are controlled. It deliberately tolerates a
zero-duration first frame instead of enforcing one implementation's clock policy.
It does not establish physical phone behaviour, transport buffering, collision
isolation, pending growth, respawn budgets or nonzero earned-score retention.
Those still need the task's integration and regression tests. A portable harness
is a common measured subset, not a claim of complete acceptance coverage.
