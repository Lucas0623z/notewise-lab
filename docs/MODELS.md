# 模型环境与真实音频链路

## 当前实现

- `demucs_basic_pitch`：Demucs 分离真实音频，默认对有音高的轨道运行 Basic Pitch；可选钢琴专用模型和镲片击打点提取，见下表。
- `transcribe_only`：保留原始音频并直接转录。默认 Basic Pitch，适合单件乐器录音且不假定乐器类型；已知单钢琴录音可选 `piano_highres`，输出钢琴轨。
- `htdemucs`：人声、鼓、贝斯、其他 4 轨，**没有独立钢琴轨**，钢琴通常进入 `other`。`htdemucs_6s` 另含实验性钢琴、吉他；没有独立弦乐输出。
- 4/6 轨是模型的固定输出类别，不是识别到了 4/6 种乐器；即使原音没有人声或贝斯，模型也会输出对应文件，文件可能只有极弱残留。镲片属于 `drums` 打击乐输出。
- 鼓轨保留真实音频，默认 `transcriptionStatus=unsupported`、空音符。确认素材中的打击乐是镲片时，可显式开启 `cymbal_onsets`。`other` 明确标为混合轨。
- 每条音轨返回可试听 WAV、实际音符起止秒数、音高和力度。音色是试听默认值，不是 Basic Pitch 识别的乐器类别。
- 输入音频最长 30 分钟；解码前尽可能检查，FFmpeg 解码也设有限界并拒绝超长结果，不静默截断为成功任务。
- BPM 取用户输入或默认 120，并明确标注未自动检测。此阶段不做节拍量化、弯音编辑和乐谱排版。

### v0.1.3 上传选项

| 选项 | 默认值 | 行为与限制 |
| --- | --- | --- |
| `transcriptionModel` | `basic_pitch` | 可选 `piano_highres`；分轨模式必须搭配 `htdemucs_6s`，仅钢琴轨用专用模型，其他有音高轨仍用 Basic Pitch；直接转录适用于已知单钢琴录音 |
| `drumTranscription` | `none` | 可选 `cymbal_onsets`，只允许分轨模式；不适用于直接转录 |

无效组合由 API 拒绝。显式选择的钢琴专用模型缺依赖、缺权重或运行失败时会报错，不静默改用 Basic Pitch。旧调用省略新字段时仍采用 Basic Pitch，且不生成鼓 MIDI。

## 可选钢琴专用转录：`piano_highres`

对已知钢琴录音或分离后的钢琴轨，可使用作者的 [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) 模型。它专门预测 88 键钢琴的起音、止音和力度；这不是通过删除短音符来整理 Basic Pitch 的结果。通用转录仍使用 Basic Pitch，钢琴专用模型不适合作为人声、吉他或完整多乐器混音的通用识别器。

后端适配器位于 `stemwork/piano_transcription.py`，仅在模型子进程加载依赖。使用官方模型结构与默认参数：16 kHz 单声道、100 帧/秒、10 秒分段，onset/offset/frame/pedal-offset 阈值分别为 0.3/0.3/0.1/0.2。没有最短音符时长过滤、同音合并或节拍量化；只把输出限制在实际输入时长内。调用接口为：

```powershell
python -m stemwork.piano_transcription AUDIO.wav RESULT.json CHECKPOINT.pth auto
```

输出沿用 `[起始秒, 结束秒, MIDI音高, 力度/127]` 的事件列表。**当前编辑器只接收音符，尚不支持模型预测的踏板事件（CC64）**，因此不能承诺完整还原钢琴踏板与延音表现；官方模型生成的独立 MIDI 可含踏板，但它与当前应用导出的音符 MIDI 范围不同。

### 安装与权重

推荐单独使用 Python 3.11 环境，避免改变已有 Demucs/Basic Pitch 依赖。以下是 Windows / RTX 5090 示例，CPU 机器应换用兼容的 PyTorch CPU 发行版：

```powershell
py -3.11 -m venv .venv-piano
& ./.venv-piano/Scripts/python.exe -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128
& ./.venv-piano/Scripts/python.exe -m pip install -r backend/requirements-piano.txt
& ./.venv-piano/Scripts/python.exe -m pip install -e ./backend
```

