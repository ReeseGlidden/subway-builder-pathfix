# Subway Builder PathFix

Repairs [Subway Builder](https://www.subwaybuilder.com/) saves where creating a
route fails with **"No valid path found between station tracks"** even though
the tracks look perfectly connected.

**→ Use it in your browser: https://reeseglidden.github.io/subway-builder-pathfix/**

Your save never leaves your machine — the page does all the work locally and
your original file is never modified.

## The bug

Subway Builder connects tracks only when their endpoint coordinates match
**exactly**. Occasionally (most often around crossovers and rebuilt segments)
two track ends land a few *millionths of a degree* apart — a gap of a few
centimeters that is invisible at any zoom level but splits your network into
disconnected islands, so the route editor can't find a path. See
[SubwayBuilderIssues #704](https://github.com/colindm/SubwayBuilderIssues/issues/704).
Diagnosing it in game means demolishing and rebuilding track by track, which
can cost hundreds of millions of in-game dollars.

## What PathFix does

1. Unpacks your save (native `.metro` or "Legacy JSON" export) and builds the
   track connection graph.
2. Finds endpoint pairs closer than a threshold (default **5 m**) that belong
   to *disconnected* sections of the network. Legitimate parallel double-track
   is never touched (see the guards below); endpoints at different elevations
   are never welded together.
3. Snaps each gap shut so the coordinates match exactly, then verifies the
   network is connected.
4. Writes a **new** save named "… FIXED" with a fresh ID, so it shows up as a
   separate entry in the load menu next to your untouched original.

## Usage

### Browser (recommended)

Open the [PathFix page](https://reeseglidden.github.io/subway-builder-pathfix/),
drop your save on it, review the report, download the fixed file, and put it in
your saves folder:

| OS | Saves folder |
|---|---|
| Windows | `%APPDATA%\SubwayBuilder\saves` |
| macOS | `~/Library/Application Support/SubwayBuilder/saves` *(standard Electron location — confirmations welcome)* |
| Linux | `~/.config/SubwayBuilder/saves` *(likewise)* |

### Command line

Python 3.8+, no dependencies:

```console
$ python3 pathfix.py "%APPDATA%\SubwayBuilder\saves\dc_1_<id>.metro"
Connected sections: 2 -> 1
  island 1: 1 St, 10 St, 14 St, ...
  island 2: Kenilworth Av
  FIXED  0.173 m gap at (-76.951651, 38.896072) -> (-76.951653, 38.896072)  [1 track end(s) moved]
  FIXED  0.173 m gap at (-76.951655, 38.896120) -> (-76.951653, 38.896120)  [1 track end(s) moved]
Wrote dc_1_fixed_<newid>.metro
```

Options: `--threshold <meters>` (default 5.0), `--dry-run` (report only),
`--aggressive` (also close sub-threshold gaps *within* an already-connected
section — off by default because such gaps don't break pathfinding on their
own), `--keep-identity`, `-o <path>`.

## Sanity guards

- Only gaps **≤ threshold** (default 5 m) are considered.
- For gaps over ~1.5 m the two track ends must roughly point at each other —
  a near-miss that runs *sideways* to the track direction is parallel
  double-track (~5 m spacing), not a broken joint, and is never welded.
- By default a gap is only closed if it joins two disconnected components.
- Endpoints with more than 0.5 m of elevation difference are skipped
  (reported, not modified) — a tunnel passing under a surface track is not a
  broken joint.
- Anything that references the moved coordinate (switch nodes, station
  centers) is updated in the same pass, and the tool refuses to overwrite its
  input file.

Still: **saves are precious — keep backups.** The tool never touches the
original, but belt and suspenders.

## Save format notes

The `.metro` container format (4 KB binary header + gzipped JSON) is
documented in [FORMAT.md](FORMAT.md) — likely the only public documentation of
it. Corrections welcome.

## Contributing

Issues and PRs welcome — especially confirmations of the macOS/Linux save
paths, saves the tool couldn't fix (attach the save + what you expected), and
corrections to FORMAT.md. Run tests with `node test/synthetic.mjs`.

## License

[MIT](LICENSE). Not affiliated with Subway Builder or its developer.
