# 前端接入包

为前端提供 API 类型、HTTP 客户端、任务事件订阅和演示数据。项目应用使用 React + TypeScript + Vite；本包没有页面或样式，也不依赖 React。当前应用版本为 v0.1.3，接口前缀保持 `/api/v1`。

后端接口文档以正在运行的 `http://127.0.0.1:8000/docs` 为准。当前约定为 `/api/v1`，面向本机单用户开发。

## 1. 前端接入约定

页面实现或从 Figma 接入时，保持以下约定，不必更换现有 UI 组件库：

> 路由包括项目列表 `/projects`、上传 `/upload`、多轨编辑器 `/projects/:id`。服务端数据通过单独的 API 层读取，避免在页面中散落请求。工程、音轨、音符和任务的数据结构按提供的 TypeScript 文件生成。音符时间以秒保存，MIDI 音高和力度为整数。首版拍号固定 4/4，界面不提供其他拍号选项。音轨使用 kind 字段区分类别，但固定分轨类别不证明该乐器存在。为排队、处理、部分轨道完成、成功、失败、取消、断线重连、保存冲突和空项目设计明确状态。刷新页面后根据工程的 latestJobId 恢复任务状态。波形音频 URL 为 null 时显示“暂无音频”，不要伪造波形。演示工程始终显示“演示数据”。识别进度为 null 时使用不确定进度提示，不用倒计时制造进度。

生成前端后：

1. 将 `src/types.ts` 作为数据结构参考，保持字段名称与枚举值一致。
2. 页面设计阶段从 `@stem-studio/client/fixtures` 读取演示工程，明确显示 `DEMO_NOTICE`。
3. 接后端时引入 `StemStudioClient`；删除页面中的假进度和模拟请求。
4. 可用 TanStack Query 管服务端快照，Zustand 管本地音符编辑、选择和播放状态。它们是前端可选依赖，不由本包安装。
5. WaveSurfer 负责音频波形，Tone.js 负责 MIDI 试听，Canvas 负责音符网格；它们的播放器和编辑器实现属于接入阶段。

`createDemoProject()` 与 `createDemoJob()` 是两个独立的设计示例，分别展示完成状态和处理中状态，不应拼成一个真实的服务端快照。示例没有音频文件，所有音频 URL 均为 `null`，不要将演示 ID 提交到真实 API。

## 2. 安装与构建

先在 `frontend-kit` 目录中执行：

```bash
npm install
npm run typecheck
npm run build
```

然后在你的前端目录中安装这个本地包，路径按目录关系调整：

```bash
npm install ../frontend-kit
```

本包仅以编译后的 ESM 发布。修改 SDK 后重新运行 `npm run build`；包内没有 UI 运行时依赖。

## 3. 初始化与开发代理

推荐让浏览器通过 Vite 代理访问后端，方便普通请求、文件和 SSE 使用同一来源：

```ts
// vite.config.ts 的 server 配置，保留 Figma 前端已有的其他配置。
server: {
  proxy: {
    "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
  },
},
```

```ts
import { StemStudioClient } from "@stem-studio/client";

export const api = new StemStudioClient();
// 直接跨域调用时才设置 baseUrl，且后端要允许该前端来源：
// new StemStudioClient({ baseUrl: "http://127.0.0.1:8000" });
```

`baseUrl` 不含 `/api/v1`。同源部署传空字符串；代理前缀也可以作为 `baseUrl`。反向代理需要允许 SSE 长连接并关闭事件响应缓冲。

## 4. 创建、上传与取消

```ts
const project = await api.createProject({
  title: "我的第一首歌",
  bpm: 120,
  timeSignature: "4/4",
});

// file 来自 <input type="file">，是浏览器 File 对象。
const { job } = await api.uploadAudio(project.id, {
  file,
  mode: "demucs_basic_pitch",
  separationModel: "htdemucs",
  transcriptionModel: "basic_pitch",
  drumTranscription: "none",
  device: "auto",
  bpm: project.bpm,
});

// UI 的取消按钮：以返回的 job 状态更新界面。
await api.cancelJob(job.id);
```

新字段省略时仍使用 Basic Pitch，鼓 MIDI 默认关闭。4/6 轨是模型的固定输出类别，不能解释为检测到了 4/6 种乐器；四轨没有独立钢琴轨，六轨增加钢琴与吉他。鼓轨始终保留真实音频，默认无自动音符。

### 钢琴与镲片选项

