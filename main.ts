// Sokoban solver: room-by-room push-optimal A*.
//
// A level is a one-wide hallway with independent rooms off it. A box pushed
// out of a room through its door can never be pushed back (the player would
// have to stand on the hallway's far side, which is wall), so every box stays
// in its room and the rooms are independent problems: each is solved on its
// own with a push-optimal search, and the push counts add up to the level's
// optimum. The player walks between rooms on the hallway.
//
// The search is A* over pushes (not steps): a state is the sorted box
// squares plus the player's reachable region, named by its lowest square.
// The estimate is the cheapest assignment of boxes to goals under
// walk-distance (each push moves one box one square, so the assignment cost
// lower-bounds the pushes left). Dead states are pruned three ways: a box on
// a square from which no push can ever reach a goal, a box outside its own
// room, and a frozen 2x2 block of walls and boxes with a box off its goal.
// Ties break by insertion order, so the search is deterministic; budgets are
// counted in expansions, never wall-clock time, so two runs write the same
// bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Dir = { dx: number; dy: number; step: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares from which a box can still be pushed onto some goal, by pulling back from the goals. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

type Room = { squares: Uint8Array; boxes: number[]; goals: number[] };

/**
 * The level's rooms: cut the hallway row's dead squares (floor the player
 * walks on but a box there reaches no goal) out of the floor, and each
 * remaining part holding boxes is a room. Null when the level is no set of
 * rooms (a box in the cut, a goal outside every part, or a part whose boxes
 * and goals do not match).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const cells: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      const p = cells[i];
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    const mask = new Uint8Array(wall.length);
    for (const q of cells) mask[q] = 1;
    rooms.push({ squares: mask, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** All orderings of n items, as index arrays (n is at most 4 here). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

type PushStep = { from: number; to: number };
type PushSolution = { pushes: number; moves: string };

/**
 * Push-optimal solution of `sub` (a room on its own board, other rooms'
 * boxes already walls), or null when the expansion budget runs out. `roomMask`
 * bounds the boxes to their own room; null bounds them nowhere. `mode` picks
 * the priority: A* (pushes + estimate), plain breadth-first (pushes), or
 * greedy (estimate only, a fallback that still finds a valid solution when
 * the optimal searches give up).
 */
