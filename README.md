# Sokoban solver — make.fun bounty entry

An entry for make.fun's *"Build the best Sokoban solver, 21 November 2026"* bounty
(`sokoban-solver-01-run-20261121`, $100 in USDC over 10 places).

`main.ts` reads each instance's `level.txt` (XSB) from `/input/<id>/` and writes the player's moves
to `/output/<id>/solution.txt` as LURD.

## Approach

The score is pushes, not moves: an instance answered in exactly its push-optimum **P\*** earns the
full 1,000 points, and even one push over that earns under half. So the solver targets the exact
push minimum for every level.

The bounty's own rules state the structural fact this leans on: a box pushed through a room door
lands in the one-square hallway, where it can reach no goal, so **no box ever leaves its room**. A
level is therefore a set of independent rooms and its optimum is the sum of theirs. Each room holds
only three or four boxes, so each is a small push-space.

For each room the solver runs a **breadth-first search over push-states** — the first solved state
it reaches is push-optimal. A state is the boxes' squares plus the player's reachable region (named
by its lowest square: two positions with the same region are interchangeable). Two sound deadlocks
are pruned, neither of which can remove a solvable state:

- **dead squares** — a square from which no push, ignoring the other boxes, can bring a box to any
  goal;
- **frozen 2×2 blocks** — two walls/boxes by two walls/boxes with a box off its goal inside.

Rooms are solved in turn, the other rooms' boxes standing as walls, the player walking on from where
the last room left it. If a level is not a clean set of rooms (it never is, for drawn sets) the
solver falls back to a whole-level search.

## Determinism and budget

Every search is bounded by work (state counts), never the clock, and ties break on fixed square
order, so two executions on one input write the same bytes. On the practice set it solves all five
instances in their exact optima in ~1.5 s of the 60 s budget, using ~130 MB of the 512 MB allowed.

## Notes

The kit ships make.fun's own push-optimal solver as the house baseline's sibling (`plain-astar` is
the bar an entry must beat). This entry is an independent implementation written to the rules' own
account of the level structure; it clears the bar on the practice set by a wide margin.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see `LICENSE`.
