# NoteWise Lab / 智音lab · Windows 0.2.0 安装版

本文说明 **NoteWise Lab（智音lab）0.2.0 Windows 安装版**。全新目录的自动环境准备、三条真实 CPU 推理链路、MIDI 回读与 NSIS 构建均通过。VC++ 运行库已接入，完整新机交互验收尚未完成。私有仓库 [Lucas0623z/notewise-lab](https://github.com/Lucas0623z/notewise-lab) 已创建；发布正等待 GitHub 身份验证，尚未发布 Release。

## 安装与首次启动

1. 运行 `NoteWise-Lab-Setup-0.2.0-x64.exe`，使用 Windows 安装向导完成安装。应用为 **仅当前用户安装**，可以选择安装位置。若缺少所需的 Visual C++ x64 运行库，向导会打开微软官方安装窗口，由你接受其条款并完成 Windows 管理员确认；已有满足版本的运行库会跳过此步。
2. 安装完成后不会自动启动。使用桌面或开始菜单中的「NoteWise Lab」快捷方式打开应用。
3. 默认进入真实识别模式。没有外部环境配置时，应用自动准备 CPU 识别环境，用户无需自己安装 Python、执行终端命令或创建配置文件。
4. 在「新建转录」查看准备阶段；接口、模型进程和所选识别能力实际就绪后，才允许上传。

安装包包含可移植 Python 和后端代码。首次准备还需联网下载 CPU PyTorch 包约 **619 MB**、模型约 **311 MB**，加上其他 Python 依赖。安装后的磁盘占用大于下载量。这些是依赖与模型下载；工程、上传音频、识别计算及结果保留在本机。

安装协调器使用包内 Python 启动准备脚本，再把完整 Python、API/模型环境、后端和模型复制或安装到 **userData/recognition/runtime/revisions/<版本>**。完成后的服务使用用户目录中的副本，不继续引用应用安装目录中的 Python 或后端。依赖修订号变化时会准备新版本，已有版本和工程不会被安装流程删除。

下载阶段有真实字节数才显示已下载量与已知总量；pip 安装、校验等阶段只显示实际阶段，不用计时器猜测总百分比。安装失败不会显示就绪，也不会每隔几秒自动重装；可在界面展开日志，再点击「重试连接」。

关闭窗口后，安装进程、后台 API 与模型进程继续运行，已接收的识别任务继续处理。重开读取原安装进度或复用服务，启动锁和存活进程记录防止重复启动。要终止某个识别任务，请使用工程里的「取消处理」。关机、重启或强制结束后台进程会中断处理，不属于“关闭窗口继续处理”的保证范围。

已有外部 `recognition.local.json` 或显式 Python/后端环境变量时，继续使用该配置，**不会自动替换已有环境**。旧版便携程序的配套配置、源码和模型路径仍须保留；这一高级部署方式不再是普通安装用户的前提。

## 日常使用与识别边界

上传支持 WAV、MP3、FLAC，最多 100 MB、30 分钟。钢琴混合录音可选「实验 6 轨」和「钢琴专用识别」；已知单钢琴录音也可直接识别。确认打击乐只有镲片时，再开启「镲片 MIDI」。它提取击打点，不识别完整鼓组或镲片种类；默认关闭，可能漏掉重叠击打或被串音触发。

4/6 轨是固定输出类别，不代表原录音有 4/6 种乐器。标准 4 轨没有独立钢琴轨，钢琴通常在「其他」中；实验 6 轨的钢琴与吉他仍可能串音、漏音。钢琴专用转录仍可能错音、漏音或延音过长。近静音检查可减少极弱残留中的虚假音符，但低电平不能证明乐器不存在。音符数量变化和处理完成都不是准确率证明，仍须试听校对。

音符属性修改只影响 MIDI；分轨音频仍是分离后的原录音，不会随音符编辑重合成。可用「从所选音符试听 MIDI」听当前草稿。MIDI 试听采用简单合成音色；镲片音符宽度表示触发长度，不是尾音。拍号固定 4/4，BPM 由用户设置或使用默认值，未自动检测；编辑器与导出暂不支持踏板 CC64。

`--demo` 使用明确标注的合成样本，不启动识别；源码交付目录还提供「打开桌面演示.cmd」。在演示上传页可切换到真实模式。模式切换会重新打开应用；演示和真实工程分别保存。

## 高级选项：已有环境与源码开发

普通安装用户无需手动配置。需要继续使用已有模型环境或从源码开发时：

1. 按 [根目录说明](../README.md) 准备 API 环境。
2. 按 [模型说明](MODELS.md) 准备 Python 3.11 模型环境，并在该环境安装后端包。钢琴专用识别另用隔离环境和已校验的官方权重。
3. 将项目根目录的 `recognition.example.json` 复制为 `recognition.local.json`，核对路径。
4. 启动桌面程序。若服务未就绪，按上传页提示检查或重试。

配置示例：

```json
{
  "python": ".venv-api/Scripts/python.exe",
  "modelPython": ".venv-models/Scripts/python.exe",
  "pianoPython": ".venv-piano/Scripts/python.exe",
  "pianoCheckpoint": "data/model-cache/piano/CRNN_note_F1=0.9677_pedal_F1=0.9186.pth",
  "backendDirectory": "backend",
  "dataDirectory": "data",
  "modelCacheDirectory": "data/model-cache",
  "apiOrigin": "http://127.0.0.1:8000"
}
```

| 字段 | 用途 |
| --- | --- |
| `python` | 已安装后端依赖的 API Python |
| `modelPython` | 已安装后端与模型依赖的 Python，启动 worker 并执行模型 |
| `pianoPython` | 可选，已安装钢琴专用依赖与后端的隔离 Python；省略时使用模型环境，仍须具备对应依赖 |
| `pianoCheckpoint` | 可选，已下载并校验的官方钢琴权重；省略时按模型缓存中的 `piano` 子目录查找 |
| `backendDirectory` | 包含 `stemwork/main.py` 的后端目录 |
| `dataDirectory` | SQLite 数据库、工程、上传音频、结果与服务日志 |
| `modelCacheDirectory` | 官方模型下载和推理缓存 |
| `apiOrigin` | 本机 API 地址，只允许 `http://127.0.0.1:端口` 的根地址 |

相对路径以 **配置文件所在目录** 为基准，也可填写绝对路径。源码开发把配置放在项目根目录；已有便携版可以放在 EXE 同目录。外部配置模式不会自动安装或修补其 Python/pip 环境；应按 [模型说明](MODELS.md) 自行维护。没有外部配置的安装版走前述自动准备流程。

配置查找顺序：

1. 如设置 `STEM_STUDIO_CONFIG`，只使用它指定的配置文件；建议填写绝对路径。
2. EXE 所在目录的 `recognition.local.json`（便携版使用原始 EXE 目录，而非临时解压目录）。
3. 桌面 userData 目录的同名文件。
4. 应用目录的上一级，供源码开发读取项目根配置。

可用环境变量覆盖 `STEM_STUDIO_PYTHON`、`STEMWORK_MODEL_PYTHON`、`STEMWORK_PIANO_PYTHON`、`STEMWORK_PIANO_CHECKPOINT`、`STEM_STUDIO_BACKEND_DIR`、`STEMWORK_MODEL_CACHE` 和 `STEM_STUDIO_API_ORIGIN`。日常使用优先维护一份配置文件即可。

程序检查现有接口与 worker 状态并复用匹配服务。自动管理环境还会核对接口的实例标识，遇到其他数据目录的接口时显示冲突，不为它启动新的 worker。更改端口时应同步修改配置；纯浏览器开发代理也需对应调整。

Windows 启动器优先使用所配置 Python 同目录的 `pythonw.exe`；找不到时仍以隐藏窗口方式启动 Python。后台输出写入日志。数据目录中的启动锁防止同时打开应用时重复启动服务和控制台；不需要额外手动启动 worker。

## 服务状态与日志

上传页显示环境准备、接口、模型进程和各识别方式的实际可用状态。自动准备会下载并校验 4/6 轨、通用转录与钢琴专用模型所需资源；完成后再启动服务。依赖与心跳就绪后才允许提交对应任务，不能把“安装完成”当作“模型进程已就绪”。外部配置模式仍需自行准备依赖和权重；缺失或校验失败会明确报错，不会静默改用 Basic Pitch。

| 现象 | 处理 |
| --- | --- |
| 首次下载、安装或校验中 | 等待真实阶段更新；总大小未知时不会显示总百分比，关闭窗口后仍继续 |
| 识别环境准备失败 | 展开安装日志检查原因，确认网络与磁盘空间后点击「重试连接」 |
| 安装包识别组件不完整 | 重新获取完整安装包；不要只复制安装目录中的 EXE |
| 正在启动 | 等待接口和模型进程初始化；不要重复上传 |
| 外部配置中未找到 Python 或后端源码 | 检查配置中的 Python、模型环境和后端目录路径，然后重试 |
| 外部环境模型依赖未就绪 | 按 MODELS.md 补全模型环境；Demucs 4.1 使用 sphn，不要求旧 torchaudio |
| 钢琴专用识别不可用 | 自动管理模式检查准备/服务日志；外部配置检查 `pianoPython`、`pianoCheckpoint` 及官方权重校验结果 |
| 端口或接口不匹配 | 使用正确配置，或选择空闲的本机 API 端口 |
| 服务意外退出/任务失败 | 查看下列日志；已完成轨道可能仍保留 |

首次准备日志位于 `userData/recognition/setup.log`，阶段记录为 `setup-progress.json`；失败时界面可显示日志末尾与路径。后台服务日志位于 `dataDirectory/logs/api.log` 和 `dataDirectory/logs/worker.log`，自动管理模式的 `dataDirectory` 默认是 `userData/projects`。各模型任务子目录保留模型日志与中间音符数据，便于定位解码或推理错误。重试识别请新建工程，避免覆盖已有编辑。

## 开发与打包

在 `frontend` 目录执行：

```powershell
pnpm install
pnpm dev:desktop
# 仅演示：
pnpm dev:desktop --demo
# 准备完整 Python、后端与许可证资源并构建 NSIS 安装包：
pnpm desktop:package
# 可选便携包：
pnpm desktop:portable
# 只生成完整未封装目录：
pnpm desktop:dir
```

开发命令启动仅监听 `127.0.0.1:5173` 的 Vite，再打开 Electron；5173 已占用时会报错，不接入未知服务。关闭开发窗口会结束本次 Vite，已启动的识别服务保持后台运行。

开发与打包机器需要 Python、Node.js 和 pnpm；这不代表安装用户需要这些开发工具。`desktop:prepare` 准备可移植 Python、后端、锁定依赖清单与第三方许可证；`desktop:package`、`desktop:portable` 和 `desktop:dir` 均已包含此步骤。

安装包输出名称为 `frontend/release/NoteWise-Lab-Setup-0.2.0-x64.exe`，使用 NSIS 当前用户安装向导，安装完成不自动启动，卸载配置保留用户数据。可选便携包为 `frontend/release/NoteWise-Lab-0.2.0-x64.exe`。未封装目录为 `frontend/release/win-unpacked`，分发该目录必须保留全部资源文件。当前未配置发布者代码签名，Windows 可能显示未知发布者。安装程序编译通过不等于 GitHub 发布或新机交互验收已完成。

## 当前与历史验证

**0.2.0 已完成：** 在全新目录真实执行自动 CPU 环境准备，单次约 3 分钟；ONNX、4 轨、6 轨与钢琴模型加载，以及 FFmpeg/WAV 检查通过。该结果说明准备脚本与模型加载链路在当前机器可运行，不是下载耗时承诺，也不等于全新 Windows 机器验收。

**0.2.0 尚待完成：** 最终安装包在无预装运行库机器上的完整交互验收，以及等待 GitHub 身份验证的 Release 发布；私有仓库已创建。新环境真实推理和 VC++ 安装器准备已通过，详细证据见 STATUS.md。不要用下列旧版结果替代新版验收。

**v0.1.3 真实链路（当前继续保留）：**「001 旋律 · 钢琴专用与镲片」完成 25.34 秒六轨处理，得到 67 个钢琴预测音符和 4 个镲片击打点；6 条 WAV 可读取，MIDI 回读为 71 个 note-on，鼓使用第 10 通道。6 个已有工程未改动。数量变化不证明准确率，仍需人工校对。

**v0.1.4 试听说明：** 音符属性只影响 MIDI，原分轨录音不会变化。属性面板新增说明和「从所选音符试听 MIDI」按钮，读取当前草稿、切换到 MIDI，并从所选音符开始播放；无需先保存。

**历史验证：** v0.1.1 未封装 EXE 已在正常桌面用户下加载生产 React/Tone 界面，保留安全沙箱，无 renderer/preload 错误；服务自动启动和 8 秒真实上传识别已运行。MP3/FLAC 直接转录记录见 [格式测试报告](../examples/codec-smoke.json)。这些历史结果不代替新版验收。

当前测试、构建和交付结果见 [STATUS.md](STATUS.md)。最终安装包的完整原生操作、实际声音输出、保存窗口和退出重开仍需人工确认，不能把环境准备或模型链路通过等同于全部桌面操作已验收。

## 数据位置

- 自动管理环境的 Python、依赖、后端副本与模型：`userData/recognition/runtime/revisions/<版本>`；完成清单为 `userData/recognition/runtime/runtime.json`。
- 自动管理环境的真实工程、上传音频和结果：`userData/projects`。
- 外部配置的真实工程、上传音频和结果：配置的 `dataDirectory`；模型缓存使用 `modelCacheDirectory`。
- 演示工程：桌面 userData 中的 `demo-projects.v1.json`，经过校验后原子写入，重开及界面端口变化不丢失。
- Chromium 缓存、桌面日志和崩溃记录：桌面用户配置目录下对应子目录。

默认桌面 userData 固定为 `%APPDATA%/stem-studio-desktop`，显示名称改为「NoteWise Lab / 智音lab」不会移动旧工程或草稿。可用绝对路径环境变量 `STEM_STUDIO_DATA_DIR` 指定其他目录；它影响桌面配置、演示数据和自动管理环境的默认位置，不等于后端变量 `STUDIO_DATA_DIR`。使用外部配置时，明确设置的 `dataDirectory` 仍由该配置决定；API 与 worker 使用相同数据目录。

安装版与便携版都不会默认把用户工程写在 EXE 旁边。后台环境驻留用户目录，升级应用无需移动工程；当前卸载配置也保留用户数据。保存失败会显示在界面，不能当作保存成功。

## 窗口、文件与安全边界

窗口默认 1440 × 960，最小 1200 × 920，保留 Windows 原生标题栏及系统按钮。音频选择使用 Windows 文件选择窗口；MIDI 导出使用原生保存窗口，可取消，覆盖确认由系统处理。

- renderer 保持 `contextIsolation`、`sandbox` 与 `webSecurity`，关闭 Node.js 集成。
- preload 只暴露模式、演示工程读写、MIDI 保存和固定的识别服务启动操作，不提供任意 shell/文件读写。
- 后台进程由主进程按本机配置用参数数组启动，不拼接 shell 命令；Windows 优先 `pythonw.exe`，回退时隐藏窗口，并以启动锁避免重复启动。
- 界面只由回环随机端口提供，API 代理目标仅允许 127.0.0.1；文件服务检查真实路径边界。
- 禁止外部导航、新窗口、webview；默认拒绝摄像头和麦克风权限。
- MIDI 保存只接受受限大小的合法 MIDI 字节和建议文件名，最终位置由用户在系统窗口选择。
- 一次只运行一个主窗口；演示与真实模式由启动参数决定。

## 原生验收清单

1. 在无预装 Python/开发环境的 Windows 上完成当前用户安装，安装结束不自动打开应用。
2. 首次启动自动下载、安装和校验；模拟网络失败后显示真实错误且可重试，未就绪时不能上传。
3. 安装或识别期间关闭窗口，重开后恢复进度或结果；没有重复后台进程。
4. 默认启动真实模式，服务实际就绪后上传原创样本，生成可读音轨与音符。
5. 分轨/MIDI 试听实际发声，暂停、跳转和混音正常；音符修改只影响 MIDI。
6. 编辑保存后重开数据一致，导出的 MIDI 能重新读取。
7. 原生保存窗口取消不报错，保存和覆盖确认正常。
8. `--demo` 明确显示演示状态，切换真实识别后不混用演示工程。
9. 升级或卸载行为符合数据保留约定，既有外部配置与工程不受影响。

## 参考

- [Electron 安全实践](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron 上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [electron-builder Windows 配置](https://www.electron.build/win/)
