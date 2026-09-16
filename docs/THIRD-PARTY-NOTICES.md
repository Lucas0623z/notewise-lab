# 第三方组件、许可证与署名

核对日期：2026-09-15。适用对象：本应用的 Windows x64 安装版，以及安装后按需取得的本机识别环境。

本文件记录组件来源、已核实的许可声明和发布时应保留的材料。**代码、模型权重、字体和二进制内附库分别适用其各自许可，不能统称为 MIT。** 本文件是发布材料索引，不替代各组件的完整许可证，也不代表已完成全部分发条件的法律判断。

## 1. 范围与当前状态

| 层级 | 本次审计范围 | 已核对 / 待核对 |
| --- | --- | --- |
| 桌面安装包 | Electron 44.4.0、前端 JavaScript/CSS、Inter 与 Noto Sans SC、本应用代码 | 已核对本地包与现有 `win-unpacked` 产物；正式安装包仍须复查 |
| 随包 Python | python-build-standalone 的 CPython 3.11.16 Windows x64 | 构建脚本已固定 `20260901` 压缩包与 SHA-256，并保留完整基础运行时的 `LICENSE.txt` |
| 首次安装的识别环境 | CPU PyTorch 2.8.0、Demucs 4.1.0、Basic Pitch 0.4.0 / ONNX、钢琴推理包、解码器及其依赖 | 本机旧验证环境为 CUDA PyTorch，不能当作待发布 CPU 环境的完整清单；应在正式环境安装后重新导出清单 |
| 模型文件 | HTDemucs 四轨 / 六轨、Basic Pitch 包内模型、Zenodo 4034264 钢琴权重 | 钢琴权重有独立 CC BY 4.0 声明；Demucs 权重授权范围仍需确认，见第 5 节 |

首次启动从上游下载的组件与直接塞进安装包的组件，应在清单中标明不同的交付方式。改为首次下载，不应被表述成已经解决了该组件的所有许可问题；也不要把首次下载计划写成“模型已经随包”。

## 2. Electron、前端组件与字体

### 2.1 Electron

Electron 本身采用 MIT；其内附 Chromium、Node.js 及其他代码有各自声明。当前本地 Electron 发行物提供 `LICENSE` 与 `LICENSES.chromium.html`；现有 `frontend/release/win-unpacked/` 已保留为 `LICENSE.electron.txt`、`LICENSES.chromium.html`。

