import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api, DEMO, getErrorMessage } from "../services/api";
import type { Project } from "../types";
import { TRACK_COLORS } from "../lib/tracks";

const labels: Record<Project["status"], string> = {
  empty: "等待上传",
  queued: "排队中",
  processing: "正在处理",
  ready: "可编辑",
  failed: "处理失败",
  cancelled: "已取消",
};
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function ProjectPreview({ project }: { project: Project }) {
  return (
    <div className="project-preview" aria-hidden="true">
      <div className="preview-grid" />
      {project.tracks.flatMap((track) =>
        track.notes
          .slice(0, 40)
          .map((note) => (
            <span
              className="preview-note"
              key={`${track.id}-${note.id}`}
              style={{
                left: `${Math.min(98, (note.startSeconds / Math.max(project.durationSeconds, 1)) * 100)}%`,
                width: `${Math.max(0.6, Math.min(20, (note.durationSeconds / Math.max(project.durationSeconds, 1)) * 100))}%`,
                top: `${16 + (84 - note.pitch) * 1.3}%`,
                background: TRACK_COLORS[track.kind],
              }}
            />
          )),
      )}
      {!project.tracks.some((track) => track.notes.length) && (
        <span className="preview-empty">
          {project.status === "processing" || project.status === "queued"
            ? "等待真实识别结果"
            : "尚无音符"}
        </span>
      )}
    </div>
  );
}

export function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    retry: 1,
    refetchInterval: (q) =>
      q.state.data?.items.some(
        (p) => p.status === "queued" || p.status === "processing",
      )
        ? 5000
        : false,
  });
  const projects = useMemo(
    () =>
      (query.data?.items ?? []).filter((project) => {
        const matchesStatus =
          filter === "all" ||
          (filter === "processing"
            ? ["queued", "processing"].includes(project.status)
            : project.status === filter);
        return (
          matchesStatus &&
          project.title
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase())
        );
      }),
    [query.data, search, filter],
  );

  return (
    <div className="projects-page page-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">你的音乐工作区</p>
          <h1>我的项目</h1>
          <p className="page-subtitle">从一段声音开始，留下每一个灵感。</p>
        </div>
        <Link to="/upload" className="primary button-link">
          <span aria-hidden="true">＋</span> 上传音频
        </Link>
      </header>
      {DEMO && (
        <div className="notice demo-notice">
          <span className="badge">演示模式</span>
          <span>
            示例音符由程序合成，未运行 AI 识别。编辑会保存在本机应用。
          </span>
        </div>
      )}
      <div className="project-toolbar">
        <div className="search-field">
          <Input
            aria-label="搜索项目"
            placeholder="搜索项目…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <label className="filter-label">
          <span className="sr-only">筛选项目状态</span>
          <select
            aria-label="筛选项目状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部项目</option>
            <option value="processing">处理中</option>
            <option value="ready">可编辑</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <span className="hint project-count">
          {query.data ? `${projects.length} 个项目 · 最近更新` : "正在读取项目"}
        </span>
      </div>
      {query.error && (
        <div className="error" role="alert">
          <div>
            <strong>项目暂时无法加载</strong>
            <p>{getErrorMessage(query.error)}</p>
            {query.data && <p>以下显示上次读取的项目，可能不是最新状态。</p>}
          </div>
          <Button
            variant="secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            重新加载
          </Button>
        </div>
      )}
      {query.isLoading && (
        <div
          className="project-grid"
          aria-label="正在加载项目"
          aria-busy="true"
        >
          {[0, 1, 2].map((key) => (
            <div key={key} className="project-card skeleton-card">
              <div className="skeleton skeleton-preview" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          ))}
        </div>
      )}
      {!query.isLoading && query.data && !projects.length && (
        <div className="panel empty-state">
          <div className="empty-symbol" aria-hidden="true">
            ♪
          </div>
          <h2>
            {query.data.items.length
              ? "没有匹配的项目"
              : "在这里开始第一首作品"}
          </h2>
          <p className="page-subtitle">
            {query.data.items.length
              ? "试试其他名称，或者清除筛选条件。"
              : "上传音频，分离音轨，再把听见的旋律变成可编辑的音符。"}
          </p>
          {query.data.items.length ? (
            <Button
              variant="secondary"
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              清除筛选
            </Button>
          ) : (
            <Link className="primary button-link" to="/upload">
              上传音频
            </Link>
          )}
        </div>
      )}
      {!!projects.length && (
        <div className="project-grid">
          {projects.map((project) => {
            const partial =
              ["failed", "cancelled"].includes(project.status) &&
              project.tracks.length > 0;
            return (
              <Link
                to={`/projects/${encodeURIComponent(project.id)}`}
                key={project.id}
                className="project-card"
                aria-label={`${project.title}，${labels[project.status]}${partial ? "，保留部分结果" : ""}`}
              >
                <ProjectPreview project={project} />
                <div className="project-card-body">
                  <div className="project-card-heading">
                    <h2>{project.title}</h2>
                    {DEMO && <span className="badge demo-badge">示例</span>}
                  </div>
                  <div className="project-meta">
                    <span>{duration(project.durationSeconds)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{project.tracks.length} 条音轨</span>
                    <span aria-hidden="true">·</span>
                    <span>{project.bpm} BPM</span>
                  </div>
                  <div className="project-card-footer">
                    <span className={`status-badge status-${project.status}`}>
                      {partial ? "部分结果" : labels[project.status]}
                    </span>
                    <time dateTime={project.updatedAt}>
                      {new Date(project.updatedAt).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {query.data && (
        <p className="workspace-footnote hint">
          {DEMO
            ? "演示工程没有录音文件；可试听和导出合成 MIDI 音符。"
            : "音频与工程保存在本机。BPM 为工程设置值，未自动检测。"}
        </p>
      )}
    </div>
  );
}
