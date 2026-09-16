# 分轨工作台前端

React + TypeScript 编辑器与 Electron Windows 桌面外壳。工程列表、上传识别和编辑器共用 `../frontend-kit` 的 API 合同，真实识别由 FastAPI 与独立模型 worker 执行。

## 启动与打包

v0.1.1 **默认真实识别模式**，`--demo` 才使用演示工程。准备好项目根目录的 Python 环境与 `recognition.local.json` 后，在本目录执行：

```powershell
pnpm install
pnpm dev:desktop
# 明确进入演示模式：
pnpm dev:desktop --demo
```

配置模板是 [recognition.example.json](../recognition.example.json)。桌面主进程读取配置，自动启动后台 API 和模型 worker；不需要用户再开两个终端。首次准备环境见 [根目录说明](../README.md)。

```powershell
pnpm test
pnpm build
pnpm desktop:package
```

便携包输出为 `release/Stem-Studio-0.1.1-x64.exe`；`pnpm desktop:dir` 输出完整未封装目录，`pnpm desktop:start` 打开已构建界面。便携 EXE 旁放置 `recognition.local.json` 即可指定本机环境，Python、模型和后端源码不会被自动装入 EXE。旧 0.1.0 不作为推荐入口。

关闭窗口不会终止后台识别任务；下次打开复用已有服务。开发启动器会停止自己启动的 Vite，后台 API/worker 保持运行。修改启动模式前关闭当前窗口；应用一次只保留一个主实例。

## 页面与服务状态

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `/projects` | ProjectsPage | 项目列表、打开工程、任务状态和部分结果 |
| `/upload` | UploadPage | 检查服务与模型能力、选择文件和参数、上传并排队 |
| `/projects/:id` | EditorPage | 编排、音符编辑、混音、试听、保存与 MIDI 导出 |

上传页区分服务启动中、就绪、不可用和演示模式。它通过服务状态及 worker 心跳确认所选识别方式是否可用，提交前再次检查。服务未就绪时可重试；不把演示状态包装成真实识别成功。模型依赖可用不等于权重已下载，首次推理仍可能下载官方模型。

应用使用 HashRouter。任务通过 SSE 与轮询更新，`latestJobId` 支持重新打开工程后恢复进度。

## 模块

| 位置 | 用途 |
| --- | --- |
| `src/main.tsx` | 路由、应用外壳与查询提供器 |
| `src/fonts.css`、`src/apple-ui.css` | 本地字体与 Apple 参考视觉样式 |
| `src/components/Arrangement.tsx` | 多轨时间轴 |
| `src/components/PianoRoll.tsx` | Canvas 音符显示与编辑 |
| `src/components/Waveform.tsx` | 真实音频波形 |
| `src/audio/engine.ts` | Tone/Web Audio 统一时钟、分轨/MIDI 互斥试听 |
| `src/state` | 编辑历史与低频播放状态 |
| `src/services/api.ts` | SDK 封装、模式选择与资源 URL |
| `src/hooks/useProjectJob.ts` | 任务查询、事件订阅与取消 |
| `src/hooks/useServiceStatus.ts` | 本机识别服务和模型能力状态 |
| `electron/main.cjs`、`preload.cjs` | 原生窗口、固定用途 IPC、启动模式 |
| `electron/recognition-service.cjs` | 读取本机配置，启动和复用 API/worker |
| `electron/server.cjs` | 本机界面文件服务与同源 API 代理 |
| `electron/demo-store.cjs` | 演示工程校验和原子保存 |
| `electron/dev.cjs` | Vite 与 Electron 开发启动 |

组件由本项目用 React/CSS 实现，外观参考 Apple macOS 官方资源。Button 使用 shadcn 风格组合与 Radix Slot，没有另加图标库。Windows 使用用户确认的 Inter Variable 与 Noto Sans SC Variable，本地打包并附 OFL 许可，不分发 Apple SF 字体。Figma 官方组件导入仍有权限限制，详见 [设计来源](../docs/DESIGN_SOURCE.md)。

## 桌面配置

桌面模式由主进程固定为 `api` 或 `demo`，通过只读 `window.desktop.mode` 提供，优先于构建变量。默认 `api`；`--api` 仍可显式指定，`--demo` 启用演示。