function solvePushes(
  sub: Level,
  roomMask: Uint8Array | null,
  maxExpand: number,
  mode: 'astar' | 'bfs' | 'greedy',
): PushSolution | null {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const n = sub.boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(sub);
  if (sub.boxes.some((b) => !live[b])) return null;
  if (roomMask && sub.boxes.some((b) => !roomMask[b])) return null;

  // Walk-distance from every square to each goal, over open floor.
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (const dir of DIRS) {
        const c = p + dir.dy * w + dir.dx;
        if (c < 0 || c >= size || wall[c] || d[c] >= 0) continue;
        d[c] = d[p] + 1;
        q.push(c);
      }
    }
    return d;
  });
  const perms = permutations(n);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const perm of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[perm[i]][boxes[i]];
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // Flood fill from `from` around walls and boxes: the region's lowest
  // square, leaving the region marked under the returned stamp.
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const region = (occupied: Uint8Array, from: number): { low: number; mark: number } => {
    stamp++;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seen[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
          seen[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return { low, mark: stamp };
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
  // and boxes with a box off its goal.
  const frozenAt = (occupied: Uint8Array, t: number): boolean => {
    const tx = t % w;
    const ty = Math.floor(t / w);
    for (const [cx, cy] of [
      [tx, ty],
      [tx - 1, ty],
      [tx, ty - 1],
      [tx - 1, ty - 1],
    ]) {
      if (cx < 0 || cy < 0 || cx + 1 >= w || cy + 1 >= Math.floor(size / w)) continue;
      const a = cy * w + cx;
      const cells = [a, a + 1, a + w, a + w + 1];
      if (!cells.every((c) => wall[c] || occupied[c])) continue;
      if (cells.some((c) => occupied[c] && !goalSet[c])) return true;
    }
    return false;
  };

  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * 256 + b;
    return k;
  };
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // State storage, in insertion order.
  const stBoxes: number[][] = [sub.boxes.slice()];
  const stPlayer: number[] = [sub.player];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const stKey: number[] = [];
  const fScore: number[] = [];
  const seqNo: number[] = [];
  const best = new Map<number, number>();
  let seq = 0;

  const occupied0 = new Uint8Array(size);
  for (const b of sub.boxes) occupied0[b] = 1;
  const h0 = mode === 'bfs' ? 0 : heuristic(sub.boxes);
  if (h0 === Infinity) return null;
  stKey.push(keyOf(sub.boxes, region(occupied0, sub.player).low));
  fScore.push(mode === 'greedy' ? h0 : h0);
  seqNo.push(seq++);
  best.set(stKey[0], 0);

  // Binary heap of state indices, ordered by (f, insertion order).
  const heap: number[] = [0];
  const heapLess = (a: number, b: number): boolean =>
    fScore[a] !== fScore[b] ? fScore[a] < fScore[b] : seqNo[a] < seqNo[b];
  const heapPush = (idx: number): void => {
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  let expanded = 0;
  let goalIdx = -1;
  while (heap.length > 0) {
    const s = heapPop();
    if (best.get(stKey[s]) !== s) continue; // superseded by a cheaper path
    const boxes = stBoxes[s];
    if (solved(boxes)) {
      goalIdx = s;
      break;
    }
    if (expanded >= maxExpand) break;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    const { mark } = region(occupied, stPlayer[s]);
    // Snapshot the region: successor regions below reuse the same marks,
    // so the membership test must not read them back.
    const inRegion = new Uint8Array(size);
    for (let i = 0; i < size; i++) if (seen[i] === mark) inRegion[i] = 1;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const stand = b - d; // the player must stand here to push
        const t = b + d; // where the box lands
        if (stand < 0 || stand >= size || t < 0 || t >= size) continue;
        if (!inRegion[stand]) continue;
        if (wall[t] || occupied[t]) continue;
        if (!live[t]) continue;
        if (roomMask && !roomMask[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(occupied, t);
        let key2 = -1;
        let h2 = Infinity;
        if (!frozen) {
          const next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          h2 = mode === 'bfs' ? 0 : heuristic(next);
          if (h2 !== Infinity) {
            const low2 = region(occupied, b).low;
            key2 = keyOf(next, low2);
            const prev = best.get(key2);
            if (prev === undefined || stG[prev] > stG[s] + 1) {
              const idx = stBoxes.length;
              stBoxes.push(next);
              stPlayer.push(b);
              stG.push(stG[s] + 1);
              stParent.push(s);
              stFrom.push(b);
              stTo.push(t);
              stKey.push(key2);
              fScore.push(mode === 'greedy' ? h2 : stG[s] + 1 + h2);
              seqNo.push(seq++);
              best.set(key2, idx);
              heapPush(idx);
            }
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (goalIdx < 0) return null;

  const steps: PushStep[] = [];
  for (let s = goalIdx; s > 0; s = stParent[s]) steps.push({ from: stFrom[s], to: stTo[s] });
  steps.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  const occ = new Uint8Array(size);
  for (const { from, to } of steps) {
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d)!;
    for (const b of boxes) occ[b] = 1;
    moves += walkTo(sub, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += dir.push;
    player = from;
    boxes[boxes.indexOf(from)] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: steps.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** Solve one level's text into its full move string (empty when unsolved). */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole =
      solvePushes(level, null, 400_000, 'astar') ??
      solvePushes(level, null, 400_000, 'bfs') ??
      solvePushes(level, null, 200_000, 'greedy');
    return whole ? whole.moves : '';
  }
  let player = level.player;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const src = done[oj] ? rooms[oj].goals : rooms[oj].boxes;
      for (const b of src) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved =
      solvePushes(sub, room.squares, 400_000, 'astar') ??
      solvePushes(sub, room.squares, 400_000, 'bfs') ??
      solvePushes(sub, room.squares, 200_000, 'greedy');
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done[ri] = true;
  }
  return moves;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
