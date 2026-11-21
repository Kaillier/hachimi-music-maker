"""Assemble the locally selected syllables without modifying the source voicebanks."""
from pathlib import Path
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOURCE_BANK = ROOT / "哈基米音源" / "ha ji mi音源v0.9.5"
SLICES = ROOT / "片段筛选"
VOICEBANK = ROOT / "voicebanks" / "selected"

# The sample name occasionally differs from the character shown in the editor.
ORIGINALS = """
ding dong ji2 da2 gou jiao chu qu kang ma2 dai2 shen fen jin yi duan shu
lou shang de xia2 lai gao1 he2 suan xi ga wo bei ya ku luu ou ma li wa xia yue dai za bu
""".split()

# Store OTO timing as offset, fixed duration, cutoff, preutterance and overlap, in ms.
CUTS = {
    "a_axiga": ("阿西噶阿西噶阿西噶/补切试听/啊.wav", "0,22,2,15,4"),
    "jian": ("出去见缸马/补切试听/见.wav", "0,60,8,38,7"),
    "nan": ("哈基米我南北路多/补切试听/南.wav", "0,44,5,32,6"),
    "lu": ("哈基米我南北路多/补切试听/路.wav", "0,40,5,26,6"),
    "ha_nailong": ("哈椰果奶龙/补切试听/哈.wav", "0,46,4,39,6"),
    "nai": ("哈椰果奶龙/补切试听/奶.wav", "0,78,7,60,8"),
    "ji_omajili": ("哦马吉利曼波/补切试听/吉.wav", "0,48,4,32,5"),
}


def copy(path, name):
    destination = VOICEBANK / name
    if not destination.exists() or destination.read_bytes() != path.read_bytes():
        shutil.copyfile(path, destination)


def timing():
    oto = (SOURCE_BANK / "oto.ini").read_text(encoding="cp932", errors="replace")
    return {filename: right.partition(",")[2] for line in oto.splitlines()
            if "=" in line for filename, right in [line.split("=", 1)]}


def main():
    catalogue = json.loads((ROOT / "website/sound-packs.json").read_text(encoding="utf-8"))
    originals = {f"clip_{stem}": stem for stem in ORIGINALS}
    originals.update({alias: originals[source] for alias, source in catalogue["sourceAliases"].items()})
    aliases = set(originals) | {f"clip_{name}" for name in (*CUTS, "do")}
    used = {sound for pack in catalogue["packs"] for sound in pack["pattern"]}
    known = catalogue["labels"].keys()
    if aliases != {name for name in known if name.startswith("clip_")} or not used <= known:
        raise ValueError("The prepared audio and the website catalogue reference different aliases.")

    VOICEBANK.mkdir(parents=True, exist_ok=True)
    rows = {}
    entries = timing()
    for alias, stem in originals.items():
        source = f"{stem}.wav"
        copy(SOURCE_BANK / source, f"{alias}.wav")
        copy(SOURCE_BANK / f"{stem}_wav.frq", f"{alias}_wav.frq")
        rows[alias] = entries[source]

    for stem, (path, parameters) in CUTS.items():
        alias = f"clip_{stem}"
        copy(SLICES / path, f"{alias}.wav")
        rows[alias] = parameters
    copy(ROOT / "哈基米音源/马の音/完整与拓展/原著单音/do.wav", "clip_do.wav")
    rows["clip_do"] = "0,74,10,32,6"

    (VOICEBANK / "oto.ini").write_text(
        "".join(f"{alias}.wav={alias},{values}\n" for alias, values in rows.items()), encoding="ascii"
    )
    worker = ROOT / "backend/runtime/openutau-native/bin/Release/net8.0/Hachimi.OpenUtau.Native.exe"
    wavs = [str(VOICEBANK / f"clip_{name}.wav") for name in (*CUTS, "do")]
    subprocess.run([str(worker), "--generate-frq", *wavs], cwd=worker.parent, check=True)
    print(f"Prepared {len(rows)} additional OpenUtau samples.")


if __name__ == "__main__":
    main()
