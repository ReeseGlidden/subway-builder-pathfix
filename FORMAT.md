# The Subway Builder `.metro` save format

Reverse-engineered 2026-08 from format version 2 saves (game v1.x) by diffing
sibling saves; the main-process writer is bytecode-compiled, so semantics below
are empirical. Corrections and additions welcome.

## Container layout

```
offset    size   contents
0x0000    4      magic "METR" (4D 45 54 52)
0x0004    4      0
0x0008    4      u32 LE  header size (0x1000)
0x000C    4      u32 LE  format version (2)
0x0010    4      u32 LE  thumbnail offset (0x1002)
0x0014    4      u32 LE  thumbnail length (0 if the save has no thumbnail)
0x0018    4      u32 LE  gzip payload offset (= thumbnail offset + length)
0x001C    4      u32 LE  gzip payload length
0x0020    8      u64 LE  save timestamp, Unix milliseconds
0x0028    256    save name, UTF-8, zero-padded
0x0128    ~      city code (e.g. "DC"), zero-padded
0x0150    ~      gameSessionId (UUID string), zero-padded
0x0188    ~      small metadata JSON: {"stations":N,"routes":N,"trains":N,
                 "money":F,"elapsedSeconds":N}, zero-padded
0x038C    4      u32 LE  10 (constant; meaning unknown, maybe a field tag)
0x0390    4      u32 LE  CRC32 of the gzip payload bytes  ← REQUIRED
0x0394    4      u32 LE  1 (constant; maybe "checksum present")
0x1000    2      literal "[]" (5B 5D)
0x1002    …      optional PNG thumbnail (length given at 0x14)
…         …EOF   gzip stream of the full save JSON (offset given at 0x18)
```

**The header contains a mandatory checksum.** `verifySaveIntegrity` in the
game recomputes CRC32 over the gzip payload bytes (`payload offset` through
`payload offset + payload length`) and compares it to the u32 at **0x0390**;
on mismatch the save is rejected with *"Checksum verification failed …
Expected N, got M"* (surfaced in the UI as "file may be corrupted or in an
unsupported format"). Any tool that rewrites the payload must update 0x390.
Note the CRC is over the *compressed* bytes — the gzip stream's own internal
CRC32 (over the uncompressed data) is separate and also has to be intact,
which any standard gzip implementation guarantees. The game zeroes the gzip
MTIME field.

Saves written since mid-2026 builds embed a PNG thumbnail between the header
and the payload; older saves have thumbnail length 0 and both offset fields
equal (0x1002), which is why the payload offset is easily mistaken for a
duplicated field.

## Save JSON essentials

Decompressed, the payload is one JSON object:

```jsonc
{
  "mainSave": {
    "id": "uuid",          // save identity — give copies a fresh one
    "name": "DC 1",
    "timestamp": 1785683221566,
    "version": 3,          // JSON schema version (distinct from header version)
    "cityCode": "DC",
    "gameSessionId": "uuid",
    "metadata": { ... },   // same summary as in the binary header
    "viewport": { ... },
    "data": {
      "tracks":      [ ... ],
      "stNodes":     [ ... ],  // switch/split nodes
      "stations":    [ ... ],
      "trackGroups": [ ... ],
      "signals":     [ ... ],
      "routes":      [ ... ],
      "trains":      [ ... ],
      // financials, demand data, stats, ...
    }
  },
  "autosaves": []
}
```

### Tracks and connectivity

```jsonc
{
  "id": "uuid",            // split tracks get suffixes: "uuid@@1", "uuid@@2"
  "coords": [[lon, lat], ...],   // polyline; first/last are the endpoints
  "startElevation": -9.14, "endElevation": -9.14,   // meters
  "type": null | "station" | "scissors-crossover",
  "trackType": "heavy-metro",
  "buildType": "constructed",
  "curveType": "straight" | "quadratic-start" | ...,
  "length": 93.45          // meters
}
```

**Tracks are connected if and only if their endpoint coordinate pairs are
bitwise-identical floats.** There is no separate edge/junction table for plain
track-to-track joins; `stNodes` mark switch locations (their `center` equals
the shared endpoint) but connectivity itself is the coordinate match. This is
why a discrepancy in the 6th decimal place (≈ 10 cm) silently severs the
network and produces "No valid path found between station tracks".

Parallel tracks of a double-track line sit ~5 m apart, so a sub-meter
proximity threshold cleanly separates "broken joint" from "adjacent track".

### Related observations

- `stations[].trackIds` / `trackGroups[].trackIds` reference track ids
  including the `@@n` suffix.
- `routes[].stNodes` / `stCombos` are filled in only once the game
  successfully paths the route.
- The "Legacy JSON" export from the Load/Save menu is this same JSON object,
  uncompressed.
