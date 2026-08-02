// Self-contained tests using synthetic saves — run with: node test/synthetic.mjs
import { parseSaveFile, analyzeAndFix, rebrand, suggestFilename, serializeSave }
  from '../fixer.js';
import assert from 'node:assert/strict';

const track = (id, a, b, elev = 0) => ({
  id, coords: [a, b], startElevation: elev, endElevation: elev,
});

const makeSave = (tracks, stations = [], stNodes = []) => ({
  mainSave: { id: '00000000-0000-4000-8000-000000000000', name: 'TEST',
              data: { tracks, stations, stNodes } },
});

// --- 1. The classic bug: a 0.17 m gap splits the network ------------------
{
  const save = makeSave([
    track('t1', [-77.0, 38.9], [-77.001, 38.9]),
    track('t2', [-77.001000002, 38.9], [-77.002, 38.9]), // ~0.17 m off
    track('t3', [-77.002, 38.9], [-77.003, 38.9]),
  ], [
    { id: 's1', name: 'Alpha', trackIds: ['t1'] },
    { id: 's2', name: 'Beta', trackIds: ['t3'] },
  ]);
  const r = analyzeAndFix(save);
  assert.equal(r.componentsBefore, 2);
  assert.equal(r.componentsAfter, 1);
  assert.equal(r.fixes.length, 1);
  assert.ok(r.fixes[0].distanceMeters < 0.5);
  const [t1, t2] = save.mainSave.data.tracks;
  assert.deepEqual(t2.coords[0], t1.coords[1], 'endpoints snapped to identical values');
  console.log('ok  1: snaps a sub-meter gap and reconnects the network');
}

// --- 2. Parallel double-track (~5 m apart) is never touched ---------------
{
  const save = makeSave([
    track('a1', [-77.0, 38.9], [-77.001, 38.9]),
    track('a2', [-77.0, 38.900046], [-77.001, 38.900046]), // parallel, ~5 m north
    track('x', [-77.001, 38.9], [-77.001, 38.900046]), // connector at one end
  ]);
  const r = analyzeAndFix(save);
  assert.equal(r.fixes.length, 0);
  console.log('ok  2: leaves parallel track spacing alone');
}

// --- 3. Elevation mismatch is refused --------------------------------------
{
  const save = makeSave([
    track('up', [-77.0, 38.9], [-77.001, 38.9], 0),
    track('down', [-77.001000002, 38.9], [-77.002, 38.9], -12),
  ]);
  const r = analyzeAndFix(save);
  assert.equal(r.fixes.length, 0);
  assert.equal(r.skipped[0].reason, 'elevation-mismatch');
  console.log('ok  3: refuses to weld different elevations together');
}

// --- 4. Already-connected near-misses need --aggressive --------------------
{
  const tracks = [
    track('loop1', [-77.0, 38.9], [-77.001, 38.9]),
    track('loop2', [-77.001, 38.9], [-77.001, 38.901]),
    track('loop3', [-77.001, 38.901], [-77.000000002, 38.9]), // ends 0.17 m from start
  ];
  const conservative = analyzeAndFix(makeSave(structuredClone(tracks)));
  assert.equal(conservative.fixes.length, 0);
  assert.equal(conservative.skipped[0].reason, 'already-connected');
  const aggressive = analyzeAndFix(makeSave(structuredClone(tracks)), { aggressive: true });
  assert.equal(aggressive.fixes.length, 1);
  console.log('ok  4: same-component gaps only close with aggressive=true');
}

// --- 5. .metro round trip ---------------------------------------------------
{
  const save = makeSave([
    track('t1', [-77.0, 38.9], [-77.001, 38.9]),
    track('t2', [-77.001000002, 38.9], [-77.002, 38.9]),
  ]);
  // Build a minimal valid .metro container around it.
  const header = new Uint8Array(0x1002);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('METR'), 0);
  view.setUint32(0x08, 0x1000, true); // header size
  view.setUint32(0x0c, 2, true); // format version
  view.setUint32(0x10, 0x1002, true); // payload offset
  view.setUint32(0x18, 0x1002, true);
  header.set(new TextEncoder().encode('TEST'), 0x28);
  header.set(new TextEncoder().encode('[]'), 0x1000);
  const { gzip } = await import('../fixer.js');
  const payload = await gzip(new TextEncoder().encode(JSON.stringify(save)));
  view.setUint32(0x1c, payload.length, true);
  const file = new Uint8Array(header.length + payload.length);
  file.set(header, 0);
  file.set(payload, header.length);

  const parsed = await parseSaveFile(file);
  assert.equal(parsed.kind, 'metro');
  const r = analyzeAndFix(parsed.save);
  assert.equal(r.fixes.length, 1);
  const before = parsed.save.mainSave.id;
  rebrand(parsed.save);
  assert.notEqual(parsed.save.mainSave.id, before);
  assert.equal(parsed.save.mainSave.name, 'TEST FIXED');
  assert.match(suggestFilename(parsed), /^test_fixed_[0-9a-f]{32}\.metro$/);

  const out = await serializeSave(parsed);
  const reparsed = await parseSaveFile(out);
  assert.equal(reparsed.save.mainSave.name, 'TEST FIXED');
  assert.equal(new DataView(out.buffer).getUint32(0x1c, true), out.length - 0x1002,
    'header payload length matches file layout');
  assert.equal(analyzeAndFix(reparsed.save).componentsBefore, 1,
    'repaired save parses back as a single component');
  console.log('ok  5: .metro container round-trips with a correct header');
}

// --- 6. Double-track break: BOTH parallel gaps across one divide close ----
{
  const save = makeSave([
    // northbound + southbound pair, each with its own ~0.17 m gap at the divide
    track('n-west', [-77.0, 38.9], [-77.001, 38.9]),
    track('n-east', [-77.001000002, 38.9], [-77.002, 38.9]),
    track('s-west', [-77.0, 38.900046], [-77.001, 38.900046]),
    track('s-east', [-77.001000002, 38.900046], [-77.002, 38.900046]),
    // connectors making each side internally connected
    track('x-west', [-77.0, 38.9], [-77.0, 38.900046]),
    track('x-east', [-77.002, 38.9], [-77.002, 38.900046]),
  ]);
  const r = analyzeAndFix(save);
  assert.equal(r.componentsBefore, 2);
  assert.equal(r.fixes.length, 2,
    'closing the first gap must not disqualify the parallel one');
  assert.equal(r.componentsAfter, 1);
  console.log('ok  6: closes both gaps of a double-track break');
}

console.log('all tests passed');
