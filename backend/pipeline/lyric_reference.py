"""Obtain plain reference lyrics through a local installation of LDDC."""
from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import re
import sys
import unicodedata


ROOT = Path(__file__).resolve().parents[2]
LRC_TAG = re.compile(r"^\s*\[[a-z][a-z0-9_]*:[^\]]*\]\s*$", re.IGNORECASE)
TIME_TAG = re.compile(r"\[\d+:\d{2}(?:[.:]\d+)?\]|<\d+:\d{2}(?:[.:]\d+)?>")
HAN_DIGITS = re.compile(r"([\u3400-\u9fff]\s*)?([0-9０-９]+)(?=\s*([\u3400-\u9fff])?)")
DIGIT_READINGS = str.maketrans("0123456789０１２３４５６７８９", "零一二三四五六七八九" * 2)
CREDIT = re.compile(
    r"^(?:词(?:作者)?|曲(?:作者)?|作词|作曲|词曲|演唱|制作人?|出品人?|联合出品|监制|编曲|"
    r"戏腔|和声|录音|混音|母带|发行|版权|原唱|OP|SP|lyricist|composer|arranger|producer|publisher|vocal[s]?|mixing)"
    r"(?:\s*[/&]\s*(?:词|曲|混音|母带))?(?:\s*[A-Za-z][A-Za-z ]*)?\s*[:：]", re.IGNORECASE,
)


def normalized(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def vocal2midi_line(text, language):
    if language not in ("zh", "yue"):
        return text
    return HAN_DIGITS.sub(lambda match: match[0].translate(DIGIT_READINGS) if match[1] or match[3] else match[0], text)


def filename_metadata(stem):
    stem = re.sub(r"\s*\(\d+\)$", "", unicodedata.normalize("NFKC", stem)).strip()
    artist, _, title = stem.rpartition(" - ")
    return title.strip(), artist.strip()


def local_candidates(directory, title, artist, filename):
    wanted = normalized(title)
    artist_tokens = [normalized(name) for name in re.split(r"[/／,，、&]", artist) if normalized(name)]
    matches = []
    for path in directory.glob("*.lrc"):
        local_title, local_artist = filename_metadata(path.stem)
        if normalized(path.stem) == normalized(filename):
            priority = 2
        elif wanted and normalized(local_title) == wanted:
            local_tokens = [normalized(name) for name in re.split(r"[/／,，、&]", local_artist) if normalized(name)]
            if artist_tokens and local_tokens and not all(any(
                given.startswith(candidate) or candidate.startswith(given) for candidate in local_tokens
            ) for given in artist_tokens):
                continue
            priority = 1
        else:
            continue
        matches.append((priority, path))
    if not matches:
        return None
    best = max(priority for priority, _ in matches)
    paths = [path for priority, path in matches if priority == best]
    return paths[0] if len(paths) == 1 else None


def clean_lines(lines, title, artist):
    title_key = normalized(title)
    cleaned = []
    for line in lines:
        if LRC_TAG.fullmatch(line):
            continue
        line = TIME_TAG.sub("", line).strip()
        key = normalized(line)
        if not key or CREDIT.match(line):
            continue
        header, separator, _ = line.partition(" - ")
        if not cleaned and title_key and ((artist and key == title_key + normalized(artist))
                                          or (separator and normalized(header) == title_key)):
            continue
        cleaned.append(line)
    return cleaned


def extract(args):
    fallback_title, fallback_artist = filename_metadata(args.name)
    fallback_artist = re.sub(r"[/／,，、&]+", "/", fallback_artist)
    if args.lyrics and args.lyrics.suffix == ".txt":
        return clean_lines(args.lyrics.read_text(encoding="utf-8-sig").splitlines(), fallback_title, fallback_artist), "uploaded", None

    runtime = ROOT / "backend/runtime"
    sys.path[:0] = [str(runtime / "lddc-source"), str(runtime / "lddc-python")]
    from PySide6.QtCore import QCoreApplication
    from LDDC.common.data.config import cfg
    from LDDC.common.exceptions import GetSongInfoError
    from LDDC.common.models import Artist, SongInfo, Source
    from LDDC.core.api.lyrics.local import LocalAPI
    from LDDC.core.song_info import get_audio_file_infos

    app = QCoreApplication([])
    info = SongInfo(Source.Local)
    try:
        infos = get_audio_file_infos(args.song)
        if len(infos) == 1:
            info = infos[0]
    except GetSongInfoError as exc:
        print(f"LDDC could not read audio tags: {exc}", flush=True)
    info = replace(info, path=None, title=(info.title or fallback_title)[:200],
                   artist=info.artist or Artist([fallback_artist] if fallback_artist else []),
                   duration=round(args.duration * 1000))

    def text_lines(lyrics):
        return clean_lines(("".join(word.text for word in line.words) for line in lyrics.get("orig", [])),
                           info.title, str(info.artist or ""))

    if args.lyrics:
        return text_lines(LocalAPI().get_lyrics(path=args.lyrics)), "uploaded", None
    directories = (ROOT / "music", Path(cfg["default_save_path"]))
    for directory in dict.fromkeys(directories):
        path = local_candidates(directory, info.title, str(info.artist or ""), args.name)
        if path:
            try:
                lines = text_lines(LocalAPI().get_lyrics(path=path))
                if lines:
                    return lines, "lddc-local", path.name
            except Exception as exc:
                print(f"LDDC local lyrics skipped ({path.name}): {exc}", flush=True)

    if not args.online or not info.title:
        return [], "asr", None
    # Provider requests receive search metadata, not an audio file or its local path.
    from LDDC.core.auto_fetch import auto_fetch

    lyrics = auto_fetch(info, min_score=79, sources=(Source.QM, Source.KG, Source.NE, Source.LRCLIB))
    return text_lines(lyrics), "lddc-online", lyrics.info.source.name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--song", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--lyrics", type=Path)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--online", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    lines, source, detail = extract(args)
    if not lines:
        if args.lyrics:
            raise ValueError("提供的歌词文件没有可用的原文歌词")
        source, detail = "asr", None
    vocal2midi_lines = [vocal2midi_line(line, args.language) for line in lines]
    args.output.write_text(json.dumps({"lines": lines, "vocal2midiLines": vocal2midi_lines,
                                     "source": source, "detail": detail}, ensure_ascii=False), encoding="utf-8")
    print(f"Lyrics source: {source} ({detail or '-'}), {len(lines)} lines", flush=True)


if __name__ == "__main__":
    main()
