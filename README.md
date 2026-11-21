# Sokoban Solver — make.fun bounty entry

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/muhamadyusufseptian6-lab/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/muhamadyusufseptian6-lab/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single stdlib-only `main.ts` (Node 22), built for the
[make.fun](https://make.fun) bounty `sokoban-solver-01-run-20261121`.

## Approach

The generated levels have a fixed structure: a 1-wide hallway plus 1–4 rooms
(6×6 slots, one door each), and a box pushed through a door can never come back,
so every box stays in its room and rooms are independent. The solver exploits that:

1. **Room decomposition** — cut the hallway row at its dead squares to recover each
   room, its boxes and its goals; solve each room separately and join the move
   sequences (with a walk to each room's door).
2. **Push-based A\*** over box configurations per room, with the player position
   compressed to the lowest square of its reachable region (a region change only
   happens on a push, so the search space stays small).
3. **Admissible heuristic** — minimum-cost matching of boxes to goals over
   BFS walk distances (with the Hungarian-style branch-and-bound over
   permutations, since there are at most 4 boxes).
4. **Deadlock pruning** — boxes on non-live squares (computed by pulling boxes
   back from the goals) and frozen 2×2 blocks are never pushed.
5. **Deterministic fallbacks** — if A\* exhausts its node budget, the room is
   retried with plain BFS, then with a greedy push search, so an answer is always
   produced. Everything is ordered with fixed tie-breaks; no randomness, no
   wall-clock cutoffs — only node budgets — so two runs write byte-identical output.

## Practice-set result

Solved **all 5 practice instances at their push-optimal counts** (P\*) —

| instance | rooms | P\* | pushes |
| --- | --- | --- | --- |
| i001 | 1 × 3 boxes | 13 | 13 |
| i002 | 1 × 4 boxes | 16 | 16 |
| i003 | 2 × 4 boxes | 29 | 29 |
| i004 | 3 × 4 boxes | 47 | 47 |
| i005 | 4 × 4 boxes | 60 | 60 |

**Score 1,000,000 / 1,000,000** on the practice set (kit checker), versus
**200,000** for the house baseline `plain-astar` (it only solves i001 and gives up
on the multi-room levels). Full run takes **~0.7 s** for all 5 instances — far
inside the 60-second limit — and two runs produce byte-identical output.

## Usage

```sh
node main.ts
```

Reads levels from `$MAKEFUN_INPUT_DIR` (default `/input`) and writes one
`solution.txt` per instance to `$MAKEFUN_OUTPUT_DIR` (default `/output`).

---

Built for the make.fun bounty — if you sign up, use referral code
[`515temp1`](https://make.fun/r/515temp1).
