# Hachimi Local Studio

本地歌曲改编工具。导入歌曲后通过 Demucs 分轨和 Vocal2Midi 转谱，编排完成后用 OpenUtau 渲染。

## 使用

首次配置分轨时，安装 64 位 Python 3.10–3.14，然后双击 `setup_demucs.bat`。它会安装独立的 Windows Demucs 环境并下载 HTDemucs 权重，默认使用 CPU。配有支持 CUDA 的 NVIDIA 显卡时，可以运行 `setup_demucs.bat -UseCuda` 安装 CUDA 环境。

模型权重可以跟项目一起复制到另一台电脑。将已配置的 `backend/runtime/demucs/huggingface` 目录放到项目内相同位置，再运行 `setup_demucs.bat`。脚本会复用校验通过的权重，并在该电脑上创建 Python 环境。

配置完成后运行 `start_website.bat`，也可以在项目根目录执行下面的命令。

```powershell
node website/serve.mjs 4175
```

打开 <http://127.0.0.1:4175>，选择“导入歌曲”，上传音频并选择语言。本机完成分轨、Vocal2Midi 转写和 USTX 索引后，自动打开新工程。无需逐字时间戳歌词。

- “USTX 工程”下载源曲谱，“纯人声”打开分离出的人声。
- 填满当前段的音效后即可确认并进入下一段，也可以先点“改编试听”。全部确认后可以整首试听、导出 WAV。
- 在工程顶部选择“循环音效组”，点击“整首循环生成”，用所选音效组替换整首编排并导出 WAV。
- “导入歌曲”窗口保留生成记录与完整任务日志；刷新网页不会丢失后端任务。
- “音频工具”保留独立人声分离和手动 USTX 样板生成。
- 纯音乐在「生成工程」里勾选「纯音乐」。生成后在主旋律工程里试听原曲和各音轨，按时间切分并指定每段的主旋律或留白。

所有处理均在本机进行。这里的“上传”仅发送到 `127.0.0.1` 本地服务，不上传到外部平台。

## 歌曲工程

调用已安装的 Vocal2Midi 官方命令行，输入 Demucs 分离的人声，启用 USTX 和音高曲线输出。网页不再运行自制的字切分、拍子吸附或音高处理。

编排单位直接读取 USTX：一个主歌词音符及其延音属于一个单位，每 12 个单位分页。分页不会修改谱面。原工程的音符、时序、速度、PITD 曲线用于全部试听和导出。OpenUtau 原生校验可能处理 `snap_first` 控制点，处理次数会写入报告。

只在主音符上替换五个音效别名，延音保留归属。遇到休止后的延音，使用同一个音效重新起音，不延长前音符、不改休止、不推进循环。

渲染使用原始 `audio/` 音源及 `oto.ini`、FRQ、声库元数据的任务副本，由 OpenUtau WORLDLINE-R 合成后与伴奏混合。没有五套音轨剪接，也没有浏览器合成的备用路线。

## 目录

```text
audio/                         五个原始音效及音源配置，禁止覆盖
music/                         原始歌曲、歌词
Vocal2Midi/                    已安装的程序、Python、模型与用户导出工程
backend/pipeline/              分轨、USTX 索引和渲染薄层
backend/runtime/demucs/        Windows 分轨环境与模型缓存
backend/runtime/openutau-native/  OpenUtau 本地桥接
backend/runtime/openutau-source/  OpenUtau 依赖
backend/runtime/web-server/    任务、日志和渲染缓存
projects/v2m-<id>/             每首新工程的输入、分轨、USTX、清单
website/                      网页、本地服务与测试
legacy-archive/               旧方案源码和说明封存，不包含旧模型或运行环境
```

旧方案模型、环境、生成音轨与分析包已经移出使用路径并清理。原始音源、歌曲、用户 USTX、Demucs 和 Vocal2Midi 所需模型保留。

## 环境与验证

### 从源码配置

源码仓库提供网页和原生桥接。运行时请在本机准备以下内容。

1. 将 Vocal2Midi 的 Windows 便携环境放在 `Vocal2Midi/`。将项目需要的原始声库放在 `audio/`，额外音效声库放在 `voicebanks/selected/`。保留各声库的 WAV、oto.ini 及已有的 FRQ 等文件。
2. 安装 .NET 8 SDK。获取 OpenUtau 源码后构建原生桥接。

   ```powershell
   git clone https://github.com/openutau/OpenUtau.git backend/runtime/openutau-source
   git -C backend/runtime/openutau-source checkout a60ca5830b9064556157245d4bf8f5920d93e5f8
   dotnet build backend/runtime/openutau-native/Hachimi.OpenUtau.Native.csproj -c Release
   ```

3. 运行 `setup_demucs.bat` 配置本地分轨，再用 `start_website.bat` 启动。

网站依赖 Node.js、Vocal2Midi 的 Windows 便携环境、Windows .NET 8 / WORLDLINE-R，以及已配置的 Windows Demucs。中文转写使用 Vocal2Midi 当前保存的 Qwen/TiFA/GAME/RMVPE 设置，需要 DirectML 可用。其他语言是否可用取决于已安装的 Vocal2Midi 语言依赖。

分轨默认用 `backend/runtime/demucs/venv/Scripts/python.exe` 和 `backend/runtime/demucs/huggingface`，可通过 `HACHIMI_DEMUCS_PYTHON` 和 `HACHIMI_DEMUCS_CACHE` 指定位置。模型下载在首次配置时完成，歌曲分轨时读取本机缓存。

纯音乐工程使用 Windows 上的 MuScriptor。完成 Demucs 环境配置后运行 `setup_muscriptor.bat`，将本机已有的 MuScriptor `model.safetensors` 和它的 `config.json` 放在项目根目录。可用 `HACHIMI_MUSCRIPTOR_MODEL` 指定其他位置的模型权重。

每段可选一条乐器音轨或留白。导出按原曲时间取所选音轨中在该段起音的音符。跨过分界的延音保留原长度，和弦也会保留。

```powershell
node --test website/tests/*.test.mjs
Vocal2Midi/python/python.exe -X utf8 -m unittest discover -s backend/pipeline -p "test_*.py"
dotnet build backend/runtime/openutau-native/Hachimi.OpenUtau.Native.csproj -c Release --no-restore
npm --prefix website run build
```

真实歌曲验证：`node website/scripts/smoke-local.mjs`；真实试听/导出验证：`node website/scripts/verify-local.mjs`。这些检查会在本地创建工程和音频。
