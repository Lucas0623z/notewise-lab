# 界面设计来源与交付状态

## 官方视觉参考

本项目参考 [Apple 官方 macOS 27 Figma 资源](https://www.figma.com/community/file/1651309434229735362/macos-27)，将白色与冷灰面板、细边框输入框、蓝色主要按钮、胶囊分段控件和侧栏层次用于分轨工作台。

React、CSS、编辑器交互和 Windows 桌面外壳由本项目编写与适配。这里的“Apple 适配组件”表示视觉规则来源于该参考，不能理解为 Apple 编写、生成、审核或认可了本项目代码，也不代表完整导入了官方组件库。

| 参考内容 | 当前实现 |
| --- | --- |
| 主要/次要按钮层级 | `frontend/src/components/ui/button.tsx` 及项目 CSS |
| 细边框、内嵌式输入控件 | `frontend/src/components/ui/input.tsx` 及表单 CSS |
| 分段选择控件 | 页面中的语义化按钮组与胶囊外观 |
| 面板、侧栏和内容层次 | 应用外壳、工程列表、上传页与编辑器布局 |
| 字体层次与间距 | 本项目 CSS；Inter Variable 与 Noto Sans SC Variable，必要时回退系统字体 |

## 组件、字体与图标

- 基础组件采用 shadcn 风格的组合方式，并使用 Radix Slot 等行为能力；外观由本项目根据 Apple 参考独立实现。
- 没有引入其他图标库。当前的文字与符号按钮不等同于完整 SF Symbols 资源包。
- 用户已确认 Windows 使用接近 Apple 风格的可再分发字体。项目已接入 Inter Variable 和 Noto Sans SC Variable，分别处理拉丁文字与简体中文；它们不是 Apple 字体。
- 字体通过本地 Fontsource 依赖由 Vite 生成 WOFF2 资源，随应用构建打包，不依赖字体 CDN。OFL 许可文本随应用放在 `frontend/public/licenses/fonts`，源码包也保留这些文本。
- 没有把 SF 字体文件打包或重新分发；具体字重、中文回退和排版仍须在实际桌面窗口中核验。
- 桌面窗口使用 Windows 原生标题栏与窗口控制，保留 Windows 操作习惯。
- Apple 原始资源的使用遵循其原始许可；本说明不授予额外字体、图标或商标使用权。

## Figma 文件的实际状态

[当前 Figma 文件](https://www.figma.com/design/sg141llPQXOtAbekHRi9Mz/) 已完成三页实现截图参考，并已截图核验。三个节点均明确标为“实现参考（待绑定 Apple 官方组件）”，画布附有组件限制与字体说明。

| 实现参考 | 节点 |
| --- | --- |
| [工程列表](https://www.figma.com/design/sg141llPQXOtAbekHRi9Mz/?node-id=3-2) | `3:2` |
| [上传识别](https://www.figma.com/design/sg141llPQXOtAbekHRi9Mz/?node-id=4-2) | `4:2` |
| [工程编辑器](https://www.figma.com/design/sg141llPQXOtAbekHRi9Mz/?node-id=5-2) | `5:2` |

[较早草稿](https://www.figma.com/design/6e09rR5sHcrv0zKTRFK0NJ/) 只有三个空页面容器，已由上述实现参考文件取代作为交接入口。

Professional 账号的 Full/pro 权限已经确认，当前文件可写入普通节点。macOS 26 官方库已订阅，macOS 27 在可用库中，但二者导入均被拒绝，返回 `Not permitted to upsert from library`。这项限制不能再归因于账号配额；当前等待可访问的已有 Apple kit 文件链接，或解决工具的库导入权限。

当前交付范围是三页实现截图参考。可编辑的官方组件实例、组件库及可点击原型仍待完成；三页参考完成不代表官方组件绑定已经完成。本轮没有发布云端网站。

## 后续设计验收

三页参考来自已运行的浏览器前端。该环境已验证真实音频上传、Basic Pitch 转录、工程保存及 MIDI 导出；首音力度由 99 改为 90 后保存到 `revision=5`，导出文件解析结果为音高 60、力度 90，其余 5 音一致。这些验证不包含 Windows 原生窗口和保存对话框。

早期受限运行环境中的原生启动失败已复核：在正常 Windows 用户会话中，Electron 最小页面和 v0.1.1 生产界面均已加载，未出现 renderer/preload 错误。原生文件对话框、所有编辑手势和实际声音输出仍需进一步人工验收。

早期错误码 49 对应无法创建受限令牌；新的启动检查保留了 Electron 安全沙箱。完整测试记录与剩余验收范围见 [状态记录](STATUS.md)。

取得可访问的 Apple 组件文件或解决库导入权限后，确认可用字体，补齐颜色/间距变量、按钮和输入组件状态，并完成三页面及加载、空白、错误、部分结果、保存冲突等状态。随后与实际 Windows 桌面窗口逐项核对布局、键盘操作、拖动、声音和原生保存流程。

功能和验证边界见 [STATUS.md](STATUS.md)，后续设计提示词见 [FIGMA_BRIEF.md](FIGMA_BRIEF.md)。