配置查找顺序和字段见 [桌面说明](../docs/DESKTOP.md)。源码开发通常在项目根目录放 `recognition.local.json`；便携版通常与 EXE 放在一起。相对路径以配置文件所在目录为基准。

发行界面由主进程绑定 `127.0.0.1` 随机端口提供，`/api` 代理到配置的本机 API。生产桌面保持 `VITE_API_BASE_URL` 为空。代理只接受回环 HTTP 地址；不需要 `file://` 或放宽后端 CORS。

## 浏览器开发与手动后端调试

`pnpm dev` 只启动 Vite，**不会启动 Python 服务**。没有桌面桥接时，`VITE_DEMO_MODE !== 'false'` 为演示模式；`VITE_DEMO_MODE=false` 接入真实 API。Vite 默认将 `/api` 代理到 8000 端口，环境变量变更后要重启开发服务。

需要独立调试后端时，可在项目根目录分别运行以下命令，确保两个进程使用同一 `STUDIO_DATA_DIR`：

```powershell
$env:STUDIO_DATA_DIR = (Join-Path (Get-Location) "data")
& ./.venv-api/Scripts/python.exe -m uvicorn stemwork.main:create_app --factory --host 127.0.0.1 --port 8000
```

```powershell
$env:STUDIO_DATA_DIR = (Join-Path (Get-Location) "data")
$env:STEMWORK_MODEL_CACHE = (Join-Path (Get-Location) "data/model-cache")
& ./.venv-models/Scripts/python.exe -m stemwork.worker
```

这些是开发调试命令；配置好的桌面版会自动完成启动。

## 保存、数据与播放

- 真实工程和音频写入配置的 `dataDirectory`，后台日志位于其 `logs/api.log` 与 `logs/worker.log`。
- 演示工程经受限 IPC 原子写入桌面 userData 的 `demo-projects.v1.json`；浏览器演示仍使用 localStorage。
- `STEM_STUDIO_DATA_DIR` 可单独指定桌面 userData；它与后端 `STUDIO_DATA_DIR` 不同。
- 文件选择使用系统文件输入控件；MIDI 通过 `window.desktop.saveMidi(bytes, name)` 打开 Windows 保存窗口。
- `window.desktop.enableRecognition()` 只执行固定的识别服务启动/切换操作，不接受任意命令。
- 音符存储秒数；WaveSurfer 只显示波形，所有试听共享音频时钟。
- MIDI 使用简单合成音色；鼓轨不伪造音符；同音高重叠在试听/导出时合并。
- BPM 未自动检测，固定 4/4；模型音符需要人工校对。

## 验证范围

本轮前端 **43 项测试**、桌面配置 **2 项测试**、TypeScript 检查与 Vite 构建通过，包含新增服务状态与上传能力检查。

真实上传、Basic Pitch 转录、任务恢复、修改保存和 MIDI 导出已通过。本轮由桌面服务管理器自动启动 API 与模型 Python worker，服务显示就绪；从上传页提交 8 秒原创混音的标准 4 轨任务后，界面自动出现 4 条真实波形与 54 个音符。鼓轨为 0 音符并显示不支持，真实音频播放操作进入播放状态。独立 Demucs + Basic Pitch 烟测和 MIDI 回读详情见 [MODELS.md](../docs/MODELS.md)。

MP3 与 FLAC 的真实 `transcribe_only` 验证均完成：8 秒输入分别耗时 12.953 秒和 4.125 秒，均输出 35 个音符与可回读的 PCM WAV。该验证只做直接转录，不包含分轨，详见 [格式测试报告](../examples/codec-smoke.json)。

正常桌面用户 Lucas 下的最小 Electron 页面已达到 `renderer-loaded`。随后新版本未封装 EXE 也已执行生产 React/Tone 界面，无 renderer/preload 错误，保持 `sandbox: true`；此前受限启动阻碍已消除。0.1.1 便携包现已生成；最终便携包手动打开、实际扬声器输出、原生保存窗口及退出重开完整操作仍需人工确认。最新状态与自动打开验证限制见 [STATUS.md](../docs/STATUS.md)。