发布时保留上述两份文件，不以本应用的许可证覆盖它们，也不只复制 Electron 的顶层 MIT 文本。最终安装版应能从安装目录或“第三方许可”入口读取这些材料。来源：[Electron 仓库](https://github.com/electron/electron)、本地 `frontend/node_modules/electron/dist/` 原件。

### 2.2 前端直接运行依赖

下表版本来自当前已安装的 `package.json`，与依赖声明中的宽松版本范围不同。最终发行以 `pnpm-lock.yaml` 和构建产物为准。

| 组件 | 当前解析版本 | 本地许可声明 | 包内应保留文件 |
| --- | --- | --- | --- |
| React / React DOM | 19.3.0 | MIT | 各自 `LICENSE` |
| React Router DOM | 7.18.3 | MIT | `LICENSE.md`，及所含 React Router 依赖的许可 |
| Radix React Slot | 1.3.3 | MIT | `LICENSE`，及运行依赖的许可 |
| TanStack React Query | 5.102.8 | MIT | `LICENSE`，及 Query Core 的许可 |
| Zustand | 5.0.15 | MIT | `LICENSE` |
| Tone.js | 15.1.22 | MIT | `LICENSE.md`，及音频相关运行依赖的许可 |
| @tonejs/midi | 2.0.28 | MIT | `LICENSE.md`，及 MIDI 解析依赖的许可 |
| WaveSurfer.js | 7.12.12 | BSD-3-Clause | `LICENSE` |
| class-variance-authority | 0.7.1 | Apache-2.0 | `LICENSE`；若该版本包含 NOTICE，一并保留 |
| clsx | 2.1.1 | MIT | `license` |
| tailwind-merge | 3.7.0 | MIT | `LICENSE.md` |

上表只列直接依赖。当前 `scripts/collect_frontend_licenses.cjs` 已递归检查 **26 个生产依赖**，收集包根的 `LICENSE*`、`NOTICE*`、`COPYING*`、`OFL*` 原文，无缺少许可文本的包。结果为 `frontend/build-resources/licenses/FRONTEND-LICENSES.txt` 和 `frontend-package-manifest.json`，配置为安装到 `resources/licenses/`；其中覆盖 `standardized-audio-context`、`automation-events`、`midi-file`、`@babel/runtime`、`@tanstack/query-core` 等传递依赖。后续依赖变化时重新生成，不以本表替代实际清单。源码级 shadcn 组件、Tailwind 生成内容若实际包含上游代码，也保留对应版本的原始声明。仅用于构建且没有进入成品的工具，不应误报为应用运行组件。

### 2.3 字体

| 字体 / 包 | 版本 | 署名与许可 | 已随前端资源保留 |
| --- | --- | --- | --- |
| Inter Variable / `@fontsource-variable/inter` | 5.3.0 | The Inter Project Authors；SIL Open Font License 1.1 | `frontend/public/licenses/fonts/Inter-LICENSE.txt` |
| Noto Sans SC Variable / `@fontsource-variable/noto-sans-sc` | 5.3.0 | 包内声明为 Google Inc.；SIL Open Font License 1.1 | `frontend/public/licenses/fonts/Noto-Sans-SC-LICENSE.txt` |

原件副本及接入说明也在 [fonts/README.md](fonts/README.md)。保留完整版权行和 OFL 文本，不删改原文件中的命名条款；修改字体时另核对保留字体名称的要求。本应用使用本地 WOFF2 资源，没有随包分发 Apple SF Pro 或苹方，也不声称这些替代字体由 Apple 提供。

## 3. Python 发行物与后端

### 3.1 CPython 与 python-build-standalone 要分开记录

- CPython 3.11.16：主体为 PSF 许可及历史许可；发行物内附软件另有许可。保留发行物根 `LICENSE.txt` 全文、实际附带的其他许可和版权文件，不能把它缩写成一句“Python：PSF”。[Python 3.11.16 官方许可说明](https://docs.python.org/3.11/license.html)
- 正式构建脚本 `scripts/prepare_windows_runtime.py` 固定 python-build-standalone `20260901` 的 `cpython-3.11.16+20260901-x86_64-pc-windows-msvc-install_only.tar.gz`，SHA-256 为 `6be524fa6752af802146a4adc7d098565425b0b1c166e19a5a7a4c8cccb86bf6`，把下载来源与校验值写入 `runtime/python-source.json`。`python-build-standalone` **构建项目**的根许可证为 MPL-2.0；这不表示其构建出来的 Python 及全部内附库一律 MPL-2.0。[构建项目 LICENSE](https://github.com/astral-sh/python-build-standalone/blob/main/LICENSE)、[官方发行页](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901)
- 上游完整分发格式的 `PYTHON.json` 可记录发行物和扩展库的 `licenses`、`license_path`。本机 `install_only` 安装树没有这份清单；不要伪称已检查其内容。正式发布应归档准确压缩包名、SHA-256、发行版本及可取得的对应构建清单。[发行格式说明](https://gregoryszorc.com/docs/python-build-standalone/main/distributions.html)
- 本机 `LICENSE.txt` 还包含 Windows 二进制的 Microsoft Distributable Code 条款、bzip2 与 Tcl/Tk 等说明；`tcl/tk8.6/license.terms` 也应随被保留的 Tcl/Tk 文件一起保留。若进行体积裁剪，按最终留下的 DLL/标准库复查所需材料，而不是删掉全部文档。
- 若保留 pip / setuptools，应同时保留它们自身及 `_vendor` 中依赖的许可。`*.dist-info/licenses/` 不是可随意删除的缓存目录。

### 3.2 API 与科学计算依赖

API 的直接依赖为 FastAPI、Uvicorn、Pydantic、python-multipart、Mido；其精确版本、Starlette / AnyIO / pydantic-core 等传递依赖，以正式环境的包清单和各自许可原文为准。模型环境还会包含 NumPy、SciPy、librosa、resampy、scikit-learn、Numba / llvmlite、matplotlib 等组件，不能只列主模型包。

尤其要保留二进制轮子所带的 OpenBLAS、LLVM、编译运行库等第三方声明。包顶层的 BSD/MIT 标识不等于其所有内附二进制都采用同一许可。

## 4. 识别代码与解码器

| 组件 | 核实范围 | 代码 / 包许可 | 应保留或补齐 |
| --- | --- | --- | --- |
| PyTorch 2.8.0 | 官方 v2.8.0 LICENSE；本机为 `2.8.0+cu128` | 主体 BSD-3-Clause，LICENSE 内另列来源 | 最终 **CPU** 轮子的 `LICENSE`、`NOTICE` 和内附依赖声明；不要拿 CUDA 清单替代 CPU 清单 |
| Demucs 4.1.0 | 已安装 wheel 元数据和 `licenses/LICENSE` | MIT；版权 Meta Platforms, Inc. and affiliates | `demucs-4.1.0.dist-info/licenses/LICENSE`；权重单列，见第 5 节 |
| sphn 0.2.1 | 已安装 wheel 的 `licenses/LICENSE` | Apache-2.0 | 原始 LICENSE 及二进制所含组件声明 |
| Basic Pitch 0.4.0 | 已安装 wheel 的 `LICENSE`、`NOTICE` | Apache-2.0；Copyright 2022 Spotify AB | **LICENSE 与 NOTICE 两份都保留**；NOTICE 含多个上游软件和测试音频来源说明 |
| ONNX Runtime | 本机 1.30.0，正式版需固定 | MIT 主体，另附第三方通知 | `onnxruntime/LICENSE`、`onnxruntime/ThirdPartyNotices.txt` |
| piano-transcription-inference 0.0.6 | 作者 `setup.py`、PyPI / 本机 METADATA | 声明 MIT classifier；**本地 wheel 未附 LICENSE 文件** | 保留作者、版本、来源和元数据；正式再分发前补齐上游完整许可 / 版权原文，不能自己推测版权年份 |
| torchlibrosa 0.1.0 | 已安装 wheel | MIT；Copyright 2018–2021 Qiuqiang Kong | `torchlibrosa-0.1.0.dist-info/LICENSE.md` |
| imageio-ffmpeg 0.6.0 的 Python 包 | 已安装 wheel | BSD-2-Clause | `imageio_ffmpeg-0.6.0.dist-info/LICENSE`；内附 FFmpeg 另列 |
| soundfile 0.14.0 的 Python 包 | 已安装 wheel | BSD-3-Clause | `soundfile-0.14.0.dist-info/LICENSE`；内附 libsndfile 另列 |
| lameenc 1.8.4 | Demucs 自动安装的依赖 | LGPL-3.0-or-later | `lameenc-1.8.4.dist-info/licenses/LICENSE`，对应源码与构建信息 |

主要来源：[PyTorch v2.8.0 LICENSE](https://github.com/pytorch/pytorch/blob/v2.8.0/LICENSE)、[Demucs LICENSE](https://github.com/adefossez/demucs/blob/main/LICENSE)、[Basic Pitch v0.4.0 LICENSE](https://github.com/spotify/basic-pitch/blob/v0.4.0/LICENSE)、[Basic Pitch NOTICE](https://github.com/spotify/basic-pitch/blob/main/NOTICE)、[钢琴推理包作者 setup.py](https://github.com/qiuqiangkong/piano_transcription_inference/blob/master/setup.py)、[钢琴推理包 0.0.6](https://pypi.org/project/piano-transcription-inference/0.0.6/)、[lameenc LICENSE](https://github.com/chrisstaite/lameenc/blob/main/LICENSE)。表中其余文件路径是本次实际安装树的核查证据。

**ONNX 与 TensorFlow 的安装范围不能混淆。** Basic Pitch 0.4.0 在 Windows + Python ≥3.11 的包元数据仍要求 TensorFlow `<2.15.1`。本应用选择 ONNX 推理，并不自动使 TensorFlow 从安装结果中消失；本机旧模型环境确实存在 TensorFlow / Keras / TensorBoard。若正式安装脚本保留标准依赖解析，就一并收集这些包的许可；若改为明确的 ONNX 最小依赖方案，以经过验证的最终安装清单为准。[Basic Pitch 模型运行时说明](https://github.com/spotify/basic-pitch#model-runtime)

### 4.1 内附 FFmpeg：已确认不是 BSD 许可

本地 `imageio-ffmpeg==0.6.0` 的 Windows wheel 内含：

`imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe`

实际执行该文件的 `-L` 得到：版本为 `7.1-essentials_build-www.gyan.dev`，配置含 `--enable-gpl --enable-version3 --enable-static`；二进制自述许可为 **GPL-3.0-or-later**。这个结论针对该实际二进制，不能扩展成“所有 FFmpeg 都是 GPLv3”，也不能因外层 Python 包采用 BSD-2-Clause 而忽略它。[imageio-ffmpeg 官方说明：wheel 包含可执行文件](https://github.com/imageio/imageio-ffmpeg#installation)、[FFmpeg 官方许可说明](https://www.ffmpeg.org/legal.html)

若本应用分发、镜像或打包这份 wheel / EXE，发布材料应包含相应 GPL 文本、FFmpeg 与内附库声明、准确的对应源代码取得方式及构建配置。只附 BSD 文件或只写一个 FFmpeg 首页链接，不是这份二进制的完整材料。本次没有准备该二进制的对应源码包，列为发布前待办。

如果正式版换用其他构建，应重新运行 `-L` / `-buildconf` 并按实际配置记录，不能沿用本表。本应用通过独立进程调用解码器；本说明不据此推导整个应用必须或不必采用某一许可证。

### 4.2 soundfile 内附 libsndfile 与 lameenc

本机 soundfile wheel 的 `_soundfile_data/` 含 `libsndfile_x64.dll` 和 `COPYING`，后者为 LGPL-2.1 全文。上游说明 libsndfile 可按 LGPL 2.1 或 3 的条款使用，动态加载也仍有条件需要满足。保留 DLL 对应的 COPYING、版权及源码信息，并复查 DLL 内附编解码库的声明。[libsndfile 官方许可段落](https://libsndfile.github.io/libsndfile/#licensing)

Demucs 4.1.0 的常规依赖包含 lameenc；即使本应用只输出 WAV、不主动导出 MP3，它也可能已经被安装。是否进入分发物以实际安装清单为准，不能因功能没有显示在界面里就删去 LGPL 记录。

## 5. 模型权重：独立来源与署名

### 5.1 HTDemucs 四轨 / 六轨——权重授权仍待确认

| 应用模型名 | 作者发布仓库 | 实际文件 | 本地缓存快照 |
| --- | --- | --- | --- |
| `htdemucs` | [adefossez/HTDemucs](https://huggingface.co/adefossez/HTDemucs) | `955717e8.safetensors` | `cbc8a9b1a87023b7fd74e7b3412e6321c0eab003` |
| `htdemucs_6s` | [adefossez/HTDemucs-6s](https://huggingface.co/adefossez/HTDemucs-6s) | `5c90dfd2.safetensors` | `3c5ee475be622df764938de97e4281a7b07ffa58` |

这两份官方模型卡明确其用途和文件来源，但本次可读取页面没有独立的权重 license 字段或明确的权重再分发授权文本。**Demucs 代码的 MIT 已确认；将相同 MIT 自动套用到这些权重，尚无足够依据。** 上游存在专门的 [预训练模型许可 issue #327](https://github.com/facebookresearch/demucs/issues/327)，本次读取仅得到问题正文，未能核验评论中的授权答复，因此本文件不转引第三方关于“仅科研”或其他许可证的说法，也不擅自给权重标为 CC BY-NC。

正式公开分发前，应取得适用于上述具体权重与使用方式的明确许可材料，保存作者答复或正式 LICENSE / 模型卡版本。当前建议在发布清单中标记“代码 MIT；权重授权待确认”，不要宣称“全部模型可任意商用”。改为自动下载也不构成对使用范围的独立授权。

来源署名可保留：Simon Rouard、Francisco Massa、Alexandre Défossez，*Hybrid Transformers for Music Source Separation*，ICASSP 2023；以及 Demucs 仓库中的 Meta 版权声明。论文署名不能替代权重授权。

### 5.2 Basic Pitch 包内模型

Basic Pitch 0.4.0 wheel 自带 TensorFlow、TFLite、CoreML 和 ONNX 模型，本应用明确选择 ONNX `nmp.onnx`。本次本地 ONNX 文件为 230,444 字节。代码与该包内模型随同 Spotify 的 Apache-2.0 项目发布，本次未发现包内另列模型专用许可；记录时应写清“上游包内发布，沿用包中 LICENSE / NOTICE”，而不是为任意第三方转换模型推断许可。[Basic Pitch 官方运行时说明](https://github.com/spotify/basic-pitch#model-runtime)

署名：Spotify AB；研究作者 Rachel M. Bittner、Juan José Bosch、David Rubinstein、Gabriel Meseguer-Brocal、Sebastian Ewert。保留原始 `NOTICE`，其中已有 Spotify 及多个依赖的署名。若只提取 ONNX 文件到另一目录，许可与来源说明应一同复制，不能只留下裸权重。

### 5.3 钢琴权重：Zenodo 4034264 / CC BY 4.0

作者正式发布记录为 [Zenodo 4034264](https://zenodo.org/records/4034264)，DOI `10.5281/zenodo.4034264`。本次读取本工作区前次从官方 API 保存的 `zenodo-metadata.json`：`metadata.license.id = cc-by-4.0`，发布者字段为 Qiuqiang Kong，发布日期 2020-09-17。此次在线重读接口失败，因此这里明确保留核查方式，不把第三方转存页当成权利来源。

| 校验项 | 值 |
| --- | --- |
| 文件 | `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth` |
| 字节数 | 171,966,578 |
| Zenodo 原记录 MD5 | `22b961b77c1878239fec963362097045` |
| 本地验证 SHA-256 | `c3fa9730725bf4a762f1c14bc80cd5986eacda01b026f5a4a2525cd607876141` |
| 权重许可 | CC BY 4.0 |

建议随模型缓存和应用许可页保留以下署名：

> 本应用使用 Qiuqiang Kong 发布的 *High-resolution Piano Transcription with Pedals by Regressing Onsets and Offsets Times* 模型权重，来源：Zenodo 4034264，DOI 10.5281/zenodo.4034264，许可：Creative Commons Attribution 4.0 International（CC BY 4.0）。相关研究作者为 Qiuqiang Kong、Bochen Li、Xuchen Song、Yuan Wan、Yuxuan Wang。本应用未修改模型权重；另行编写了缓存路径、安全加载、时间边界和音符输出适配。作者未为本应用背书。

附上 [权重记录](https://zenodo.org/records/4034264)、[CC BY 4.0 许可](https://creativecommons.org/licenses/by/4.0/) 和 [研究论文](https://arxiv.org/abs/2010.01815) 链接。CC BY 的署名、许可链接及修改说明要求见 [官方许可摘要](https://creativecommons.org/licenses/by/4.0/)；应同时保存可离线查看的许可原文 / 授权材料。

注意三个独立对象：作者推理包 0.0.6 的元数据声明 MIT；ByteDance 训练仓库 README 声明 Apache-2.0；上述 **权重记录** 声明 CC BY 4.0。不要把其中任何一个覆盖其他两个。[训练仓库 LICENSE 段落](https://github.com/bytedance/piano_transcription#license)

## 6. 发布材料应保留的位置

当前打包配置将前端许可集合放入 `resources/licenses/`，本说明放入 `resources/THIRD-PARTY-NOTICES.md`，完整 Python 放入 `resources/runtime/python/` 并保留原许可。模型依赖与权重由首次安装流程下载到应用数据目录，不预装进安装器；该流程仍应保留各包许可证和模型说明。

以下是进一步整理许可材料的建议结构；**并非所有子目录已创建**。应用内可增加指向这些材料的入口：

```text
licenses/
  THIRD-PARTY-NOTICES.md
  electron/          LICENSE.electron.txt、LICENSES.chromium.html
  frontend/          每个实际运行包的原始 LICENSE / NOTICE，按包名和版本归档
  fonts/             Inter-LICENSE.txt、Noto-Sans-SC-LICENSE.txt
  python/            CPython 完整 LICENSE.txt、发行元数据、内附库声明
  python-packages/   安装包元数据与许可副本，保留包内相同文件
  models/            各模型来源、版本/快照、校验值、许可、署名及改动说明
  codecs/            实际 FFmpeg / libsndfile / lameenc 许可、构建与对应源码信息
```

在创建正式包时：

1. 固定 Python 压缩包、CPU torch wheel 和实际依赖版本，生成包含下载 URL、版本、SHA-256 的组件清单。保留 `pip` 安装报告 / `*.dist-info`；本文件中的旧 GPU 验证环境不能充当发行锁定清单。
2. 完整保留包内许可，尤其 Basic Pitch 的 NOTICE、ONNX Runtime 的 ThirdPartyNotices、Electron 的 Chromium 清单；不要在瘦身时把这些与缓存一并删掉。
3. 归档模型发布来源和权重许可；Demucs 权重许可未确认时，不能勾选为“已通过授权核对”。钢琴推理 wheel 缺少完整 LICENSE 的情况也需补齐。
4. 如自行分发 FFmpeg / LGPL 二进制，落实准确的源码取得方式和所需通知；不把 wrapper 的许可证当成二进制许可证。
5. 对安装引擎最终实际携带的第三方代码一并保留声明；例如更换为 NSIS 安装器后，按其实际打包资源核对，而不是沿用 portable 产物清单。
6. 解包最终安装版，并在干净安装完成后复查许可文件可读取、版本与真实组件一致。以上是发布材料工作项，本轮未运行最终安装器验收。

## 7. 本轮确认的缺口

| 项目 | 现有证据 | 发布前需要完成 |
| --- | --- | --- |
| Demucs 权重 | 官方权重来源已核实，独立授权范围未核实 | 确认具体权重适用的许可；避免凭代码 MIT 宣称权重许可 |
| FFmpeg | 当前 Windows 二进制明确 GPL-3.0-or-later | 补齐实际二进制对应的通知、源码取得与构建材料，或重新审计替换构建 |
| 钢琴推理代码包 | 作者 setup.py / wheel 声明 MIT，wheel 无 LICENSE 原文 | 补齐可追溯的上游完整许可 / 版权材料 |
| 完整许可归档 | 字体与现有 Electron 许可已保留；26 个前端生产包的原始许可已汇总并接入打包；Python 原许可随基础运行时保留 | 复查最终 NSIS 安装结果；首次安装的 Python 包保留完整许可和模型说明，提供可访问位置 |
| 最终 CPU 环境 | 尚不是本次只读审计所使用的旧 GPU 环境 | 重新导出准确安装清单；核实 TensorFlow 等是否实际进入安装结果 |

这些项目是具体的材料或授权核实缺口，不是对整个应用作出的不可分发结论。本轮仅新增本说明，未安装、升级、删除或修改任何运行依赖。
