# Windows CPU 识别环境准备

`setup_runtime.py` 供桌面首次运行调用。使用安装包内完整的 Windows x64 CPython 3.11（包含 `venv`、`ensurepip`、`pythonw.exe`），不查询系统 Python 或 PATH。它会联网从 PyPI、PyTorch 官方 CPU 索引及模型作者公开仓库下载依赖与权重。首次安装成功后，模型缓存已准备好。

```powershell
& ./frontend/build-resources/runtime/python/python.exe ./scripts/setup_runtime.py `
  --target D:/runtime-test/recognition/runtime `
  --progress D:/runtime-test/recognition/setup-progress.json `
  --result D:/runtime-test/recognition/runtime/runtime.json
```

上述目录仅为独立开发验证示例。桌面版传入自身 userData 下的 `recognition/runtime`；脚本不读取、上传或覆盖用户音频和工程。正式资源布局为 `resources/runtime/python/pythonw.exe` 与 `resources/backend/setup_runtime.py`，后者同目录须包含 `stemwork/`、`distribution-manifest.json` 及三份 `requirements-distribution-*.txt`。

## 合同与目录

- 参数：`--target`、`--progress`、`--result` 必填；可选 `--cancel-file`，该文件出现后取消。桌面可暂不提供取消入口。
- 进度通过 stdout JSON 行和原子更新的 JSON 文件发布：`stage` 为 `preparing/downloading/installing/verifying/complete/failed`，同时含 `message/updatedAt`。只有下载清单已知精确字节数时才有 `bytesDownloaded/totalBytes`；依赖安装不编造百分比。
- 成功退出码 0，失败 1，取消 2，另一个安装进程活动中为 3。并发实例不覆盖前者的进度。
- 完成清单 `schemaVersion=1`，`runtimeRevision` 与 `backend/distribution-manifest.json` 一致；`python/modelPython/pianoPython/pianoCheckpoint/backendDirectory/modelCacheDirectory` 均为 target 内绝对路径。桌面须校验版本和路径边界后使用。
- revision 下先复制完整 Python，再建立 `api/` 与 `models/` 两个 venv，后端也复制到该目录。虚拟环境的基础解释器不会引用安装目录，程序升级不影响既有运行环境。
- `models/` 同时运行 Demucs、Basic Pitch、钢琴专用模型和 worker，使用 CPU PyTorch；`pianoPython` 与 `modelPython` 相同。配置 `HF_HUB_OFFLINE=1` 可直接复用预先校验的四轨/六轨快照。
- 依赖安装、模型 SHA-256、CPU/ONNX 模型加载、FFmpeg 与 WAV 读写全部通过后，才原子发布 runtime.json。失败保留日志与缓存，可重试；旧已完成 revision 不会被删除。
- `target/.setup-runtime.lock` 防止并行安装；`target/logs/setup-*.log` 保留安装输出。应用窗口关闭是否继续安装由桌面协调器管理。

## 依赖锁与验证

`requirements-distribution-api.txt` 和 `requirements-distribution-models.txt` 锁定全部依赖版本，统一 `--no-deps` 安装。PyTorch 单独使用 `requirements-distribution-torch.txt` 和官方 CPU 索引，因此不会引入 CUDA 包。Basic Pitch 0.4.0 在 Python 3.11 的元数据要求 TensorFlow；本发行环境有意使用其官方 ONNX 模型，不安装 TensorFlow。不能直接用 `pip check` 的 TensorFlow 缺失报告判定安装失败；脚本验证实际 ONNX 加载及每项锁定版本。

权重清单锁定作者仓库 commit、文件大小和 SHA-256，包括四轨/六轨 Safetensors 与钢琴权重；下载 `.part` 不会当成完成文件。依赖包使用固定官方源和精确版本，未声明为带哈希的离线 wheel 仓库。完整干净环境安装仍须在正式打包前实际验证。

当依赖、安装流程或复制进运行目录的后端代码变化时，更新 `distribution-manifest.json` 的 `runtimeRevision`，使桌面应用重新准备新 revision。不要在保持修订号不变的情况下替换已发布运行环境。

```powershell
python -m pytest scripts/tests/test_setup_runtime.py -q
```

这些测试检查损坏下载、取消重试、原子清单、并发锁、固定依赖和失败传播，不代替真实模型推理或干净安装验收。

## 第三方材料

pip 安装保留各包的 metadata、LICENSE、NOTICE 等文件。成功验证时另外记录 revision 下 `licenses/installed-components.json`、实际 FFmpeg `-L` 及 `-version` 输出；钢琴缓存旁有官方权重署名、CC BY 4.0 链接和适配器改动说明。

`piano-transcription-inference` 的 wheel 仅声明 MIT 元数据，未含许可原文；Demucs 官方模型卡未单独声明权重许可。清单保留这些待确认项，不把代码许可推定为全部权重许可。Windows imageio-ffmpeg 的内嵌 FFmpeg 与 wrapper 许可不同，实际可执行文件声明 GPL-3.0-or-later；正式分发的来源、对应源码及第三方说明由发布流程统一处理。
