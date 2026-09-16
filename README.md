# NoteWise Lab / 智音lab · Windows 0.2.0 安装版

英文产品名为 **NoteWise Lab**，中文名为「智音lab」。Logo 将“智”字与八分音符融合；内部应用标识和原数据目录保持兼容。

上传音乐，分离音轨并识别音符，再在钢琴卷帘中编辑、试听和导出 MIDI。**0.2.0** 提供 Windows 安装向导与首次自动准备 CPU 识别环境，用户无需自行安装 Python、配置模型或打开终端。音频、工程和识别计算均留在本机；首次准备需要联网下载依赖和模型。

全新目录的环境准备、真实 CPU 推理与 MIDI 回读已通过验证，NoteWise Lab 品牌的 NSIS 安装与卸载程序已编译，Windows VC++ 前置组件已接入。尚未在一台缺少这些组件的新电脑上完成完整交互验收。私有仓库 [Lucas0623z/notewise-lab](https://github.com/Lucas0623z/notewise-lab) 已创建，发布正等待 GitHub 身份验证，尚未发布 Release。详细结果见 [当前状态](docs/STATUS.md)。

## 安装与使用

1. 运行 `NoteWise-Lab-Setup-0.2.0-x64.exe`，按向导安装到当前 Windows 用户。安装结束不会自动打开应用；从桌面或开始菜单启动「NoteWise Lab」。
2. 首次打开时，应用自动下载并准备 CPU 识别环境。在「新建转录」查看下载、安装、校验等实际阶段，等待本机服务显示就绪，再选择 WAV、MP3 或 FLAC 文件。
3. 钢琴与其他声音混合的录音，选择「分轨并识别 → 实验 6 轨 → 钢琴专用识别」；已知单钢琴录音也可直接识别。通用音高识别继续使用 Basic Pitch。
4. 确认打击乐只有镲片时，可开启「镲片 MIDI → 检测镲片击打点并生成 MIDI」。默认关闭；它检测击打时间，不识别完整鼓组或镲片种类。
5. 点击「上传并开始」，完成后试听、校对、编辑和导出 MIDI。

安装包包含启动准备流程所需的 Python 与后端；首次使用还会下载 CPU PyTorch 包约 **619 MB**、模型约 **311 MB**，其余依赖另计。安装后的磁盘占用大于下载量。界面只有在知道真实总字节数时显示下载量；安装依赖等阶段不猜测总百分比。失败后可查看安装日志并点击「重试连接」，不会自动反复重装。

Python、依赖、后端副本和模型放在用户数据目录的 `recognition/runtime` 版本目录中，工程默认保存在同一用户目录的 `projects` 中。关闭窗口后，安装或已接收的识别任务会继续；重新打开可恢复进度。取消识别请使用工程内的「取消处理」。关机或重启会中断后台进程，不能等同于关闭窗口。

已有 `recognition.local.json` 或显式 Python 配置会优先使用，保留原本机部署；这是高级或源码开发选项，普通安装用户无需创建。数据位置、排错和配置方式见 [桌面说明](docs/DESKTOP.md)。

只想体验编辑器时，可给程序加 `--demo`；源码交付目录也保留 [打开桌面演示.cmd](打开桌面演示.cmd)。演示使用明确标注的合成音符，不执行识别；可在上传页切换到真实识别模式。

## 功能与边界

- **上传**：WAV、MP3、FLAC，最多 100 MB、30 分钟；检查服务状态，显示真实进度，支持取消与重开恢复。
- **识别**：Demucs 分离音频，Basic Pitch 转录通用音高；钢琴专用模型用于六轨中的钢琴，或已知单钢琴录音。标准 4 轨为人声、鼓、贝斯、其他，没有独立钢琴轨；实验 6 轨增加钢琴和吉他。镲片包含在鼓轨中。
- **镲片 MIDI**：可选提取鼓轨中的瞬态击打点，默认用 GM 49 试听；编辑器可将整轨改为 GM 42、46、49 或 51，并可撤销。音符宽度表示 MIDI 触发长度，不表示镲片尾音。原分轨音频始终保留。
- **近静音检查**：保留极弱残留的音频，跳过其自动音符识别并显示说明，减少无声人声/贝斯轨中的虚假音符。保守门限同时检查平均、峰值、短窗口电平和相对原音电平，不会仅因整段平均电平低而丢弃短促打击声。
- **编辑**：多轨编排、真实波形、钢琴卷帘、音符增删/移动/时值调整、撤销重做、静音/独奏/音量/声像。
- **试听与保存**：分轨音频和 MIDI 使用统一音频时钟；保存工程，使用 Windows 保存窗口导出 MIDI。MIDI 试听是简单合成音色。

**属性修改只改变 MIDI 音符。**「分轨音频」播放分离后的原录音，不会随音符的音高、时间、时长或力度修改而改变。选中音符后点击「从所选音符试听 MIDI」，可从该位置听当前编辑结果，按现有静音、独奏和音量设置播放。当前没有原音频逐音重合成或修音功能。

**4/6 轨是模型的固定输出类别，不代表原音确实有 4/6 种乐器。** 四轨中的钢琴通常留在「其他」；音轨名称、音符数量和完成状态均不是乐器存在或识别准确率的证明。低电平也不能证明乐器不存在。

识别结果需要试听校对。钢琴专用模型仍可能漏音、错音或延音过长，当前编辑器与导出不支持踏板 CC64。鼓 MIDI 默认关闭；镲片检测可能漏掉重叠击打或被串音触发。「其他」可能混合多种乐器。拍号固定 4/4，BPM 是用户设置或默认值，未自动检测。

失败或取消可保留已完成轨道；重新识别需新建工程，旧工程不会自动改变。有音高轨的同音重叠音符在试听与导出时合并，不改写编辑数据；鼓轨保留相邻击打，导出使用 MIDI 第 10 通道。

## 验证状态

0.2.0 已在全新目录真实完成一次自动 CPU 环境准备，约 3 分钟；随后通过直接识别、四轨、六轨加钢琴与镲片三条真实上传/推理/导出流程，11 条 WAV 和全部 MIDI 回读通过。该耗时只是当前机器和网络的单次记录，不是安装耗时保证。微软签名的 VC++ 安装组件已接入，最终安装包的新机交互验收尚未完成。

真实候选工程「001 旋律 · 钢琴专用与镲片」已完成 25.34 秒音频的六轨处理：67 个钢琴预测音符、4 个镲片击打点，6 条 WAV 可读取，导出 MIDI 回读得到 71 个 note-on，6 个原工程均未改变。**音符减少不代表准确率已获证明**，仍需结合原音逐音校对；详情与历史验证见 [模型说明](docs/MODELS.md)。

测试、构建与交付状态统一见 [当前状态](docs/STATUS.md)。此前 Windows 原生应用已在开启沙箱的情况下加载生产界面；最终包的完整原生操作、实际声音输出和保存窗口仍需人工验收。

## 从源码运行

以下是开发者流程，Windows 安装版的普通用户不需要执行。推荐 Python 3.11、Node.js 22 与 pnpm。首次在项目根目录准备 API 环境：

```powershell
python -m venv .venv-api
& ./.venv-api/Scripts/python.exe -m pip install -e "./backend[dev]"
Copy-Item recognition.example.json recognition.local.json
```

按 [模型环境说明](docs/MODELS.md) 准备 `.venv-models`，并在该环境安装后端包：

```powershell
& ./.venv-models/Scripts/python.exe -m pip install -e ./backend
```

需要钢琴专用识别时，另按模型说明准备 `.venv-piano` 和官方权重，在配置中填写 `pianoPython`、`pianoCheckpoint`。确认 `recognition.local.json` 的路径正确，然后启动桌面开发版：

```powershell
cd frontend
pnpm install
pnpm dev:desktop
# 只运行演示：
pnpm dev:desktop --demo
# 准备资源并构建 Windows x64 安装包：
pnpm desktop:package
# 可选：构建便携包（同样支持首次自动准备识别环境）：
pnpm desktop:portable
```

桌面程序负责启动后台 API 与 worker。正常使用不需要分别运行这两个进程。纯浏览器开发及手动后端调试见 [前端说明](frontend/README.md) 和 [桌面说明](docs/DESKTOP.md)。

## 源码与接口

| 内容 | 入口 |
| --- | --- |
| 前端与模块说明 | [frontend/README.md](frontend/README.md) |
| 桌面配置、目录与排错 | [docs/DESKTOP.md](docs/DESKTOP.md) |
| Python API 与 worker | [backend/stemwork](backend/stemwork) |
| 配置模板 | [recognition.example.json](recognition.example.json) |
| 模型安装与真实验证 | [docs/MODELS.md](docs/MODELS.md) |
| API 合同与客户端 | [OpenAPI](docs/openapi.json)、[TypeScript SDK](frontend-kit/README.md) |
| 数据与播放架构 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 设计来源与 Figma 状态 | [docs/DESIGN_SOURCE.md](docs/DESIGN_SOURCE.md) |

本机接口默认位于 `http://127.0.0.1:8000`，接口文档为 [/docs](http://127.0.0.1:8000/docs)。面向本机单用户使用，不包含公网认证、计费或多人部署。