```ts
// 用户已确认素材为钢琴与镲片，且本机对应能力可用。
const status = await api.getServiceStatus();
if (!status.capabilities.separate6 ||
    !status.capabilities.pianoTranscription ||
    !status.capabilities.cymbalOnsets) {
  throw new Error("本机尚未准备好所选识别方式");
}

const candidate = await api.uploadAudio(project.id, {
  file,
  mode: "demucs_basic_pitch",
  separationModel: "htdemucs_6s",
  transcriptionModel: "piano_highres",
  drumTranscription: "cymbal_onsets",
  device: "auto",
  bpm: project.bpm,
});
```

| 字段 | 可选值与约束 |
| --- | --- |
| `transcriptionModel` | `basic_pitch`（默认）或 `piano_highres`；后者在分轨模式必须配合 `htdemucs_6s`，只用于钢琴轨，其他有音高轨仍用 Basic Pitch |
| `drumTranscription` | `none`（默认）或 `cymbal_onsets`；后者只允许 `demucs_basic_pitch` 分轨模式 |

已知单钢琴录音可用 `mode: "transcribe_only"`、`transcriptionModel: "piano_highres"`、`drumTranscription: "none"`，结果为钢琴轨；通用单乐器录音仍可直接用 Basic Pitch。无效组合返回 HTTP 422。专用模型失败会明确报错，不会静默回退到 Basic Pitch。界面应依据服务能力禁用不可用选项；能力检查不保证随后每次推理一定成功。

`cymbal_onsets` 是需用户明确启用的镲片瞬态击打点提取，不是完整鼓组分类。默认 GM 49 是试听选择，不代表识别了镲片种类；短音符表示触发，不代表声音尾音。钢琴专用识别与应用 MIDI 暂不支持踏板 CC64。两种识别结果均需人工校对，不能用音符数量判断准确率。

支持 WAV、MP3、FLAC。上传普通 `Blob` 时必须同时传 `filename`，例如 `recording.wav`；浏览器 `File` 会保留原文件名。省略 `bpm` 时沿用项目 BPM。

`fetch` 上传接口不提供字节上传进度。上传阶段显示忙碌状态；识别阶段显示后端任务阶段与真实进度。`job.progress` 为 `0–1`，显示百分数时乘以 100；值为 `null` 时不显示确定百分比。不要把识别进度当上传进度。

## 5. 订阅任务与恢复连接

重新进入项目页时，先读取工程，再根据 `latestJobId` 查询最新任务。新项目的该字段为 `null`；上传后指向最新任务，即使任务已成功、失败或取消也会保留。终态任务只展示结果，无需重新订阅。不要只将 job ID 存在页面内存或浏览器缓存中，否则刷新后无法可靠恢复。

```ts
const restoredProject = await api.getProject(projectId);
const latestJob = restoredProject.latestJobId
  ? await api.getJob(restoredProject.latestJobId)
  : null;
// 仅当 latestJob.status 为 queued 或 running 时创建订阅。
```

```ts
const subscription = api.subscribeToJob(job.id, {
  onEvent(event) {
    if (event.type === "track.ready") {
      // event.data 是 Track。按 id 更新，不能无条件追加，避免重连后重复。
      console.log("轨道已就绪", event.data);
    } else {
      // 包括 updated、completed、failed 和 cancelled；data 均为 Job。
      console.log("任务状态", event.data);
    }
  },
  onConnectionChange(state) {
    console.log("事件连接", state);
  },
});

// 页面卸载、切换项目或切换任务时必须清理。
subscription.close();
```

SSE 事件名为 `job.updated`、`track.ready`、`job.completed`、`job.failed`、`job.cancelled`。终态事件到达后 SDK 自动关闭订阅。原生 EventSource 会在临时断线后自动重连，并将最后收到的 SSE `id` 通过 `Last-Event-ID` 告诉服务端。

注意：

- `onConnectionError` 表示事件连接出错，不代表识别任务失败。不要因此将项目标为失败。
- 新建 EventSource 实例不继承旧实例的事件位置；当前服务端会从起点重放历史事件。重新进入页面和每次连接恢复后，重新读取 `getJob` 与 `getProject`。
- 事件可能重放；按音轨 ID 合并。`getProject()` 是最终持久化状态的依据。
- 原生 EventSource 不支持自定义 Authorization 请求头。当前本机版本无需认证；未来若加入登录，采用同源 Cookie 或重新设计认证传输。
- TypeScript 提供编译时类型。SDK 对事件做 JSON 和基本 ID 检查，不替代完整运行时结构校验。

### React hook 示例

