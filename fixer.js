// Core repair logic for Subway Builder "No Valid Path" saves.
// Runs in modern browsers and Node 18+ — no dependencies.
// Uses native CompressionStream / DecompressionStream for gzip.

const NAME_OFFSET = 0x28; // save name, zero-padded, ends before city code at 0x128
const NAME_MAX = 255;
const LEN_OFFSET = 0x1c; // u32 LE: gzip payload byte length
const TS_OFFSET = 0x20; // u64 LE: save timestamp in ms

// Snapping two endpoints with a bigger elevation gap than this is refused —
// they are probably different levels of the network, not a misalignment.
const MAX_ELEVATION_DELTA = 0.5;

// For gaps beyond this, the two track ends must roughly point at each other
// (within 60°) or the pair is refused: a sideways near-miss is parallel
// tracks, not a broken joint. Below it, coordinates are rounded too coarsely
// (~0.1 m) for direction to mean anything.
const ALIGNMENT_CHECK_MIN_M = 1.5;
const ALIGNMENT_MIN_COS = 0.5;

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Accepts a native .metro save or a "Legacy JSON" export.
export async function parseSaveFile(bytes) {
  const text = (b) => new TextDecoder().decode(b);
  if (text(bytes.slice(0, 4)) === 'METR') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(0x0c, true);
    const payloadOffset = view.getUint32(0x10, true);
    if (payloadOffset < 0x30 || payloadOffset >= bytes.length) {
      throw new Error(`Corrupt .metro header: payload offset 0x${payloadOffset.toString(16)}`);
    }
    const save = JSON.parse(text(await gunzip(bytes.slice(payloadOffset))));
    return { kind: 'metro', header: bytes.slice(0, payloadOffset), save, version };
  }
  return { kind: 'json', header: null, save: JSON.parse(text(bytes)), version: null };
}

export function getGameData(save) {
  if (save?.mainSave?.data?.tracks) return save.mainSave.data;
  if (save?.data?.tracks) return save.data;
  if (save?.tracks) return save;
  throw new Error('Unrecognized save structure: no track data found');
}

function metersVector(from, to) {
  const latRad = (((from[1] + to[1]) / 2) * Math.PI) / 180;
  return [(to[0] - from[0]) * 111320 * Math.cos(latRad), (to[1] - from[1]) * 110540];
}

function metersBetween(a, b) {
  return Math.hypot(...metersVector(a, b));
}

function unit(v) {
  const m = Math.hypot(v[0], v[1]);
  return m ? [v[0] / m, v[1] / m] : null;
}

// Direction a track "exits" through this endpoint, from its last leg.
function outwardDirection(ref) {
  const cs = ref.track.coords;
  return unit(ref.end === 'start'
    ? metersVector(cs[1], cs[0])
    : metersVector(cs[cs.length - 2], cs[cs.length - 1]));
}

function endsPointAtEachOther(ea, eb) {
  const g = unit(metersVector(ea.coord, eb.coord));
  if (!g) return true;
  const facing = (e, dir) => e.refs.some((r) => {
    const d = outwardDirection(r);
    return !d || d[0] * dir[0] + d[1] * dir[1] >= ALIGNMENT_MIN_COS;
  });
  return facing(ea, g) && facing(eb, [-g[0], -g[1]]);
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a, b) {
    this.parent.set(this.find(a), this.find(b));
  }
}

const coordKey = (c) => c[0] + ',' + c[1];

function buildEndpointIndex(tracks) {
  const endpoints = new Map(); // key -> { coord, refs: [{track, end}] }
  for (const t of tracks) {
    const cs = t.coords;
    if (!Array.isArray(cs) || cs.length < 2) continue;
    for (const end of ['start', 'end']) {
      const c = end === 'start' ? cs[0] : cs[cs.length - 1];
      const k = coordKey(c);
      if (!endpoints.has(k)) endpoints.set(k, { coord: [c[0], c[1]], refs: [] });
      endpoints.get(k).refs.push({ track: t, end });
    }
  }
  return endpoints;
}

function buildUnionFind(tracks) {
  const uf = new UnionFind();
  for (const t of tracks) {
    const cs = t.coords;
    if (!Array.isArray(cs) || cs.length < 2) continue;
    uf.union(coordKey(cs[0]), coordKey(cs[cs.length - 1]));
  }
  return uf;
}

