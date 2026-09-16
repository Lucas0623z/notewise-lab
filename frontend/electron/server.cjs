"use strict";

const http = require("node:http");
const path = require("node:path");
const { realpath, stat } = require("node:fs/promises");
const { createReadStream } = require("node:fs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "cache-control",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
  "content-disposition",
  "x-accel-buffering",
]);
const MAX_REQUEST_BYTES = 101 * 1024 * 1024;

function backendOrigin() {
  const target = new URL(
    process.env.STEM_STUDIO_API_ORIGIN || "http://127.0.0.1:8000",
  );
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("STEM_STUDIO_API_ORIGIN 仅接受 http://127.0.0.1:端口。");
  }
  return target;
}

function respond(res, status, detail) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ detail }));
}

/** Static renderer host and same-origin API transport only. No jobs, data store or model logic. */
async function startLocalServer(distDirectory, options = {}) {
  const root = await realpath(distDirectory);
  const backend = backendOrigin();
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const address = new URL(origin);
      if (
        req.headers.host !== address.host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] &&
          !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
      ) {
        respond(res, 403, "不接受来自其他页面的请求。");
        return;
      }
      const url = new URL(req.url || "/", origin);
      if (url.origin !== origin) {
        respond(res, 403, "不允许的请求地址。");
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          url.pathname === "/api/v1/system/status" &&
          req.method === "GET" &&
          options.serviceStatus
        ) {
          const status = await options.serviceStatus();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(status));
          return;
        }
        if (!["GET", "HEAD", "POST", "PUT"].includes(req.method)) {
          respond(res, 405, "请求方法不支持。");
          return;
        }
        if (Number(req.headers["content-length"] || 0) > MAX_REQUEST_BYTES) {
          respond(res, 413, "请求超过本机代理限制。");
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(([name]) =>
            REQUEST_HEADERS.has(name),
          ),
        );
        // Neither cookies, Origin nor arbitrary proxy headers cross into the model API.
        const upstream = http.request(
          {
            hostname: backend.hostname,
            port: backend.port || 80,
            path: `${url.pathname}${url.search}`,
            method: req.method,
            headers,
          },
          (response) => {
            const replyHeaders = Object.fromEntries(
              Object.entries(response.headers).filter(
                ([name, value]) =>
                  RESPONSE_HEADERS.has(name) && value !== undefined,
              ),
            );
            res.writeHead(response.statusCode || 502, replyHeaders);
            response.pipe(res);
            response.on("error", () => res.destroy());
          },
        );
        let received = 0;
        req.on("data", (chunk) => {
          received += chunk.length;
          if (received > MAX_REQUEST_BYTES) {
            req.unpipe(upstream);
            upstream.destroy();
            respond(res, 413, "请求超过本机代理限制。");
          }
        });
        upstream.on("error", () =>
          respond(res, 502, "无法连接本机识别服务，请先启动 API 与 worker。"),
        );
        req.on("aborted", () => upstream.destroy());
        res.on("close", () => {
          if (!res.writableEnded) upstream.destroy();
        });
        req.pipe(upstream);
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        respond(res, 405, "静态资源仅支持读取。");
        return;
      }
      const decoded = decodeURIComponent(
        url.pathname === "/" ? "/index.html" : url.pathname,
      );
      if (decoded.includes("\0") || decoded.includes("\\")) {
        respond(res, 400, "资源路径无效。");
        return;
      }
      const candidate = path.resolve(root, `.${decoded}`);
      const resolved = await realpath(candidate);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        respond(res, 403, "资源不在应用目录内。");
        return;
      }
      const info = await stat(resolved);
      const contentType = MIME[path.extname(resolved).toLowerCase()];
      if (!info.isFile() || !contentType) {
        respond(res, 404, "资源不存在。");
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") res.end();
      else
        createReadStream(resolved)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch (error) {
      respond(res, error instanceof URIError ? 400 : 404, "无法读取应用资源。");
    }
  });
  server.requestTimeout = 0; // Long uploads and SSE are terminated by client disconnects.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  return {
    origin,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

module.exports = { startLocalServer };