下面代码放入生成的前端。`api` 应在模块中创建，避免每次渲染创建新客户端；这里没有给 SDK 增加 React 依赖。

```tsx
import { useEffect, useState } from "react";
import type {
  ConnectionState, Job, JobSubscription, Project,
} from "@stem-studio/client";
import { api } from "./api";

const isTerminal = (job: Job) =>
  ["succeeded", "failed", "cancelled"].includes(job.status);

export function useProjectJob(projectId: string, refreshKey = 0) {
  const [job, setJob] = useState<Job | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshVersion = 0;
    let jobEventVersion = 0;
    let currentJobId: string | null = null;
    let subscription: JobSubscription | undefined;
    const controller = new AbortController();
    setJob(null);
    setProject(null);
    setError(null);
    setConnection("connecting");

    async function refresh() {
      const version = ++refreshVersion;
      const eventVersion = jobEventVersion;
      try {
        const options = { signal: controller.signal };
        const nextProject = await api.getProject(projectId, options);
        const nextJob = nextProject.latestJobId
          ? await api.getJob(nextProject.latestJobId, options)
          : null;
        if (disposed || version !== refreshVersion) return;
        const switchedJob = nextProject.latestJobId !== currentJobId;
        if (switchedJob) {
          subscription?.close();
          subscription = undefined;
          currentJobId = nextProject.latestJobId;
        }
        // A slow snapshot must not overwrite a newer streamed Job.
        if (switchedJob || eventVersion === jobEventVersion) setJob(nextJob);
        setProject(nextProject);
        setError(null);
        if (!nextJob || isTerminal(nextJob)) {
          subscription?.close();
          setConnection("closed");
          return;
        }
        if (!subscription) subscribe(nextJob.id);
      } catch (cause) {
        if (!disposed && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    function subscribe(jobId: string) {
      subscription = api.subscribeToJob(jobId, {
        onEvent(event) {
          if (disposed || currentJobId !== jobId) return;
          if (event.type === "track.ready") {
            void refresh();
          } else {
            jobEventVersion += 1;
            const nextJob = event.data;
            // A new connection replays history: avoid replacing a newer snapshot.
            setJob(previous => previous?.id === nextJob.id &&
              Date.parse(previous.updatedAt) > Date.parse(nextJob.updatedAt)
              ? previous : nextJob);
            if (isTerminal(nextJob)) void refresh();
          }
        },
        onConnectionChange(state) {
          if (disposed) return;
          setConnection(state);
          if (state === "open") void refresh();
        },
        onInvalidEvent(cause) {
          if (!disposed) setError(cause.message);
        },
      });
    }
    void refresh();

    return () => {
      disposed = true;
      controller.abort();
      subscription?.close();
    };
  }, [projectId, refreshKey]);

  return { job, project, connection, error };
}
```

这个 hook 自动通过 `latestJobId` 恢复任务，用于任务处理页面的服务端快照。同一页面再次上传成功后，增加 `refreshKey` 以加载新的任务。完成后进入编辑模式，将已读取工程复制到本地草稿。后台快照刷新时不能直接覆盖用户正在编辑的草稿。

## 6. 保存与冲突

保存提交完整 `tracks` 数组，包含所有需要保留的音轨。成功后必须保存服务端返回的新 `revision`，下一次提交使用它。

```ts
import { ApiError } from "@stem-studio/client";

try {
  const saved = await api.saveProject(project.id, {
    expectedRevision: project.revision,
    title: draft.title,
    bpm: draft.bpm,
    timeSignature: draft.timeSignature,
    tracks: draft.tracks,
  });
  // 将 saved 作为新的已保存快照；保留其 revision。
} catch (error) {
  if (error instanceof ApiError && error.status === 409) {
    // 保留本地草稿，读取最新工程并让用户选择重新载入或合并。
    // 不要自动拿新 revision 重试覆盖远端。
  } else {
    throw error;
  }
}
```

API 错误通过 `ApiError.status`、`ApiError.detail` 和 `ApiError.body` 提供 HTTP 状态码、原始 FastAPI detail 和完整响应。网络异常及取消请求保留浏览器原有错误类型。

## 7. 试听与导出

```tsx
// 只在真实音频存在时挂载播放器。
const audioUrl = api.resolveAssetUrl(track.audioUrl);
const audio = audioUrl ? <audio src={audioUrl} controls /> : <p>暂无音频</p>;

// 工程的最新已保存版本导出；导出前先保存本地草稿。
const exportLink = <a href={api.projectMidiUrl(project.id)}>导出多轨 MIDI</a>;
const trackLink = <a href={api.trackMidiUrl(project.id, track.id)}>导出本轨 MIDI</a>;
```

