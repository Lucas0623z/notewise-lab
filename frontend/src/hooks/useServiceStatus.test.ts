import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "../types";

vi.mock("../services/api", () => ({
  api: { getServiceStatus: vi.fn() },
  DEMO: false,
  getErrorMessage: (error: unknown) => String(error),
}));

import {
  getRecognitionAvailability,
  serviceStatusQueryOptions,
} from "./useServiceStatus";

const ready: ServiceStatus = {
  status: "ready",
  apiReady: true,
  workerReady: true,
  capabilities: { transcribeOnly: true, separate4: true, separate6: false },
  message: "服务已就绪",
};

describe("recognition service readiness", () => {
  it("blocks upload during setup and failure even if an old API reports ready", () => {
    for (const stage of [
      "preparing",
      "downloading",
      "installing",
      "verifying",
      "failed",
    ] as const) {
      const availability = getRecognitionAvailability(
        {
          ...ready,
          setup: {
            stage,
            message: "真实准备状态",
            bytesDownloaded: null,
            totalBytes: null,
          },
        },
        "transcribe_only",
        "htdemucs",
      );
      expect(availability.ready).toBe(false);
      expect(availability.message).toBe("真实准备状态");
      expect(availability.state).toBe(
        stage === "failed" ? "unavailable" : "starting",
      );
    }
  });
  it("requires the chosen piano engine and never silently falls back to Basic Pitch", () => {
    expect(
      getRecognitionAvailability(
        ready,
        "transcribe_only",
        "htdemucs",
        false,
        "piano_highres",
      ).ready,
    ).toBe(false);
    const pianoOnly = {
      ...ready,
      capabilities: {
        ...ready.capabilities,
        transcribeOnly: false,
        pianoTranscription: true,
      },
    };
    expect(
      getRecognitionAvailability(
        pianoOnly,
        "transcribe_only",
        "htdemucs",
        false,
        "piano_highres",
      ).ready,
    ).toBe(true);
    expect(
      getRecognitionAvailability(
        pianoOnly,
        "transcribe_only",
        "htdemucs",
        false,
        "basic_pitch",
      ).ready,
    ).toBe(false);
  });
  it("requires six stems for separated piano transcription", () => {
    const capable = {
      ...ready,
      capabilities: {
        ...ready.capabilities,
        separate6: true,
        pianoTranscription: true,
      },
    };
    expect(
      getRecognitionAvailability(
        capable,
        "demucs_basic_pitch",
        "htdemucs",
        false,
        "piano_highres",
      ).ready,
    ).toBe(false);
    expect(
      getRecognitionAvailability(
        capable,
        "demucs_basic_pitch",
        "htdemucs_6s",
        false,
        "piano_highres",
      ).ready,
    ).toBe(true);
  });
  it("requires both separation mode and live cymbal capability for requested drum events", () => {
    expect(
      getRecognitionAvailability(
        ready,
        "demucs_basic_pitch",
        "htdemucs",
        false,
        "basic_pitch",
        "cymbal_onsets",
      ).ready,
    ).toBe(false);
    const capable = {
      ...ready,
      capabilities: { ...ready.capabilities, cymbalOnsets: true },
    };
    expect(
      getRecognitionAvailability(
        capable,
        "demucs_basic_pitch",
        "htdemucs",
        false,
        "basic_pitch",
        "cymbal_onsets",
      ).ready,
    ).toBe(true);
    expect(
      getRecognitionAvailability(
        capable,
        "transcribe_only",
        "htdemucs",
        false,
        "basic_pitch",
        "cymbal_onsets",
      ).ready,
    ).toBe(false);
    expect(
      getRecognitionAvailability(
        capable,
        "demucs_basic_pitch",
        "htdemucs",
        true,
        "basic_pitch",
        "cymbal_onsets",
      ).ready,
    ).toBe(false);
  });
  it("checks the local service even when the device has no internet connection", async () => {
    const client = new QueryClient();
    const wasOnline = onlineManager.isOnline();
    onlineManager.setOnline(false);
    const loadStatus = vi
      .fn<() => Promise<ServiceStatus>>()
      .mockResolvedValue(ready);
    try {
      const observer = new QueryObserver(
        client,
        serviceStatusQueryOptions(loadStatus),
      );
      const result = await observer.refetch();
      expect(loadStatus).toHaveBeenCalledOnce();
      expect(result.data).toEqual(ready);
      expect(result.fetchStatus).toBe("idle");
    } finally {
      onlineManager.setOnline(wasOnline);
      client.clear();
    }
  });

  it("checks the selected mode without treating partial capabilities as full support", () => {
    expect(
      getRecognitionAvailability(ready, "transcribe_only", "htdemucs_6s").ready,
    ).toBe(true);
    expect(
      getRecognitionAvailability(ready, "demucs_basic_pitch", "htdemucs").ready,
    ).toBe(true);
    expect(
      getRecognitionAvailability(ready, "demucs_basic_pitch", "htdemucs_6s"),
    ).toMatchObject({
      ready: false,
      title: "当前识别方式不可用",
    });
    expect(
      getRecognitionAvailability(
        {
          ...ready,
          capabilities: { ...ready.capabilities, transcribeOnly: false },
        },
        "transcribe_only",
        "htdemucs",
      ).ready,
    ).toBe(false);
  });

  it("requires both service and worker readiness even if capability flags are true", () => {
    for (const status of [
      { ...ready, apiReady: false },
      { ...ready, workerReady: false },
      { ...ready, status: "starting" as const },
      { ...ready, status: "unavailable" as const },
    ]) {
      expect(
        getRecognitionAvailability(status, "demucs_basic_pitch", "htdemucs")
          .ready,
      ).toBe(false);
    }
    expect(
      getRecognitionAvailability(undefined, "demucs_basic_pitch", "htdemucs"),
    ).toMatchObject({ ready: false, state: "checking" });
  });

  it("blocks cached ready data after a failed poll, then recovers on a successful retry", async () => {
    const client = new QueryClient();
    const loadStatus = vi
      .fn<() => Promise<ServiceStatus>>()
      .mockResolvedValue(ready);
    const observer = new QueryObserver(
      client,
      serviceStatusQueryOptions(loadStatus),
    );
    try {
      const initial = await observer.refetch();
      expect(
        getRecognitionAvailability(
          initial.data,
          "demucs_basic_pitch",
          "htdemucs",
          initial.isError,
        ).ready,
      ).toBe(true);
      loadStatus.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const disconnected = await observer.refetch();
      expect(disconnected.data).toEqual(ready);
      expect(disconnected.isError).toBe(true);
      expect(
        getRecognitionAvailability(
          disconnected.data,
          "demucs_basic_pitch",
          "htdemucs",
          disconnected.isError,
        ).ready,
      ).toBe(false);
      const recovered = await observer.refetch();
      expect(
        getRecognitionAvailability(
          recovered.data,
          "demucs_basic_pitch",
          "htdemucs",
          recovered.isError,
        ).ready,
      ).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("rechecks before upload and detects a worker that stopped after the form became ready", async () => {
    const client = new QueryClient();
    const loadStatus = vi
      .fn<() => Promise<ServiceStatus>>()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({
        ...ready,
        status: "unavailable",
        workerReady: false,
        message: "识别进程已停止",
      });
    const observer = new QueryObserver(
      client,
      serviceStatusQueryOptions(loadStatus),
    );
    try {
      await observer.refetch();
      const fresh = await observer.refetch({ cancelRefetch: false });
      expect(loadStatus).toHaveBeenCalledTimes(2);
      expect(
        getRecognitionAvailability(
          fresh.data,
          "demucs_basic_pitch",
          "htdemucs",
        ),
      ).toMatchObject({
        ready: false,
        message: "识别进程已停止",
      });
    } finally {
      client.clear();
    }
  });
});
