# 桌面版字体

本项目按已确认的 Windows 字体方案，随应用分发以下开源字体。它们是界面的替代字体，不是 Apple SF Pro 或苹方。

| 用途 | 字体 | npm 包 | 版本 | 许可 |
| --- | --- | --- | --- | --- |
| 拉丁字母、数字 | Inter Variable | `@fontsource-variable/inter` | 5.3.0 | SIL Open Font License 1.1 |
| 简体中文 | Noto Sans SC Variable | `@fontsource-variable/noto-sans-sc` | 5.3.0 | SIL Open Font License 1.1 |

## 接入

`frontend/src/fonts.css` 导入两个包的本地 `@font-face`，并提供统一变量：

```css
font-family: var(--font-ui);
/* 'Inter Variable', 'Noto Sans SC Variable', sans-serif */
```

前端入口应先导入 `./fonts.css`，页面与组件使用该变量。字体的 normal 样式覆盖 100–900 的可变字重；拉丁字符优先使用 Inter，中文由 Noto Sans SC 覆盖。

Vite 会把字体文件写入应用资源。运行时不请求字体 CDN，也不依赖用户预先安装字体。按 `unicode-range` 分片加载，实际使用到的字形才会触发相应分片读取。

Canvas 从容器的计算后 `fontFamily` 读取相同字体栈；字体加载完成后重画，避免首次使用系统回退字体的画面一直留在缓存中。

## 分发与许可文件

- [Inter-LICENSE.txt](./Inter-LICENSE.txt)：来自 Inter 包的原始许可证。
- [Noto-Sans-SC-LICENSE.txt](./Noto-Sans-SC-LICENSE.txt)：来自 Noto Sans SC 包的原始许可证。

两份文件也保存在 `frontend/public/licenses/fonts/`，会随 Vite 产物和 Electron 应用一同分发。复制文件与包内原件的 SHA-256 校验一致。

## 体积记录

2026-09-15 对 `fonts.css` 单独进行 Vite 生产构建验证：

| 产物 | 文件数 | 字节 |
| --- | ---: | ---: |
| Inter 外部 WOFF2 | 7 | 218,512 |
| Noto Sans SC 外部 WOFF2 | 98 | 4,507,216 |
| 字体 CSS（含少量内嵌字体） | 1 | 110,299 |
| 两份许可原文 | 2 | 8,791 |

新增资源总计约 **4.84 MB**（约 4.62 MiB），不包含 JavaScript 或 Electron 运行时。字体 CSS 的构建 gzip 大小约 44.57 kB。完整应用构建可能合并 CSS，最终文件名与 CSS 压缩体积会变化。