从 [作者公开的 Zenodo 4034264](https://zenodo.org/records/4034264) 下载 `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth`，放入模型缓存的 `piano` 子目录，或设置 `STEMWORK_PIANO_CHECKPOINT` 指向它。未配置时，适配器查找 `STEMWORK_MODEL_CACHE/piano/`，再使用项目 `data/model-cache/piano/` 默认目录；不会写入用户主目录，也不会在每个识别任务中自动下载权重。

| 校验项 | 官方文件与本轮下载结果 |
| --- | --- |
| 字节数 | 171,966,578（约 164 MiB） |
| Zenodo 公布的 MD5 | `22b961b77c1878239fec963362097045` |
| 本轮匹配 MD5 后计算的 SHA-256 | `c3fa9730725bf4a762f1c14bc80cd5986eacda01b026f5a4a2525cd607876141` |

适配器先验证文件大小和 SHA-256，再显式使用 `torch.load(..., weights_only=True)` 及严格模型参数加载，不回退到不安全的 pickle 加载，也不全局改写 PyTorch。缺权重、校验失败或依赖不兼容会明确报错。

桌面配置中将 `pianoPython` 指向该隔离环境，将 `pianoCheckpoint` 指向权重；手动启动 worker 时分别使用 `STEMWORK_PIANO_PYTHON` 和 `STEMWORK_PIANO_CHECKPOINT`。完整配置见 [桌面说明](DESKTOP.md)。未设置专用解释器时会使用模型解释器，但该环境仍须安装钢琴依赖。

**许可证与署名：** ByteDance 训练仓库声明 Apache-2.0；作者的 [piano-transcription-inference 0.0.6](https://pypi.org/project/piano-transcription-inference/0.0.6/) 发布元数据为 MIT；[Zenodo 权重记录](https://zenodo.org/records/4034264) 为 **CC BY 4.0**。使用或再分发权重时保留署名、来源和许可说明，注明适配器改动。署名：Qiuqiang Kong、Bochen Li、Xuchen Song、Yuan Wan、Yuxuan Wang，*High-resolution Piano Transcription with Pedals by Regressing Onsets and Offsets Times*，[论文](https://arxiv.org/abs/2010.01815)。本项目适配了安全加载、缓存路径和事件输出；没有修改模型权重。上游仓库已归档，文档原始环境为 Python 3.7 / PyTorch 1.4，不能假定所有新环境兼容。

### v0.1.3 真实钢琴对比

在 Windows、RTX 5090、Python 3.11.16、PyTorch 2.8.0+cu128 上，使用隔离环境中的 `piano-transcription-inference==0.0.6`、`torchlibrosa==0.1.0`、librosa 0.11.0 实际运行。权重与官方 MD5 一致，`weights_only=True` 加载成功。输入为「001 旋律 · 六轨修正版」中的同一条 25.34 秒钢琴 WAV，另对原始混音作独立对比；没有覆盖旧工程。

| 描述指标 | Basic Pitch 钢琴轨 | 钢琴专用模型，同一钢琴轨 | 钢琴专用模型，原始混音 |
| --- | ---: | ---: | ---: |
| 预测音符数 | 102 | 67 | 69 |
| 音符时长中位数 | 0.587 秒 | 1.213 秒 | 1.210 秒 |
| 短于 300 ms | 21 | 2 | 2 |
| 短于 200 ms | 9 | 2 | 2 |
| 同音高 500 ms 内再次起音 | 4 对 | 0 对 | 0 对 |

独立钢琴轨首次推理约 17.87 秒，原始混音在已加载模型上约 3.14 秒，模型初始化约 9.33 秒；首次推理存在预热开销，不能把这两次时间当作输入类型的性能差异。钢琴轨的官方独立 MIDI 含 67 个音符和 11 个踏板区间；原始混音为 69 个音符和 7 个踏板区间。

这份样本中，专用模型的短碎片和快速同音重触发更少；**没有人工标注的标准答案，尚未证实准确率提升**。更少、更长的音符也可能意味着漏音或延音过长；某些小间隔是正常重新按键，不能一律合并。需要结合原音试听并逐音校对，再决定是否采用候选结果。

实际对比图、完整事件和官方 MIDI 保存在工作区 `work/piano-model-evaluation/`：`piano-roll-comparison.png`、`evaluation-report.json`、`piano_stem-highres.mid`、`original_mix-highres.mid`。下载来源与哈希见 `download-manifest.json`；本机隔离解释器为该目录的 `env/Scripts/python.exe`，借用现有模型环境的兼容基础库，未升级原环境。适配器回归检查覆盖权重校验、安全加载、尾部填充边界、短音符保留和 Windows 日志编码；这些测试不测识别准确率，完整回归结果见 [STATUS.md](STATUS.md)。

## 可选镲片击打点：`cymbal_onsets`

这是一种**瞬态起音提取方法，不是多鼓组分类模型**。仅在用户确认鼓轨主要为镲片时显式启用；从 Demucs 的真实鼓轨提取击打点，原 WAV 保留。实现位于 `stemwork/cymbal_onsets.py`，使用 PCM 短窗口能量包络、噪声门限和静音复位，没有新增模型权重。镲片尾音可能掩盖相邻击打，其他乐器串音也可能触发，因此不适合承诺通用鼓转录准确率。

每个候选击打默认生成 GM 音高 49、约 0.1 秒的 MIDI 触发。长度表示触发，不代表镲片的声学尾音；GM 49 只是试听默认值，不是识别出的镲片种类。编辑器可将整轨改为 GM 42、46、49 或 51，并通过撤销恢复。试听为简单合成示意，导出后可使用外部鼓音源。

鼓轨 MIDI 使用第 10 通道（程序中的 channel 9）。导出保留已检测出的同音高相邻击打；若触发时长重叠，截短前一触发而不合并两次攻击。有音高轨仍合并同音高重叠音符用于试听/导出，二者均不改写工程原始音符。MIDI 保留攻击不代表起音提取能检测出所有密集击打。

### v0.1.3 真实 API 全流程候选

工程「001 旋律 · 钢琴专用与镲片」（`7460312564f441b09e8c11bd829698e2`）完成真实上传、六轨分离、钢琴专用转录与镲片起音提取，时长 **25.3398 秒**：

- 钢琴轨为 **67 个预测音符**，`transcriptionEngine=piano_highres`。
- 鼓轨为 **4 个击打点**，约在 **0.379 / 1.576 / 2.779 / 3.976 秒**，`transcriptionEngine=cymbal_onsets`。
- 人声、贝斯、其他、吉他四轨均为近静音残留，保留音频并跳过自动转录。
- 6 条 WAV 均可读取；导出 MIDI 回读得到 **71 个 note-on**，鼓通道正确；6 个原工程 JSON 逐份比对未改变。

证据位于工作区 `work/piano-cymbal-validation/result.json`。这是可供试听校对的新候选，**音符更少不等于准确率已提升**；没有逐音标准答案，不能给出准确率保证。踏板 CC64 仍未纳入应用输出。

## 依赖选择

推荐把 API 与模型环境隔离，使用 **Python 3.11** 建立模型环境。项目 `backend/requirements-models.txt` 只安装第一层：Basic Pitch 转录与解码；PyTorch/Demucs 作为第二层按硬件单独安装。它是一组待目标机器实际验证的安装约束，不是跨平台锁文件。

| 组件 | 本项目选择 | 原因 |
| --- | --- | --- |
| Demucs | 4.1.0 | 作者后续发行版改用 sphn 处理音频，推理不再受旧 torchaudio 版本约束 |
| PyTorch | 2.8.0 | RTX 5090 使用 CUDA 12.8 发行轮子；PyTorch 从 2.7 开始提供 Blackwell 支持 |
| Basic Pitch | 0.4.0 | 官方发布版本，使用安装包附带的 ONNX 权重 |
| ONNX Runtime | CPU 版，1.20 至 2.0 之前 | Basic Pitch 轻量转录，避免 Windows TensorFlow/CUDA 版本耦合 |
| NumPy | 1.26 至 2.0 之前 | 兼容 Basic Pitch 依赖的 TensorFlow 2.15 系列 |

**Python 3.12 注意点：** Basic Pitch 0.4.0 的安装元数据会在 Python ≥3.11 上要求 `tensorflow>=2.4.1,<2.15.1`，该范围没有标准 Python 3.12 轮子。不要把它直接混装到现有 3.12 API 环境。Python 3.11 常规安装会同时安装 TensorFlow，但本适配器显式选用 ONNX 模型并关闭其 GPU 可见性。另一种较轻的 Windows 环境是 Python 3.10，此时 Basic Pitch 官方依赖默认是 ONNX Runtime；本轮以 3.11 为基线。

### Windows / RTX 5090 示例

在项目根目录的 PowerShell 中执行，Python 3.11 须已安装：

```powershell
py -3.11 -m venv .venv-models
& ./.venv-models/Scripts/python.exe -m pip install --upgrade pip
& ./.venv-models/Scripts/python.exe -m pip install -r backend/requirements-models.txt
$env:STEMWORK_MODEL_PYTHON = (Resolve-Path ./.venv-models/Scripts/python.exe).Path
$env:STEMWORK_MODEL_CACHE = Join-Path (Get-Location) 'data/model-cache'
```

先用 `transcribe_only` 验证第一层，随后按需安装第二层：

```powershell
& ./.venv-models/Scripts/python.exe -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128
& ./.venv-models/Scripts/python.exe -m pip install demucs==4.1.0
```

CPU 环境使用 PyTorch 官方 CPU 轮子索引替代 `cu128`。CUDA 驱动是否适配必须在目标机器确认；安装包能导入不等于 GPU 推理已经通过。

API/队列进程若使用独立轻量环境，为解码 MP3/M4A 等格式提供系统 FFmpeg，或在该环境安装 `imageio-ffmpeg`；WAV/FLAC 优先用 `soundfile`。也可设置 `STEMWORK_FFMPEG` 为 FFmpeg 可执行文件绝对路径。本适配器先输出可试听 PCM WAV；无损输入保持采样率，由模型按需重采样；其他格式经 FFmpeg 转成 44.1 kHz 双声道 WAV。

## 运行约定

- 模型依赖均延迟加载。导入 `stemwork.pipeline` 不导入 PyTorch、Basic Pitch、NumPy 等包。
- `STEMWORK_MODEL_PYTHON` 是服务端配置，不来自上传请求。未设置时使用 worker 自身的 Python。
- `device=auto/cpu/cuda` 决定 Demucs 和钢琴专用模型的设备；Basic Pitch 使用 CPU ONNX 转录。
- 模型、Hugging Face、Numba 缓存默认保存在项目 `data/model-cache`；可用 `STEMWORK_MODEL_CACHE` 改为指定本地目录。Basic Pitch 权重随 Python 包安装。
- 每次任务在输出目录创建唯一 `run-*` 子目录，避免重试读到旧分轨。日志和中间音符 JSON 留在该目录供排查。
- 首次 Demucs 运行按上游逻辑下载权重；4.1.0 的 `htdemucs` 已验证从作者的 Hugging Face 仓库 `adefossez/HTDemucs` 下载并缓存 Safetensors。本模块不会在导入、启动 API 或单元测试时下载大模型。
- Demucs、Basic Pitch 和钢琴专用转录在子进程运行。取消时终止并回收当前子进程。轨道间重载模型会产生额外开销，后续可改为常驻推理进程。
- 长阶段进度为 `null`；转录阶段数字表示已处理音轨占比，不能当作预计剩余时间。
- 单轨失败保留音频并返回 `failed`；全部有音高轨道失败时抛出 `PipelineError`，避免误报完成；取消抛出 `PipelineCancelled`。

## 近静音残留检查（自 v0.1.2）

在未归一化的 PCM 上测量整轨 RMS、峰值和最响的 100 ms 窗口，避免把分离残留送进音高模型后产生虚假音符。以下四项**全部成立**，或音频为全零时，标记 `lowSignal=true`：

| 测量项 | 近静音条件 |
| --- | --- |
| 整轨 RMS | ≤ -75 dBFS |
| 相对原始音频的 RMS | ≤ -40 dB |
| 峰值 | ≤ -45 dBFS |
| 最响 100 ms 窗口 RMS | ≤ -60 dBFS |

有音高轨满足条件时保留原分轨音频、跳过自动转录并给出说明；仍可试听或手动添加音符。短促镲片或零星音符不会仅因全段平均电平低而被跳过。鼓音频始终保留；默认 `drumTranscription=none` 时标为 `unsupported`、无自动音符，显式开启镲片提取后的行为见上文。这是保守的残留检查，**低电平不证明对应乐器不存在**，也不能过滤所有模型误检。旧工程不会因升级自动删除已有音符，需要新建识别任务才能使用新检查。

`Track.analysis` 是可选字段，旧工程可没有它；新增结果包含 `rmsDbfs`、`peakDbfs`、`relativeRmsDb`、`lowSignal`、`autoTranscriptionSkipped`。数值是电平测量，不是乐器置信度。幅度转 dB 的下限为 -240 dB，避免全零音频产生 JSON 不支持的无穷值；100 ms 最大 RMS 用于内部判定。

## 验证范围

适配层回归检查覆盖有效/空音频时长、取消进程回收、失败日志、依赖提示、默认鼓轨空音符、模型失败传播、专用路由不静默回退、新选项校验与保存、相邻鼓点 MIDI 攻击保留等风险。模型在路由单元测试中被替换，因此这些测试不证明识别准确率；当前总数和运行结果见 [STATUS.md](STATUS.md)。

实际验收必须另行执行：先用已知音符的短单乐器 WAV 跑 `transcribe_only`；再用短混合样本跑 Demucs，检查所有轨道可读取、确有模型音符输出、导出 MIDI 的时间与真实音频一致；记录硬件、模型版本、输入时长、运行耗时和失败案例。无可靠音符的轨道允许为空，不能以填充音符作为成功条件。真实歌曲的音质对比独立于“程序能运行”的验收。

## 上游与许可证

- [Demucs 作者仓库](https://github.com/adefossez/demucs)、[4.1.0 发布页](https://pypi.org/project/demucs/4.1.0/)：MIT。Meta 旧仓库已归档，应优先看作者当前仓库。
- [Basic Pitch](https://github.com/spotify/basic-pitch)、[依赖定义](https://github.com/spotify/basic-pitch/blob/main/pyproject.toml)：Apache-2.0。官方提示一次一种乐器的转录效果最好。
- [PyTorch 2.7 / Blackwell 说明](https://pytorch.org/blog/pytorch-2-7/)、[官方安装选择器](https://pytorch.org/get-started/locally/)。

保留第三方许可证及版权声明。这里只复用开源模型，没有使用灵谱私有接口或声称采用了它的内部模型。
## 已验证的兼容补充

2026-09-15 的实际 Basic Pitch 验证使用 Python 3.11.16、ONNX Runtime 1.30.0、soundfile 0.14.0。resampy 仍导入 `pkg_resources`，因此 `requirements-models.txt` 明确限制 `setuptools>=75,<81`；已用 80.10.2 验证。Basic Pitch 单乐器合成音频运行记录在 `examples/basic-pitch-smoke.json`。

### 历史验证：v0.1.1 完整四轨真实模型验收（2026-09-15）

已实际执行 `run_pipeline` 的 `demucs_basic_pitch / htdemucs / auto`，没有替换或模拟模型。输入是现场合成的 8 秒原创混合音频，包含低音、旋律、谐波哼声与鼓击，不含他人歌曲。输入为 44.1 kHz 双声道 PCM WAV，SHA-256：`8158b7a8e0a45ea24e0229c78eee73bf619fe89905676af58963622460332ce7`。

- 硬件：NVIDIA GeForce RTX 5090。`auto` 在该环境选择 CUDA；Basic Pitch 明确使用 CPU ONNX。
- 环境：Python 3.11.16、PyTorch 2.8.0+cu128、Demucs 4.1.0、sphn 0.2.1、Basic Pitch 0.4.0、ONNX Runtime 1.30.0、NumPy 1.26.4、soundfile 0.14.0。
- 权重：`adefossez/HTDemucs`，快照 `cbc8a9b1a87023b7fd74e7b3412e6321c0eab003`，`955717e8.safetensors`（84,025,440 字节）。首次运行自动下载成功，后续复用本地缓存。
- 首次全链路耗时 **31.824 秒**；其中环境检查与解码约 0.105 秒，下载与 Demucs 分离约 19.951 秒，三条有音高轨的 Basic Pitch 转录约 11.768 秒。此数据是一次 8 秒输入的观察值，不能推算所有歌曲或硬件的速度。

| 输出轨 | 音频校验 | 音符数 | 转录状态 |
| --- | --- | ---: | --- |
| 人声 | 8 秒、44.1 kHz、双声道、352,800 帧 | 29 | `completed` |
| 鼓 | 同上 | 0 | `unsupported` |
| 贝斯 | 同上 | 7 | `completed` |
| 其他（混合轨） | 同上 | 19 | `completed` |

四条 WAV 均由模型实际生成、可解码，采样值有限且不是全零；输出时间与输入一致。所有音符起止时间位于 0 至 8 秒内，音高和力度合法。实际导出并重新读取的 MIDI 为 Type 1、5 个轨道（含速度/拍号轨）、55 个 note-on、661 字节，最后事件时间为 7.8875 秒；note-on/off 完整配对、同音高没有重叠悬挂音符，鼓通道没有伪造音符。

本工作区保留可复跑脚本与证据于 `work/smoke-demucs/`：`run.py`、原始混合 WAV、`source-score.json`、`report.json`、`pipeline-result.json`、`recognized-four-stems.mid`，以及 `pipeline-output/run-*/` 下的真实分轨和模型日志。模型环境使用 `work/venv-models`，缓存位于 `work/model-cache`。从工作区根目录运行 `work/venv-models/Scripts/python.exe work/smoke-demucs/run.py` 可重复验证链路；Demucs 的随机移位使音符数量可能略有变化。

**准确率边界：** 该合成素材没有真人歌声，人声分离输出很弱（RMS 约 0.000847，峰值约 0.002991），Basic Pitch 仍预测了 29 个音符。这是需要人工试听校对的模型误检风险，不能把完成状态或音符数量解释为准确率。此次历史验证证明模型下载、GPU 分离、ONNX 转录、音轨数据契约及 MIDI 导出链路确实运行，没有证明真实歌曲的分离/转录品质。保守近静音门限也不会覆盖所有此类误检。

### 历史验证：v0.1.2 独立诊断，25.34 秒钢琴与镲片样本

用户提供的 `001 旋律` 两次上传经文件哈希确认是相同音频；用户说明素材只有钢琴和镲片。对原文件和已有四轨结果做只读测量，并在独立副本上真实运行 `htdemucs_6s / auto`，没有覆盖原工程。下面数值取第一次四轨工程及当时的六轨副本；RMS 按所有声道采样能量计算，能量比例不代表乐器识别准确率。

| 输出 | RMS（dBFS） | 相对原音能量 | 观察 |
| --- | ---: | ---: | --- |
| 原音 | -32.74 | 100% | 25.34 秒 |
| 四轨：其他 | -32.79 | 98.69% | 主要旋律留在混合轨，四轨没有钢琴输出 |
| 四轨：人声 | -91.34 | 0.000138% | 极弱残留，旧版本仍生成 43 个音符 |
| 四轨：贝斯 | -91.55 | 0.000132% | 极弱残留，旧版本仍生成 34 个音符 |
| 六轨：钢琴 | -32.92 | 95.99% | 主要信号进入钢琴轨 |
| 六轨：鼓 | -51.45 | 1.35% | 保留开头短促打击信号，峰值 -14.99 dBFS |

鼓轨有效信号集中在约 0.3–0.6、1.5–1.7、2.7–2.9、3.9–4.1 秒；100 ms 窗口中只有约 3.54% 高于 -60 dBFS，因此整段平均电平低不等于鼓轨无效。六轨的其他、人声、贝斯、吉他输出均为极弱信号。

独立六轨推理耗时 **18.04 秒**；随后仅对钢琴轨运行真实 Basic Pitch，耗时 **4.16 秒**，输出 99 个音符，并成功导出、回读 99 个 note-on 的 Type 1 MIDI。音符尚未逐个人工校对，不能将数量当作准确率。这份样本支持使用六轨分离钢琴与打击乐，不构成六轨对所有音乐更好的保证。

工作区证据位于 `work/user-audio-diagnosis/`：`four-stem-report.json`、`six-stem-report.json`、`details-report.json`，以及独立六轨 WAV 和 `six-stem/piano-diagnostic.mid`。这些是本地诊断副本，与下方 v0.1.2 工程分开记录。

### 历史验证：v0.1.2 API 与 worker 全流程重跑

已新建工程「001 旋律 · 六轨修正版」（`a1d909f68e874c86a6fc12fe9e6284da`），真实上传、六轨分离及 Basic Pitch 处理完成，时长 25.3398 秒。钢琴轨输出 102 个预测音符；鼓轨保留音频、0 音符并标为 `unsupported`。人声、贝斯、其他、吉他四轨均满足近静音条件，标记 `lowSignal` 和 `autoTranscriptionSkipped`，保留音频且没有自动音符。

6 条音频均通过 HTTP 获取并检查到 RIFF 文件头；实际 MIDI 导出后成功回读 102 个 note-on。4 个已有工程的 JSON 逐份比对完全未变。证据为工作区 `work/user-audio-diagnosis/repair-result.json`，回归和打包状态见 [STATUS.md](STATUS.md)。这次结果证明新检查作用于真实链路，不等于所有预测音符正确；独立诊断的 99 个与此次 102 个音符来自不同推理，Demucs 的随机移位会产生差异。
