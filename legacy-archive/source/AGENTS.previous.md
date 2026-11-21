# Local Audio Project Instructions

- Keep processing and website testing local. Do not upload songs, voicebanks, or deploy the website without an explicit request.
- Preserve original WAV recordings, FRQ sidecars, `oto.ini`, and other voicebank source files.
- For ha, ji, and mi, use only the original unnumbered recordings. Numbered ha variants are different sounds and were explicitly rejected by the user.

## Lyric-Guided Segmentation

When an LDDC `.lrc` file has per-character timestamps, the website uses the timed characters for ordering and phrase structure. The current Tian Wai Lai Wu pack contains 30 lyric lines and 307 Chinese characters; each character is one replacement unit.

The website exposes three independent selectors. Note mode chooses `GAME · 人声`, `ROSVOT · 人声`, or `ROSVOT · 原曲`; timing mode chooses `拍子辅助` or `无拍子辅助`; pitch mode chooses `RMVPE 原曲`, `FCPE 人声`, or `无音高`. Every note mode has both timing variants, and every variant exposes the same three pitch choices. The selected note events own the MIDI note onset, offset, and tone; beat assist may make only a local correction using the accompaniment beat grid and its 1/16 subdivisions, while raw timing preserves the selected detector's onset and offset times.

An LDDC per-character `.lrc` is used only for lyric order, phrase structure, and grouping consecutive detected notes under one Chinese character; its character timestamps never become render cuts. In raw mode, a lyric character with no detected note is kept as an explicitly missing unit and does not cause neighboring boundaries to be split. RMVPE and FCPE are independent continuous pitch tracks: RMVPE reads the original song and FCPE reads Demucs vocals. Note-only mode leaves the pitch CSV empty so OpenUtau uses the selected MIDI note tone without a continuous pitch curve. The selected track is written inside the score units without centering, filtering, scaling, or pitch limiting. Without per-character LRC, the older acoustic segmentation remains an explicit fallback and must not invent character grouping from line-only timestamps.

The parser ignores LRC metadata and mixed Latin/punctuation lines. Regression coverage is in `backend/experiments/test_lyric_segmentation.py`.

## Native OpenUtau Workflow

The website uses one native rendering path for phrase preview, full-song preview, and final export. The bridge loads the local audio voicebank, `oto.ini`, source FRQ sidecars and voicebank metadata, then creates a task-local USTX project with OpenUtau phonemization and WORLDLINE-R. WORLDLINE-R performs its own phrase synthesis; it does not separately invoke the convergence wavtool or consume LLSM/ZPA files. It mixes the rendered vocal with the Demucs accompaniment and returns a 44.1 kHz stereo WAV.

The browser does not synthesize or tune the selected sounds. It only collects the sequence, submits a local render job, and plays the returned WAV. Original voicebank files are never overwritten; generated task files live under `backend/runtime/web-server/native-jobs`.

The local website may also accept a song and matching lyric file. Uploads are stored under the independent `projects/<song-id>/input/` directory, then analyzed with the same Demucs/GAME/ROSVOT/RMVPE/FCPE pipeline and packed into `website/assets/`. This is local project creation, not online deployment or external upload.

## Local Audio Tools

The website also exposes two independent local tools. Song-only uploads create `projects/upload-<uuid>/input/` and run only Demucs, returning downloadable vocals and accompaniment. Identical songs may reuse local stems by SHA-256; no analysis model is downloaded during a task. Decoding may reuse `Vocal2Midi/ffmpeg.exe` through WSL when no Linux FFmpeg is available.

USTX uploads use `backend/experiments/render_vocal2midi.py` and the native worker's `sourceUstx` path. They use the uploaded score's notes, onset/duration, tempo map and PITD curves, not GAME/ROSVOT analysis or an external pitch CSV. Replace each non-extender syllable with the global ha/ji/mi/man/bo cycle; preserve extenders without advancing the cycle. Native `snap_first` behavior follows the supplied score. Use a task-local copy of the original five-sample voicebank. The accompaniment must be explicitly selected from completed separations, the local catalog, or a separate accompaniment upload; a too-short accompaniment must fail rather than truncate the score.

For an extender separated from its preceding note by a rest, rearticulate the owning syllable's selected alias at the extender's original position and duration. Do not advance the sound cycle, fill the gap, move note boundaries, or rewrite pitch curves. Keep contiguous extenders as extenders. Reject orphan or overlapping extenders rather than guessing their ownership or retiming them. Record rearticulations in the render report and verify the output score against the original. Python/native process output and Node stream decoding must use UTF-8; keep full tracebacks in task logs while returning readable error summaries to the browser.

Tool metadata and outputs persist under `backend/runtime/web-server/audio-tools/<uuid>/`; OpenUtau render requests and copied banks remain under `backend/runtime/web-server/native-jobs/`. Completed tasks remain accessible after a local server restart. Current imported-score support is USTX 0.7; newer versions must fail explicitly instead of silently discarding fields. Do not overwrite the original USTX or source voicebank.
