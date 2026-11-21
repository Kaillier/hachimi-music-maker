# Local Website

启动：在项目根目录运行 `node website/serve.mjs 4175`，访问 <http://127.0.0.1:4175>。

- `/generate`（首页）：导入歌曲、查看生成记录、提取人声或使用 USTX 生成样板。
- `/arrange`：选择已生成的工程，逐句编排、试听和导出。生成成功后自动打开 `/arrange?song=<id>`；旧的 `/?song=<id>` 链接仍有效。

## 歌曲导入

「导入歌曲」和独立人声分离共用 Windows 原生 Demucs。首次运行 `setup_demucs.bat` 配置分轨环境和 HTDemucs 权重，详细步骤见项目根目录的 README。

上传歌曲后，依次通过 Demucs 分轨、LDDC 获取参考歌词、Vocal2Midi 转谱，再索引 USTX 供编排。可随歌曲提交 LRC 或 UTF-8 TXT，也可只提交歌曲；这时优先查找 `music/` 和 LDDC 保存目录里的 LRC。本地没有匹配时才按歌名、歌手、专辑和时长匹配网络歌词，不发送音频，也可在导入时取消联网。未找到可靠参考歌词或 LDDC 不可用时，Vocal2Midi 继续自动识别。

LDDC 桌面程序不必启动。首次设置网页的独立 LDDC 依赖：

```powershell
git clone --depth 1 --branch v0.9.2 https://github.com/chenmozhijin/LDDC.git backend/runtime/lddc-source
Vocal2Midi/python/python.exe -m pip install --target backend/runtime/lddc-python -r backend/runtime/lddc-source/requirements.txt socksio
```

这两个运行目录不提交到 Git，也不修改 Vocal2Midi 自带的包或 LDDC 桌面程序。网页默认让 LDDC 子进程直连，避免和桌面版遇到同样的代理问题；设置 `HACHIMI_LDDC_USE_PROXY=1` 可继承系统代理环境变量。歌词来源及查询错误记录在工程元数据和任务日志中。

编排区按原句分组显示所有现用音效。打开仍引用已退役音效的旧草稿时，对应格子会改用当前音效。选择「仅试听」后，点按音效会播放原始样本。选择「编排」后，点按音效会替换选中格并选中下一格。工程顶部的循环音效组决定「整首循环生成」和数字键所用的音效。音频工具的 USTX 样板也可以选择音效组。

在「生成工程」勾选「纯音乐」后，本机 MuScriptor 转录乐器音轨，再打开主旋律工程。初始为一个待选时间段。可以切分和调整分界，试听同一时间段的原曲和音轨，分别指定每段采用哪条音轨或留白。保存后从生成记录重新打开即可接着编辑。导出按音符起音决定它所属的时间段，保留时序、延音和和弦。

音效组定义在 `sound-packs.json`。新增音效使用 `voicebanks/selected/` 的 WAV、FRQ 和 `oto.ini`，任务运行时把所需文件复制到自己的声库目录。需要从本机素材重建时，先构建 OpenUtau 原生 worker，再运行 `Vocal2Midi/python/python.exe -X utf8 backend/pipeline/prepare_phrase_voicebank.py`。

## 当前接口

- `POST /api/projects`：歌曲文件 `song`。普通歌曲可选 `language`（默认 `zh`）、`lyrics`（LRC/TXT，1 MB 以内）、`onlineLyrics=false`（不联网找歌词）。`instrumental=true` 创建主旋律工程。
- `GET /api/project-jobs`、`GET /api/project-jobs/<id>`：持久化生成记录与阶段状态。`.../files/log` 返回完整 UTF-8 日志。
- `GET /api/projects`：只列出 `projects/v2m-*/project.json` 中已完成的 Vocal2Midi 工程。不会加载旧静态音频包。
- `GET /api/projects/<id>`：页面、发音单位、波形和源工程哈希。
- `DELETE /api/projects/<id>`：删除已完成工程的本地目录并从列表移除，保留任务日志及工程目录以外的文件。生成或渲染期间不允许删除。
- `GET /api/projects/<id>/files/<kind>` 提供原曲 WAV、人声、伴奏和源 USTX。音频支持 Range，加 `?download` 下载。
- `POST /api/preview`：完整的 `sequences` 和当前 `phraseIndex`；其余未填部分仅用循环音效提供渲染上下文，不写入用户草稿。完整 USTX 渲染后裁出当前段音频。
- `POST /api/full-preview`、`POST /api/render`：完整编排与确认状态，分别用于整首播放和导出，采用同一个 USTX 原生渲染器。
- 分段试听、整首试听和导出的渲染结果保存在本机任务目录。相同工程、音效顺序、音量和播放范围会复用已完成的结果。刷新页面或重启服务后仍能复用，文件没有自动过期时间。
- `GET /api/render/<id>`、`.../files/wav|ustx|report|log`：渲染状态与产物。
- `/api/audio-tools`：独立分轨、手动 USTX 样板及任务历史。
- `GET /api/instrumental-projects/<id>` 获取主旋律工程。该地址下的 `PATCH /selection` 保存分段音轨选择，`POST /export` 导出主旋律。

渲染请求包含 `songId`、`fingerprint`、`sequences`、`confirmed`、`backingGain`、`soundGain`。预览额外包含 `phraseIndex`。旧模式字段会被拒绝，绝不静默采用其他路线。

每个 USTX 主歌词及后续延音构成一个按钮填充单位。新工程优先按参考歌词的文本分行组织编排段，其次使用 Vocal2Midi 识别日志的标点；文本无法可靠对应时才以 12 单元分页，并标明不是歌词分句。LDDC 时间戳不参与任何对齐，网页不修改 USTX 的时序或音高。原曲/样本的 Web Audio 播放只用于监听。

## 文件

`serve.mjs` 仅开放明确列出的前端文件与本地 API，监听 `127.0.0.1`。
`project-service.mjs` 负责生成与渲染任务；`project-store.mjs` 校验工程来源与哈希；`local-process.mjs` 处理 UTF-8 子进程日志。
模型不打包到前端，音频也不复制进静态目录。`npm run build` 仅构建网页代码，页面仍需本地服务提供 API。

测试：`npm test`。真实完整歌曲和各渲染接口的检查脚本见 `scripts/`。
- 编排段标题旁的编辑按钮可修正显示歌词，或标记整段、单个发音单位保留原声。标记保存在本机草稿，可恢复，不修改源 USTX。原生渲染静音被排除的发音及延音，并在同一时间位置混入原曲，不参与音效循环。
- 「删除本段」会隐藏该段并跳过编排，不会剪短成品；可从「已删除」恢复，原有音效选择仍在。
