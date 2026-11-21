# GAME + RMVPE + WORLD 实验

本目录是独立于 App 的 30 秒效果实验。原唱人声只作为音高与力度
guide；输出不会模仿原歌词或原唱音色，而是让 `audio/man.wav` 按原曲
音符发声。

## 当前流程

1. 历史 30 秒实验由 GAME Small 从 `guide-70s-30s.wav` 提取离散 MIDI
   音符；整曲一键脚本现已固定切换到 `GAME-1.0-large`，不会复用 Small
   的 GAME 缓存。
2. 逐字 LRC 定义每次素材触发的边界；80 ms 内的 GAME 边界吸附到字界。
3. RMVPE 提取每个音符内部的转音、滑音和细微音高变化。
4. 同一个字内即使有多个音符，也只创建一次 WORLD 合成事件；事件内部
   连续改变 F0，不重新触发 `man.wav` 的起音。
5. 原唱分离轨的 RMS 只控制力度，最终与已分离的伴奏混合。

## 试听文件

- `outputs/mix-game-rmvpe.mp3`：主版本，GAME 音符加 RMVPE 字内转音。
- `outputs/man-game-rmvpe.mp3`：主版本的纯素材轨。
- `outputs/mix-game-only.mp3`：只保留 GAME 离散音符的对照版本。
- 对应的无损 WAV 与 `pitch-targets.csv`、`report.json` 也在
  `outputs/`。
- GAME 生成的 MIDI 位于 `work/game/guide-70s-30s.mid`。

## 本轮验证

- 30 秒片段中包含 48 个 GAME 音符、34 个逐字事件。
- 27 个靠近歌词字界的音符边界得到校正。
- RMVPE 回检主素材轨时，有声覆盖率为 100%。
- 合成音高相对目标的平均绝对误差为 0.0693 个半音；
  99.25% 的有效帧误差小于半个音。

## 本地文件

- 下载压缩包：`downloads/`，当前约 725 MiB。
- 解压后的 GAME/RMVPE 模型：`models/`，当前约 779 MiB。
- 当前一键流程的 GAME Large：
  `models/GAME-1.0-large/model.pt`，约 378 MiB、约 1 亿参数；
  Small 权重仍保留，仅供历史结果回溯。
- 项目内薄层虚拟环境：`.venv/`，约 473 MiB。它复用电脑上已有的
  Hachimi PyTorch/CUDA 环境，没有再次复制数 GB 的 PyTorch。
- Python 编译头：`python-dev/`，约 29 MiB，仅用于在项目内编译
  PyWORLD。
- pip 缓存：`pip-cache/`，约 142 MiB。
- 整个实验目录当前约 2.2 GiB。

模型来源：

- GAME: <https://github.com/openvpi/GAME>
- RMVPE: <https://github.com/Dream-High/RMVPE>
- PyWORLD: <https://pypi.org/project/pyworld/>

本实验没有修改 App 代码。`run_world_fusion.py` 是当前融合与渲染入口。