原音频和分离音频不会因编辑 MIDI 音符而改变。界面应提供“音频试听”和“MIDI 试听”两种模式，并显示当前模式。多个独立 `<audio>` 不足以实现精确多轨同步；正式播放器应使用统一时钟。

鼓轨根据 `isDrum` 使用 MIDI 第 10 通道（程序中的 channel 9），不要把 `program` 当作镲片音高。当前编辑器提供 GM 42、46、49、51 的整轨鼓点音高更改，作为一次可撤销编辑；变更 `notes[].pitch` 后按正常工程保存。导出保留同音高的相邻鼓点攻击，必要时缩短前一音符，不合并击打。有音高轨的同音重叠音符在试听与导出时合并，但不改写工程编辑数据。

`originalAudioUrl()`、`trackAudioUrl()`、`projectMidiUrl()`、`trackMidiUrl()` 只是构造真实接口地址，不保证对应资源已经生成。根据 `sourceAudioUrl`、`track.audioUrl`、`transcriptionStatus` 和真实音符决定按钮是否可用。

音符坐标：`x = startSeconds * pixelsPerSecond`，`width = durationSeconds * pixelsPerSecond`。首版 `timeSignature` 固定为 `"4/4"`，BPM 以四分音符为单位，网格间隔为 `60 / bpm` 秒，一小节为 `(60 / bpm) * 4` 秒。修改 BPM 默认保持音符秒数不变，仅改变网格与 MIDI 时间映射；整曲变速需要单独实现。

## 接口速查

| SDK 方法 | HTTP |
| --- | --- |
| `health()` | `GET /api/v1/health` |
| `getServiceStatus()` | `GET /api/v1/system/status` |
| `listProjects()` | `GET /api/v1/projects` |
| `createProject(input)` | `POST /api/v1/projects` |
| `getProject(id)` | `GET /api/v1/projects/{id}` |
| `saveProject(id, input)` | `PUT /api/v1/projects/{id}` |
| `uploadAudio(id, input)` | `POST /api/v1/projects/{id}/audio`，multipart |
| `getJob(id)` | `GET /api/v1/jobs/{id}` |
| `cancelJob(id)` | `POST /api/v1/jobs/{id}/cancel` |
| `subscribeToJob(id, handlers)` | `GET /api/v1/jobs/{id}/events`，SSE |
| `projectMidiUrl(id)` | `GET /api/v1/projects/{id}/export.mid` |
| `originalAudioUrl(id)` | `GET /api/v1/projects/{id}/audio/original` |
| `trackAudioUrl(id, trackId)` | `GET /api/v1/projects/{id}/tracks/{trackId}/audio` |
| `trackMidiUrl(id, trackId)` | `GET /api/v1/projects/{id}/tracks/{trackId}/export.mid` |

## 音频分析元数据（自 v0.1.2）

Track 新增可选 `analysis`：`rmsDbfs`、`peakDbfs`、`relativeRmsDb`、`lowSignal`、`autoTranscriptionSkipped`。旧工程可省略或为 null。电平用于判断近乎静音的分离残留，不是乐器分类置信度；数字静音使用 -240 dBFS 有限下限。字段由服务器计算，保存时依据原 track.id 保留，客户端不得覆盖。

音轨名称是分离模型固定输出类别。低信号轨保留音频和编辑能力；`autoTranscriptionSkipped=true` 表示自动识别被跳过，`transcriptionStatus=completed` 与空 notes 同时合法。用户手动添加音符后也不能从该标记推断当前 notes 必为空。

## 转录来源元数据（v0.1.3）

`Track.transcriptionEngine` 可为 `basic_pitch`、`piano_highres`、`cymbal_onsets`、`null` 或省略。它记录实际转录方式，不应从轨道名称或 `kind` 猜测。旧工程可以没有该字段；近静音跳过转录的轨道也可以没有模型来源。与 `analysis` 一样，此字段由服务端维护，保存时按原 track.id 保留，客户端不得覆盖。

真实候选「001 旋律 · 钢琴专用与镲片」已验证 25.34 秒输入、6 条可读 WAV、67 个钢琴预测音符和 4 个镲片击打点；MIDI 回读 71 个 note-on，6 个原工程未改变。这是链路验证，不是识别准确率保证。完整回归与打包结果见 [STATUS.md](../docs/STATUS.md)。
