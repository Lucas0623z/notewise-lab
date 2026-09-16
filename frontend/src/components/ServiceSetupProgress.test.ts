import { describe, expect, it } from "vitest";
import { setupDownloadProgress } from "./ServiceSetupProgress";

describe("actual setup download progress", () => {
  it("uses actual byte counts only when a valid total is known", () => {
    expect(
      setupDownloadProgress({
        stage: "downloading",
        message: "model",
        bytesDownloaded: 512,
        totalBytes: 1024,
      }),
    ).toEqual({ value: 512, max: 1024, label: "已下载 512 B / 1.0 KB" });
  });
  it("does not manufacture a percentage for pip or unknown download lengths", () => {
    expect(
      setupDownloadProgress({
        stage: "installing",
        message: "pip",
        bytesDownloaded: null,
        totalBytes: null,
      }),
    ).toEqual({ value: undefined, max: undefined, label: null });
    expect(
      setupDownloadProgress({
        stage: "downloading",
        message: "model",
        bytesDownloaded: 512,
        totalBytes: null,
      }),
    ).toEqual({ value: undefined, max: undefined, label: "已下载 512 B" });
  });
  it("discards impossible or nonfinite totals instead of displaying false completion", () => {
    for (const totalBytes of [0, 10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const progress = setupDownloadProgress({
        stage: "downloading",
        message: "model",
        bytesDownloaded: 512,
        totalBytes,
      });
      expect(progress.value).toBeUndefined();
      expect(progress.max).toBeUndefined();
    }
  });
});
