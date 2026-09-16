import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, DEMO, getErrorMessage } from "../services/api";
import type { ServiceStatus, UploadAudioInput } from "../types";

type RecognitionMode = NonNullable<UploadAudioInput["mode"]>;
type SeparationModel = NonNullable<UploadAudioInput["separationModel"]>;
type TranscriptionModel = NonNullable<UploadAudioInput["transcriptionModel"]>;
type DrumTranscription = NonNullable<UploadAudioInput["drumTranscription"]>;

export interface RecognitionAvailability {
  ready: boolean;
  state: "checking" | "starting" | "ready" | "unavailable";
  title: string;
  message: string;
}

/** A successful older response is not permission to upload after a failed check. */
export function getRecognitionAvailability(
  status: ServiceStatus | undefined,
  mode: RecognitionMode,
  model: SeparationModel,
  checkFailed = false,
  transcriptionModel: TranscriptionModel = "basic_pitch",
  drumTranscription: DrumTranscription = "none",
): RecognitionAvailability {
  if (checkFailed) {
    return {
      ready: false,
      state: "unavailable",
      title: "无法连接本机识别服务",
      message:
        "尚未确认服务可用，已暂停上传。正在自动重试，你也可以手动重新检查。",
    };
  }
  if (!status) {
    return {
      ready: false,
      state: "checking",
      title: "正在连接本机识别服务",
      message: "确认服务和识别能力后，即可上传音频。",
    };
  }
  if (status.setup && status.setup.stage !== "complete") {
    const titles = {
      preparing: "正在准备首次识别环境",
      downloading: "正在下载识别组件",
      installing: "正在安装识别组件",
      verifying: "正在检查识别环境",
      failed: "识别环境准备失败",
    };
    return {
      ready: false,
      state: status.setup.stage === "failed" ? "unavailable" : "starting",
      title: titles[status.setup.stage],
      message: status.setup.message || status.message,
    };
  }
  if (status.status !== "ready" || !status.apiReady || !status.workerReady) {
    const starting = status.status === "starting";
    return {
      ready: false,
      state: starting ? "starting" : "unavailable",
      title: starting ? "本机识别服务正在准备" : "本机识别服务尚未就绪",
      message:
        status.message ||
        (!status.apiReady
          ? "等待本机服务连接，准备完成后会自动更新。"
          : "尚未检测到可用的识别进程，准备完成后会自动更新。"),
    };
  }
  const capability =
    mode === "transcribe_only"
      ? transcriptionModel === "piano_highres"
        ? "pianoTranscription"
        : "transcribeOnly"
      : model === "htdemucs_6s"
        ? "separate6"
        : "separate4";
  if (!status.capabilities[capability]) {
    const label =
      capability === "pianoTranscription"
        ? "钢琴专用识别"
        : capability === "transcribeOnly"
          ? "直接识别音符"
          : capability === "separate6"
            ? "实验 6 轨"
            : "标准 4 轨";
    return {
      ready: false,
      state: "unavailable",
      title: "当前识别方式不可用",
      message: `本机服务尚不支持「${label}」。请切换到已就绪的识别方式，或完成本机识别环境配置后重新检查。`,
    };
  }
  const selectionIssue =
    transcriptionModel === "piano_highres" &&
    mode === "demucs_basic_pitch" &&
    model !== "htdemucs_6s"
      ? "钢琴专用识别需要实验 6 轨分离，或使用单钢琴录音直接识别。"
      : transcriptionModel === "piano_highres" &&
          !status.capabilities.pianoTranscription
        ? "钢琴专用识别尚未就绪。请完成该模型配置或主动选择通用识别；应用不会自动换用其他引擎。"
        : drumTranscription === "cymbal_onsets" && mode !== "demucs_basic_pitch"
          ? "镲片击打点检测需要先分离鼓轨，请选择分轨并识别。"
          : drumTranscription === "cymbal_onsets" &&
              !status.capabilities.cymbalOnsets
            ? "镲片击打点检测尚未就绪。请完成本机配置或关闭该选项；应用不会跳过所选检测。"
            : null;
  if (selectionIssue)
    return {
      ready: false,
      state: "unavailable",
      title: "当前识别选项尚未就绪",
      message: selectionIssue,
    };
  return {
    ready: true,
    state: "ready",
    title: "本机识别已就绪",
    message: status.message || "可以上传音频并开始识别。",
  };
}

/** Shared with the imperative pre-upload check so no cached ready state skips it. */
export const serviceStatusQueryOptions = (
  loadStatus: () => Promise<ServiceStatus> = () => api.getServiceStatus(),
) =>
  queryOptions({
    queryKey: ["service-status"],
    queryFn: loadStatus,
    // Losing internet access does not make a local API unreachable.
    networkMode: "always",
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.status === "success" && query.state.data?.status === "ready"
        ? 5000
        : 2500,
    refetchOnWindowFocus: true,
  });

export function useServiceStatus(
  mode: RecognitionMode,
  model: SeparationModel,
  transcriptionModel: TranscriptionModel = "basic_pitch",
  drumTranscription: DrumTranscription = "none",
) {
  const query = useQuery({ ...serviceStatusQueryOptions(), enabled: !DEMO });
  const availability = getRecognitionAvailability(
    query.data,
    mode,
    model,
    query.isError,
    transcriptionModel,
    drumTranscription,
  );

  async function checkBeforeUpload() {
    if (DEMO) throw new Error("请先启用本机识别，再上传音频。");
    const fresh = await query.refetch({ cancelRefetch: false });
    if (fresh.isError) throw new Error(getErrorMessage(fresh.error));
    const current = getRecognitionAvailability(
      fresh.data,
      mode,
      model,
      false,
      transcriptionModel,
      drumTranscription,
    );
    if (!current.ready) throw new Error(current.message);
  }

  return {
    status: query.data,
    availability,
    isChecking: query.isFetching,
    error: query.error,
    retry: () => query.refetch({ cancelRefetch: false }),
    checkBeforeUpload,
  };
}
