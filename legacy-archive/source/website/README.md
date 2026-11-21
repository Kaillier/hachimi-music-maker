# Hachimi 音效编排台

独立网页。当前网站资源由 `projects/` 中的歌曲工程生成；已有歌曲也可以通过网页上传歌曲和歌词，自动创建新的独立工程。

## 使用

在项目根目录双击 `start_website.bat`。需要已安装的 Node.js；服务器只监听本机
`127.0.0.1`，默认端口 4174，占用时自动选择后续端口。

1. 在顶部歌曲选择器切换歌曲；每首歌拥有独立的歌词、乐句、草稿和分析工程。
2. 播放原句，每个候选发音单元对应一个音效格。
3. 依次按“哈、基、米、曼、波”填入序列；键盘 1–5 也可输入。
4. 可撤销、删除选中音效、清空本句，或把已输入的模式循环填满。
5. 点击本句试听，等待 OpenUtau 原生渲染完成后确认，自动进入下一句。
6. 全部确认后，可以整首试听；导出同样由本机 OpenUtau worker 生成 44.1 kHz、立体声 WAV。
7. 在“音符模式”中切换 `GAME · 人声`、`ROSVOT · 人声` 或 `ROSVOT · 原曲`；切换后会载入对应检测器的音符边界。
8. 在“时序模式”中切换 `拍子辅助` 或 `无拍子辅助`；它对当前音符模式独立生效。
9. 在“音高模式”中切换 `RMVPE 原曲`、`FCPE 人声` 或 `无音高`；它只改变 OpenUtau 的连续音高输入，不改变音符和时序。
10. 点击“导入歌曲”上传歌曲和歌词，等待本机分析完成后即可切换到新工程。
11. 点击“哈基米曼波”可以用“哈、基、米、曼、波”循环填充整首歌，并直接提交 OpenUtau 原生生成。

草稿保存在当前浏览器和当前网站地址下。网页不上传用户的编排序列。

## 音频处理

### 本地音频工具

顶部“音频工具”提供两个独立入口，不需要先创建完整歌曲分析工程：

- “提取人声”：上传歌曲，只运行 Demucs；可试听、下载纯人声和伴奏。同一歌曲可以按文件 SHA-256 复用本地已有分轨。
- “USTX 样板”：上传 Vocal2Midi 原始导出的 USTX，选择对应的已分离伴奏、现有歌曲伴奏，或另传伴奏文件；使用原始五个音效循环生成样板、纯人声及替换后的 USTX。

USTX 模式保留上传工程的音符、时序、速度和 PITD 曲线，不重新扒谱、分字或提取音高；延音不推进循环。OpenUtau 按原工程的 `snap_first` 设置处理音符衔接。当前原生导入器支持 USTX 0.7，新版编辑器另存的 0.9 工程会明确报错，不自动降级。

带空隙的延音会在原始时间重新触发所属发音单位的同一个音效，不推进循环，也不拉长前一个音符填补空隙；连续延音保持原样。没有可归属发音的延音或重叠延音会明确报错，不自动修改时间。生成记录会列出重新触发的位置和空隙，后台日志统一使用 UTF-8。

任务状态和结果保存在 `backend/runtime/web-server/audio-tools/`，刷新页面后仍可从最近任务中查看。歌曲上传保存在 `projects/upload-<uuid>/input/`。只传入本机服务，不向外部服务器上传。

歌曲分离使用现有 WSL Demucs 环境；USTX 处理默认复用本地 `Vocal2Midi/python/python.exe` 和 `Vocal2Midi/ffmpeg.exe`，可用 `HACHIMI_AUDIO_PYTHON` 指定另一个已安装 PyYAML、soundfile 的 Windows Python 环境。

管线使用 Demucs 分离伴奏与人声，并分别准备 GAME 人声、ROSVOT 人声和 ROSVOT 原曲三套音符事件；每套事件都有“拍子辅助”和“无拍子辅助”两个时序变体。LDDC 逐字歌词只提供文字顺序、乐句结构，以及把连续检测音符归到同一个汉字的依据，不会直接决定最终音频切点。网站分析结果写入对应的 OpenUtau USTX 音符、歌词和未经额外平滑、限幅或缩放的所选模型绝对音高信息。

FCPE 使用官方 `torchfcpe` bundled 模型分析 Demucs 人声，RMVPE 分析原曲；两条音高轨只保存 F0 数据，
`无音高` 不写入音高 CSV，实际发声仍由同一个 OpenUtau 原生 worker 完成。

本句试听、整首试听和最终导出全部提交给同一个本机 OpenUtau 原生 worker。worker 使用
本地音源的 WAV、`oto.ini`、FRQ 和其他音源元数据，通过 OpenUtau phonemizer、WORLDLINE-R
和 convergence 生成声音，再与分离后的伴奏混音。网页端不再生成预渲染音效库，也不实现
自己的调音器或浏览器混音器。原始音源文件不会被覆盖。

没有逐字 LDDC 时才使用 GAME 和能量边界的声学 fallback。最终导出需要本机已构建
`backend/runtime/openutau-native`。

重新生成当前歌曲的分析和网站资源：

```bash
/home/kaillier/.local/share/hachimi/ai-venv/bin/python backend/experiments/prepare_web.py
```

当 `projects` 中有多首已完成分析的歌曲时，重新生成歌曲目录：

```bash
/home/kaillier/.local/share/hachimi/ai-venv/bin/python backend/experiments/prepare_web.py --pack-all
```

每首工程位于 `projects/<歌曲ID>/`，其中的 `input/` 保存上传的原始歌曲和歌词，其他目录保存分轨、GAME、ROSVOT、RMVPE、FCPE、两条音高轨、六套音符/时序工程、拍子网格和 `analysis.json`。网页只把可浏览资源复制到 `website/assets/`；原始工程不会被覆盖。

首次构建原生 worker：

```powershell
dotnet build backend/runtime/openutau-native/Hachimi.OpenUtau.Native.csproj --configuration Release
```

## 开发与验证

```text
cd website
npm install
npm test
npm run build
node serve.mjs
```

测试覆盖歌曲工程、草稿编辑、原生本句试听请求、整首试听请求和最终导出请求。
浏览器自动化测试不等同于真人听音验收。
