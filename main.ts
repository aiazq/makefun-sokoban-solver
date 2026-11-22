// Sokoban solver for make.fun's "Build the best Sokoban solver" bounty.
//
// Push-optimal search. The scored quantity is pushes, not moves: an instance answered in exactly
// P* pushes earns the full 1,000 points, so the goal is the minimum number of pushes for every
// level, deterministically and inside the 60 s budget shared by the whole set.
//
// The bounty's own rules state the key structural fact this solver exploits: a box pushed through a
// room door lands in the one-square hallway, where it can reach no goal, so no box ever leaves its
// room. A level is therefore a set of independent rooms and its push-optimum P* is the sum of the
// rooms' optima. Each room holds only 3 or 4 boxes, so each is a small, tractable push-space.
//
// Search: breadth-first over push-states, so the first solved state is push-optimal. A state is the
// set of box squares plus the player's reachable region (named by its lowest square: two positions
// with the same region are interchangeable). Two sound deadlocks are pruned:
//   - dead squares: a box there can never be pushed onto any goal, whatever the other boxes do;
//   - frozen 2x2 blocks: two walls/boxes by two walls/boxes with a box off its goal inside; no
//     push can ever break the block.
// Neither prunes a solvable state, so the reported optimum is exact.
//
// Everything is bounded by work (state counts), never by the clock: two executions of the same
// input do the same work and write the same bytes. If a search would exceed its budget the program
// emits what it has (an empty, still-valid answer) rather than guess.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States one room-search keeps before giving up. Work, never the clock. */
const MAX_STATES_PER_ROOM = 500_000;
/** States the whole-level fallback keeps. */
const MAX_STATES_WHOLE = 600_000;

/** [dx, dy, step letter, push letter]. Direction order fixes tie-breaking, so runs are identical. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/**
 * Parse XSB text into wall/goal/box/player arrays over a w*h grid. Rows shorter than w and any
 * square outside a row read as wall, and the outermost frame is forced to wall: nothing leaves the
 * board.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(1, ...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals = [];
  const boxes = [];
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
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  return { w, h, size, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a box can still be pushed onto some goal, ignoring the other boxes: pull back
 * from every goal one push at a time. A box on a non-live square can never be placed, whatever the
 * rest of the board does.
 */
