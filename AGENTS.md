# Local Audio Project Instructions

- Keep song processing, website testing and rendering local. Never upload songs, voicebanks or deploy without an explicit request.
- Preserve original songs, lyrics, user USTX exports, WAV recordings, FRQ sidecars, `oto.ini` and other voicebank sources.
- For ha, ji and mi use only the original unnumbered recordings. Numbered variants are different sounds and were rejected.

## Vocal Projects

The website has exactly one vocal USTX project-generation path:

1. Save a local song upload under `projects/v2m-<uuid>/input/`.
2. Separate vocals and accompaniment with the installed Demucs environment.
3. Use LDDC to read or find plain reference lyrics where available. Use original text only; never apply LDDC timestamps or send audio to lyrics providers. Invoke the installed `Vocal2Midi/scripts/auto_lyric_cli.py` on the separated vocals, with USTX output and its pitch curve enabled. When available, give Vocal2Midi the text through its native `--lyrics-file` option; otherwise use its ASR. Do not reimplement its transcription, alignment or pitch processing.
4. Index the resulting USTX for the editor without changing notes or timing.

Do not restore the former custom GAME/ROSVOT/FCPE analysis, LDDC timing grouping, beat snapping, generated pitch CSVs or browser audio synthesis. Old mode parameters are rejected by the API. The archive is historical source only and must not be imported by active code. GAME and RMVPE models *inside Vocal2Midi* remain necessary dependencies of Vocal2Midi, not a second website pipeline.

## USTX Rendering Invariants

- The source USTX owns all notes, onset/offset ticks, tempo events and PITD curves. No custom retiming, quantization, filtering, centering, pitch limiting or lyric-based note segmentation is applied by the website.
- One primary lyric is one selectable sound. Following `+`/`+~`/`-` notes belong to that same unit. Use reliable text line boundaries for editor grouping only. Groups of 12 units are fallback pages, not inferred lyric lines or render cuts.
- Preview, full playback, manual loop generation and export all load the same source USTX with the same native OpenUtau renderer. Custom selections are passed as one exact alias per primary unit.
- Render the complete score before cropping preview audio. Do not cut/rebuild source notes at page boundaries or splice five pre-rendered tracks.
- Contiguous extenders retain their extension behavior. An extender after a rest rearticulates its owning sound without advancing the sequence or changing any timing. Orphan/overlapping extenders fail explicitly.
- OpenUtau applies its native validation, phonemization, convergence and WORLDLINE-R. Native `snap_first` pitch-point changes are reported separately; source MIDI events, tempo map and part PITD curves are checked for exact preservation.
- Copy the voicebank into each task directory before rendering. Load its original WAV, `oto.ini`, FRQ and metadata; never write caches into `audio/` or the user's original bank.
- Verify source hashes and exact selection before publishing output. Never silently fall back to another synthesis path on error.
- Keep subprocess output UTF-8 end to end. Show readable errors and retain complete task logs.

## Layout And Tests

- `backend/pipeline/`: Demucs wrapper, USTX indexer, native render wrapper and regression tests.
- `backend/runtime/openutau-native/`: active C# bridge; `openutau-source/`: its dependency.
- `Vocal2Midi/`: installed portable program, Python and required models. Preserve it.
- `website/`: local UI, project/job services, native render API and tests.
- `projects/v2m-*/project.json`: only ready manifests with `pipeline: vocal2midi-ustx-v1` appear in the website catalog.
- `backend/runtime/web-server/v2m-jobs/`: persistent generation/render history and logs; `audio-tools/`: separation/manual USTX tasks.
- `legacy-archive/`: source/document snapshot and cleanup manifest, never runtime dependencies.

Run `node --test website/tests/*.test.mjs` and `Vocal2Midi/python/python.exe -X utf8 -m unittest discover -s backend/pipeline -p "test_*.py"` after relevant changes. Build the native worker after C# edits. Real local checks are `website/scripts/smoke-local.mjs` (creates a project) and `verify-local.mjs` (checks all rendering endpoints).
