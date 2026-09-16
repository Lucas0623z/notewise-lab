import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import {
  HashRouter,
  NavLink,
  Navigate,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectsPage } from "./pages/ProjectsPage";
import { UploadPage } from "./pages/UploadPage";
import { EditorPage } from "./pages/EditorPage";
import { Button } from "./components/ui/button";
import { DEMO } from "./services/api";
import "./fonts.css";
import "./styles.css";
import "./apple-ui.css";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000,
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});
function App() {
  const location = useLocation();
  const editor = /^\/projects\/[^/]+/.test(location.pathname);
  const [dark, setDark] = useState(
    () => localStorage.getItem("stem-theme") === "dark",
  );
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return (
    <div className={`app ${editor ? "app-editor" : ""}`}>
      <div className="mode-banner">
        <span className={`connection-dot ${DEMO ? "demo" : ""}`} />
        {DEMO ? "演示数据 · 未连接识别服务" : "本机识别服务"}
        <span className="banner-trailing">NoteWise Lab · 桌面版</span>
        <button
          aria-label={dark ? "切换浅色模式" : "切换深色模式"}
          onClick={() => {
            localStorage.setItem("stem-theme", dark ? "light" : "dark");
            setDark(!dark);
          }}
        >
          {dark ? "浅色" : "深色"}
        </button>
      </div>
      <div className="app-body">
        {!editor && (
          <aside className="sidebar">
            <div className="brand">
              <img
                className="brand-mark"
                src="/branding/zhiyinlab-logo.png"
                alt=""
                aria-hidden="true"
              />
              <div>
                <strong>NoteWise Lab</strong>
                <span>智音lab · 音乐创作空间</span>
              </div>
            </div>
            <div className="nav-label">工作区</div>
            <nav>
              <NavLink to="/projects">项目</NavLink>
              <NavLink to="/upload">新建转录</NavLink>
            </nav>
            <div className="sidebar-bottom">
              <div className="sidebar-avatar">本</div>
              <div>
                <strong>本地工作区</strong>
                <span>{DEMO ? "演示模式" : "已配置识别服务"}</span>
              </div>
            </div>
          </aside>
        )}
        <main className="main">
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/projects/:id" element={<EditorPage />} />
            <Route path="*" element={<Navigate replace to="/projects" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="page-content">
          <h1>界面暂时无法显示</h1>
          <p>{this.state.error}</p>
          <Button onClick={() => location.reload()}>重新加载</Button>
        </div>
      );
    return this.props.children;
  }
}
const reactRoot =
  import.meta.hot?.data.reactRoot ??
  ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot;
reactRoot.render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
