import type { ServiceStatus } from "../types";

type Setup = NonNullable<ServiceStatus["setup"]>;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Only measured byte counts produce a determinate bar, never elapsed time. */
export function setupDownloadProgress(setup: Setup) {
  const received = setup.bytesDownloaded;
  const total = setup.totalBytes;
  const validReceived =
    typeof received === "number" && Number.isFinite(received) && received >= 0;
  const knownTotal =
    validReceived &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0 &&
    received <= total;
  return {
    value: knownTotal ? received : undefined,
    max: knownTotal ? total : undefined,
    label:
      setup.stage === "downloading" && validReceived
        ? `已下载 ${formatBytes(received)}${knownTotal ? ` / ${formatBytes(total)}` : ""}`
        : null,
  };
}

export function ServiceSetupProgress({ setup }: { setup: Setup }) {
  if (setup.stage === "complete") return null;
  const failed = setup.stage === "failed";
  const progress = setupDownloadProgress(setup);
  return (
    <div className="service-setup-progress">
      {!failed && (
        <>
          <progress
            aria-label="识别环境准备进度"
            value={progress.value}
            max={progress.max}
          />
          {progress.label && <p className="hint">{progress.label}</p>}
          <p className="hint">
            首次准备需要联网。关闭窗口后会继续，重新打开可查看进度。
          </p>
        </>
      )}
      {failed && (
        <>
          <p className="hint">可点击“重试连接”重新准备识别环境。</p>
          {(setup.logPath || setup.logTail) && (
            <details className="service-setup-log">
              <summary>查看安装日志</summary>
              {setup.logPath && <p className="hint">{setup.logPath}</p>}
              {setup.logTail && <pre>{setup.logTail}</pre>}
            </details>
          )}
        </>
      )}
    </div>
  );
}