function liveSquares(w, wall, goals) {
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = [];
  for (const g of goals) {
    if (!live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d; // a box on y, pushed by d, lands on x
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Mark the squares the player reaches from `from` around walls and `occupied`, stamping `seen` with
 * `stamp`, and return the region's lowest square (the region's canonical name).
 */
function regionLow(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const dn = p + w;
    const lf = p - 1;
    const rt = p + 1;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (wall[dn] === 0 && occupied[dn] === 0 && seen[dn] !== stamp) {
      seen[dn] = stamp;
      stack[n++] = dn;
    }
    if (wall[lf] === 0 && occupied[lf] === 0 && seen[lf] !== stamp) {
      seen[lf] = stamp;
      stack[n++] = lf;
    }
    if (wall[rt] === 0 && occupied[rt] === 0 && seen[rt] !== stamp) {
      seen[rt] = stamp;
      stack[n++] = rt;
    }
  }
  return low;
}

/** Whether the box pushed to `t` froze a 2x2 block that holds a box off its goal. */
function frozenBlock(w, wall, occupied, goal, t) {
  for (let k = 0; k < 4; k++) {
    const a = k === 0 ? t : k === 1 ? t - 1 : k === 2 ? t - w : t - w - 1;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Pack the sorted box squares into one integer (exact while size**(boxes) stays under 2**53). */
function packBoxes(boxes, size) {
  let k = 0;
  for (let i = 0; i < boxes.length; i++) k = k * size + boxes[i];
  return k;
}

/**
 * The push-optimal solution of `level` ({pushes, moves} in LURD, a lower letter a step and an upper
 * one a push), searching at most `maxStates` states, or null when the search gives up (a level this
 * large is never drawn, so the fallback is only a guard).
 */
function solvePushOptimal(level, maxStates) {
  const { w, size, wall, goals } = level;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const boxesCount = level.boxes.length;
  if (boxesCount === 0) return { pushes: 0, moves: '' };
  for (const b of level.boxes) if (!live[b]) return null;

  const solvedOf = (boxes) => {
    for (let i = 0; i < boxes.length; i++) if (!goal[boxes[i]]) return false;
    return true;
  };

  // BFS frontier: the states in discovery order, each with its boxes, the player's square before the
  // deciding push, and its parent. Discovery order is push order, so the first solved state is
  // push-optimal. Region lowest squares are memoised per box multiset: many push orders reach the
  // same box layout, and its region is then computed once.
  const statesBoxes = [level.boxes];
  const statesPlayer = [level.player];
  const parent = [-1];
  const index = new Map();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(w, wall, occupied, level.player, seen, ++stamp, stack);
  index.set(packBoxes(level.boxes, size) * size + startLow, 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = solvedOf(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    regionLow(w, wall, occupied, statesPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const dx = DIRS[di][0];
        const dy = DIRS[di][1];
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, wall, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const nextKey = packBoxes(next, size);
        // The region is measured before the boxes are restored, so it is computed here rather than
        // memoised: a box multiset's region depends on which box was just pushed.
        const low = regionLow(w, wall, occupied, b, mark, ++stamp, stack);
        occupied[t] = 0;
        occupied[b] = 1;
        const stateKey = nextKey * size + low;
        if (index.has(stateKey)) continue;
        if (statesBoxes.length >= maxStates) return null;
        index.set(stateKey, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(head);
        if (solvedOf(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Walk the chosen states back and turn each push into a walk to the push square plus the push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    let from = -1;
    for (const b of boxes) {
      let inNext = false;
      for (const n of nextBoxes) if (n === b) { inNext = true; break; }
      if (!inNext) { from = b; break; }
    }
    let to = -1;
    for (const n of nextBoxes) {
      let inPrev = false;
      for (const b of boxes) if (b === n) { inPrev = true; break; }
      if (!inPrev) { to = n; break; }
    }
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    const dir = DIRS[[-w, w, -1, 1].indexOf(d)];
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` avoiding walls and boxes, in LURD steps (DIRS order on ties). */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    const up = p - w;
    const dn = p + w;
    const lf = p - 1;
    const rt = p + 1;
    if (!wall[up] && !occupied[up] && prev[up] === -1) { prev[up] = p; how[up] = 'u'; queue.push(up); }
    if (!wall[dn] && !occupied[dn] && prev[dn] === -1) { prev[dn] = p; how[dn] = 'd'; queue.push(dn); }
    if (!wall[lf] && !occupied[lf] && prev[lf] === -1) { prev[lf] = p; how[lf] = 'l'; queue.push(lf); }
    if (!wall[rt] && !occupied[rt] && prev[rt] === -1) { prev[rt] = p; how[rt] = 'r'; queue.push(rt); }
  }
  if (prev[to] === -1) throw new Error('walkTo: unreachable push square');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after `moves` from `from` (case ignored). */
function endOf(w, from, moves) {
  let p = from;
  for (let i = 0; i < moves.length; i++) {
    const ch = moves[i].toLowerCase();
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level's rooms: cut the player's row's non-live squares (the one-square hallway) out of the
 * floor, then each connected part left that holds a box is a room. Null when some part holds more
 * or fewer boxes than goals, or a box starts in the hallway: then the level is not a set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      const up = p - w;
      const dn = p + w;
      const lf = p - 1;
      const rt = p + 1;
      if (!wall[up] && !cut[up] && part[up] < 0) { part[up] = rooms.length; squares.push(up); }
      if (!wall[dn] && !cut[dn] && part[dn] < 0) { part[dn] = rooms.length; squares.push(dn); }
      if (!wall[lf] && !cut[lf] && part[lf] < 0) { part[lf] = rooms.length; squares.push(lf); }
      if (!wall[rt] && !cut[rt] && part[rt] < 0) { part[rt] = rooms.length; squares.push(rt); }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve `level` room by room: each room's push-optimal solution in turn, the other rooms' boxes
 * standing as walls (their goals, once a room is done), the player walking on from where the last
 * room left it. The rooms' optima add to the level's. Falls back to a whole-level search when the
 * level is not a clean set of rooms.
 */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_STATES_WHOLE);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const block = other.done ? other.goals : other.boxes;
      for (const b of block) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      size: level.size,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM);
    if (solved === null) return solvePushOptimal(level, MAX_STATES_WHOLE);
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The answer for one level: LURD moves, or an empty (still valid) string if it cannot be solved. */
function solve(text) {
  try {
    const level = parseLevel(text);
    const solved = solveByRooms(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

const ids = readdirSync(IN_DIR).sort();
for (const id of ids) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