// Groups stations by connected component so reports can name the islands.
function describeComponents(data) {
  const uf = buildUnionFind(data.tracks);
  const trackById = new Map(data.tracks.map((t) => [t.id, t]));
  const groups = new Map(); // root -> Set of station names
  for (const t of data.tracks) {
    if (Array.isArray(t.coords) && t.coords.length >= 2) {
      const root = uf.find(coordKey(t.coords[0]));
      if (!groups.has(root)) groups.set(root, new Set());
    }
  }
  for (const s of data.stations || []) {
    for (const tid of s.trackIds || []) {
      const t = trackById.get(tid);
      if (t && Array.isArray(t.coords) && t.coords.length >= 2) {
        groups.get(uf.find(coordKey(t.coords[0])))?.add(s.name);
        break;
      }
    }
  }
  return [...groups.values()]
    .map((set) => [...set].sort())
    .sort((a, b) => b.length - a.length);
}

function nearMissPairs(endpoints, thresholdMeters) {
  const CELL = 2e-4; // ~11-22 m per cell; 3x3 neighborhood covers any sane threshold
  const grid = new Map();
  const cellXY = (c) => [Math.floor(c[0] / CELL), Math.floor(c[1] / CELL)];
  for (const [k, e] of endpoints) {
    const ck = cellXY(e.coord).join(':');
    if (!grid.has(ck)) grid.set(ck, []);
    grid.get(ck).push(k);
  }
  const pairs = [];
  const seen = new Set();
  for (const [k, e] of endpoints) {
    const [cx, cy] = cellXY(e.coord);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const k2 of grid.get(cx + dx + ':' + (cy + dy)) || []) {
          if (k2 === k) continue;
          const pairKey = k < k2 ? k + '|' + k2 : k2 + '|' + k;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const d = metersBetween(e.coord, endpoints.get(k2).coord);
          if (d > 0 && d <= thresholdMeters) pairs.push({ a: k, b: k2, d });
        }
      }
    }
  }
  return pairs.sort((x, y) => x.d - y.d);
}

const elevOf = (ref) =>
  ref.end === 'start' ? ref.track.startElevation : ref.track.endElevation;

// Finds sub-threshold endpoint gaps and snaps them shut, in place.
// By default only gaps that bridge two disconnected components are touched;
// aggressive=true also snaps near-misses inside an already-connected component.
export function analyzeAndFix(save, { thresholdMeters = 5.0, aggressive = false } = {}) {
  const data = getGameData(save);
  const endpoints = buildEndpointIndex(data.tracks);
  // Eligibility uses the component structure BEFORE any fixes: a double-track
  // break is two parallel gaps across the same divide, and closing the first
  // must not disqualify the second.
  const uf = buildUnionFind(data.tracks);
  const rootBefore = new Map([...endpoints.keys()].map((k) => [k, uf.find(k)]));
  const islandsBefore = describeComponents(data);

  const fixes = [];
  const skipped = [];
  for (const { a, b, d } of nearMissPairs(endpoints, thresholdMeters)) {
    const ea = endpoints.get(a);
    const eb = endpoints.get(b);
    if (!ea || !eb) continue; // one side already merged into an earlier fix
    const pair = { distanceMeters: d, coords: [ea.coord, eb.coord] };

    if (!aggressive && rootBefore.get(a) === rootBefore.get(b)) {
      skipped.push({ ...pair, reason: 'already-connected' });
      continue;
    }
    const tracksAtA = new Set(ea.refs.map((r) => r.track.id));
    if (eb.refs.some((r) => tracksAtA.has(r.track.id))) {
      skipped.push({ ...pair, reason: 'same-track' });
      continue;
    }
    if (d > ALIGNMENT_CHECK_MIN_M && !endsPointAtEachOther(ea, eb)) {
      skipped.push({ ...pair, reason: 'not-aligned' });
      continue;
    }
    let minElevDelta = Infinity;
    for (const ra of ea.refs) {
      for (const rb of eb.refs) {
        minElevDelta = Math.min(minElevDelta, Math.abs((elevOf(ra) ?? 0) - (elevOf(rb) ?? 0)));
      }
    }
    if (minElevDelta > MAX_ELEVATION_DELTA) {
      skipped.push({ ...pair, reason: 'elevation-mismatch', deltaMeters: minElevDelta });
      continue;
    }

    // Move the endpoint fewer tracks depend on; ties move b onto a.
    const [winner, loser] = ea.refs.length >= eb.refs.length ? [ea, eb] : [eb, ea];
    const target = winner.coord;
    const winnerElevs = winner.refs.map(elevOf).filter((e) => typeof e === 'number');
    const [lx, ly] = loser.coord;
    const movedTracks = [];
    for (const ref of loser.refs) {
      const cs = ref.track.coords;
      cs[ref.end === 'start' ? 0 : cs.length - 1] = [target[0], target[1]];
      const myElev = elevOf(ref);
      if (typeof myElev === 'number' && winnerElevs.length) {
        const closest = winnerElevs.reduce((p, c) =>
          Math.abs(c - myElev) < Math.abs(p - myElev) ? c : p
        );
        if (closest !== myElev && Math.abs(closest - myElev) <= MAX_ELEVATION_DELTA) {
          if (ref.end === 'start') ref.track.startElevation = closest;
          else ref.track.endElevation = closest;
        }
      }
      movedTracks.push(ref.track.id);
      winner.refs.push(ref);
    }
    for (const n of data.stNodes || []) {
      if (n.center && n.center[0] === lx && n.center[1] === ly) n.center = [target[0], target[1]];
    }
    for (const s of data.stations || []) {
      if (s.coords && s.coords[0] === lx && s.coords[1] === ly) s.coords = [target[0], target[1]];
    }
    endpoints.delete(loser === ea ? a : b);
    fixes.push({ distanceMeters: d, from: [lx, ly], to: [target[0], target[1]], tracks: movedTracks });
  }

  return {
    componentsBefore: islandsBefore.length,
    componentsAfter: describeComponents(data).length,
    islandsBefore,
    islandsAfter: describeComponents(data),
    fixes,
    skipped,
  };
}

