# Hachimi Music Maker

Hachimi 是一个本地网页音效编排工具：用户为歌曲的每个乐句选择五个音效，网页把选择提交给本机 OpenUtau 原生 worker，生成试听或完整替换版 WAV。

项目当前只维护网页工作流。

## 当前流程

```text
music/歌曲 + 逐字 LRC + audio/五个音效
        |
        +-- Demucs：分离人声与伴奏
        +-- GAME Large：提供音符开始、结束和 MIDI 骨架
        +-- 音符模式：GAME 人声、ROSVOT 人声、ROSVOT 原曲
        +-- 时序模式：拍子辅助、无拍子辅助（对每种音符模式独立生成）
        +-- LDDC LRC：提供歌词顺序、乐句结构和 GAME 音符归组
        +-- 音高模式：RMVPE 原曲、FCPE 人声、无音高（对每种音符/时序组合独立选择）
        +-- OpenUtau：使用 oto.ini、FRQ、phonemizer、WORLDLINE-R 和 convergence 渲染
        +-- 伴奏混音：输出 44.1 kHz 立体声 WAV
```

选中的音符模式负责最终 MIDI 音符的音高、开始和结束；拍子辅助只在对应变体中对齐到伴奏拍点及局部 1/16 网格，无拍子辅助保留选中检测器的原始起止时间。LDDC 字符时间戳不是最终音频切点，只用于歌词顺序、乐句结构和把连续检测音符归到同一个字。没有逐字 LRC 时，才使用明确标记的声学分段 fallback。

浏览器不合成声音，也不实现调音器；本句试听、整首试听和最终导出全部走同一个 OpenUtau 原生渲染路径。原始 WAV、FRQ、`oto.ini` 和其他音源文件不会被覆盖。

## 启动网站

在项目根目录双击：

```text
start_website.bat
```

或在 PowerShell 中运行：

```powershell
./start_website.ps1
```

网页默认监听 `127.0.0.1`，端口被占用时会自动选择后续端口。歌曲工程可以在网页顶部切换。

## 重新生成歌曲包

`music/` 中放置歌曲和匹配的 LDDC 歌词后，使用现有的 GAME/RMVPE/FCPE 环境运行：

```bash
/home/kaillier/.local/share/hachimi/ai-venv/bin/python backend/experiments/prepare_web.py --pack-all
```

生成的歌曲工程位于顶层 `projects/<歌曲ID>/`，每个工程包含原始输入、Demucs 分轨、GAME、RMVPE、FCPE 分析结果和渲染所需数据，并会同步写入 `website/assets/`。

## 验证

```powershell
cd website
npm test
npm run build
```

歌词分组回归测试位于 `backend/experiments/test_lyric_segmentation.py`。OpenUtau 原生 worker 位于 `backend/runtime/openutau-native/`，其构建产物由网页运行时直接调用。

## 当前目录

```text
website/                                      网页源码、测试和歌曲资源
backend/experiments/prepare_web.py             歌曲分析与网页资源打包
backend/experiments/test_lyric_segmentation.py 歌词分组回归测试
backend/runtime/game-rmvpe-world       GAME/RMVPE 工具、模型和环境
backend/runtime/openutau-native               本地 OpenUtau 原生 worker
backend/runtime/openutau-source               OpenUtau 源码和引擎资源
projects/<歌曲ID>/                             独立歌曲工程和上传内容
audio/                                         原始五个音效及其音源元数据
music/                                         原始歌曲和歌词
哈基米音源/                                    原始音源资料和配置
```

所有音频处理和网站测试默认在本地进行，不上传歌曲、音源或网站。