// Geometry for map display. A track end is healthy if track continues through
// it (two or more segment ends meet there) or it's the end of a station
// platform track — a legitimate line terminal. Segments with an unhealthy
// (bare, dangling) end are flagged so the map can paint them as suspect;
// a valid network of several separate lines shows no flags at all.
export function extractMapData(save) {
  const data = getGameData(save);
  const tracks = data.tracks.filter((t) => Array.isArray(t.coords) && t.coords.length >= 2);
  const degree = new Map();
  const stationEnd = new Set(); // endpoints belonging to a station platform track
  for (const t of tracks) {
    for (const c of [t.coords[0], t.coords[t.coords.length - 1]]) {
      const k = coordKey(c);
      degree.set(k, (degree.get(k) ?? 0) + 1);
      if (t.type === 'station') stationEnd.add(k);
    }
  }
  const healthy = (c) => {
    const k = coordKey(c);
    return (degree.get(k) ?? 0) >= 2 || stationEnd.has(k);
  };
  return {
    tracks: tracks.map((t) => ({
      coords: t.coords.map((c) => [c[0], c[1]]),
      dangling: !healthy(t.coords[0]) || !healthy(t.coords[t.coords.length - 1]),
    })),
    stations: (data.stations || [])
      .filter((s) => Array.isArray(s.coords) && s.coords.length >= 2)
      .map((s) => ({ name: s.name ?? '', coord: [s.coords[0], s.coords[1]] })),
  };
}

// Gives the repaired save a new identity so it never collides with the original.
export function rebrand(save, suffix = ' FIXED') {
  if (!save?.mainSave) return null;
  const ms = save.mainSave;
  if (typeof ms.name === 'string' && !ms.name.endsWith(suffix)) ms.name += suffix;
  ms.id = crypto.randomUUID();
  return { name: ms.name, id: ms.id };
}

export function suggestFilename(parsed) {
  const ms = parsed.save?.mainSave;
  const slug = String(ms?.name ?? 'save')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (parsed.kind === 'json' || !ms?.id) return slug + '_fixed.json';
  return slug + '_' + ms.id.replace(/-/g, '') + '.metro';
}

export async function serializeSave(parsed) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(parsed.save));
  if (parsed.kind === 'json') return jsonBytes;
  const payload = await gzip(jsonBytes);
  const header = parsed.header.slice();
  const view = new DataView(header.buffer);
  view.setUint32(LEN_OFFSET, payload.length, true);
  view.setBigUint64(TS_OFFSET, BigInt(Date.now()), true);
  const name = parsed.save?.mainSave?.name;
  if (typeof name === 'string') {
    header.fill(0, NAME_OFFSET, NAME_OFFSET + NAME_MAX + 1);
    header.set(new TextEncoder().encode(name).slice(0, NAME_MAX), NAME_OFFSET);
  }
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}
