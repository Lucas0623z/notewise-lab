"use strict";

const path = require("node:path");
const {
  readFile,
  writeFile,
  rename,
  unlink,
  mkdir,
} = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const MAX_BYTES = 16 * 1024 * 1024;
const kinds = new Set([
  "vocal",
  "drums",
  "bass",
  "other",
  "piano",
  "guitar",
  "strings",
]);

function check(value, message) {
  if (!value) throw new TypeError(`演示工程格式无效：${message}`);
}
function shape(value, keys) {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "需要对象",
  );
  check(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "字段不匹配",
  );
}
function text(value, max = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function number(value, min, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function integer(value, min, max) {
  return Number.isInteger(value) && number(value, min, max);
}
function warnings(value) {
  check(
    Array.isArray(value) &&
      value.length <= 100 &&
      value.every((item) => text(item, 2000)),
    "提示信息",
  );
}
function date(value) {
  return text(value, 100) && Number.isFinite(Date.parse(value));
}

function validateProjects(projects) {
  check(
    Array.isArray(projects) && projects.length <= 100,
    "最多保存 100 个演示工程",
  );
  const projectIds = new Set();
  let totalNotes = 0;
  for (const project of projects) {
    shape(project, [
      "id",
      "title",
      "status",
      "bpm",
      "timeSignature",
      "durationSeconds",
      "revision",
      "createdAt",
      "updatedAt",
      "sourceAudioUrl",
      "latestJobId",
      "tracks",
      "warnings",
    ]);
    check(
      text(project.id, 100) &&
        /^demo-[a-zA-Z0-9_-]+$/.test(project.id) &&
        !projectIds.has(project.id),
      "演示工程 ID",
    );
    projectIds.add(project.id);
    check(text(project.title), "工程名称");
    check(
      ["empty", "ready", "failed", "cancelled"].includes(project.status),
      "演示状态不能模拟正在识别",
    );
    check(
      number(project.bpm, 20, 300) && project.timeSignature === "4/4",
      "BPM 或拍号",
    );
    check(
      number(project.durationSeconds, 0, 172800) &&
        integer(project.revision, 0, Number.MAX_SAFE_INTEGER),
      "工程时长或版本",
    );
    check(date(project.createdAt) && date(project.updatedAt), "日期");
    check(project.sourceAudioUrl === null, "演示工程不能引用外部音频");
    check(
      project.latestJobId === null ||
        (text(project.latestJobId, 100) &&
          /^demo-[a-zA-Z0-9_-]+$/.test(project.latestJobId)),
      "演示任务 ID",
    );
    warnings(project.warnings);
    check(
      Array.isArray(project.tracks) && project.tracks.length <= 64,
      "轨道数量",
    );
    const trackIds = new Set();
    for (const track of project.tracks) {
      shape(track, [
        "id",
        "kind",
        "name",
        "program",
        "isDrum",
        "muted",
        "solo",
        "volume",
        "pan",
        "audioUrl",
        "notes",
        "transcriptionStatus",
        "warnings",
      ]);
      check(
        text(track.id, 100) &&
          /^[a-zA-Z0-9_-]+$/.test(track.id) &&
          !trackIds.has(track.id),
        "轨道 ID",
      );
      trackIds.add(track.id);
      check(
        kinds.has(track.kind) &&
          text(track.name) &&
          integer(track.program, 0, 127),
        "轨道类型或音色",
      );
      check(
        ["isDrum", "muted", "solo"].every(
          (key) => typeof track[key] === "boolean",
        ),
        "轨道开关",
      );
      check(
        number(track.volume, 0, 1) && number(track.pan, -1, 1),
        "音量或声像",
      );
      check(track.audioUrl === null, "演示轨道不能引用外部音频");
      check(
        ["completed", "unsupported", "failed"].includes(
          track.transcriptionStatus,
        ),
        "转录状态",
      );
      warnings(track.warnings);
      check(
        Array.isArray(track.notes) && track.notes.length <= 100000,
        "音符数量",
      );
      totalNotes += track.notes.length;
      check(totalNotes <= 250000, "演示工程总音符数超过限制");
      const noteIds = new Set();
      for (const note of track.notes) {
        shape(note, [
          "id",
          "pitch",
          "startSeconds",
          "durationSeconds",
          "velocity",
        ]);
        check(text(note.id, 100) && !noteIds.has(note.id), "音符 ID");
        noteIds.add(note.id);
        check(
          integer(note.pitch, 0, 127) && integer(note.velocity, 1, 127),
          "音高或力度",
        );
        check(
          number(note.startSeconds, 0, 86400) &&
            number(note.durationSeconds, Number.MIN_VALUE, 86400),
          "音符时间",
        );
      }
    }
  }
  return projects;
}

function createDemoStore(userDataDirectory) {
  const destination = path.join(userDataDirectory, "demo-projects.v1.json");
  let writes = Promise.resolve();
  return {
    async read() {
      await writes;
      try {
        const data = await readFile(destination);
        check(data.byteLength <= MAX_BYTES, "本地文件超过 16 MB");
        return validateProjects(JSON.parse(data.toString("utf8")));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(
          `本地演示工程无法读取，已有文件未被覆盖：${error.message}`,
        );
      }
    },
    write(projects) {
      validateProjects(projects);
      const serialized = JSON.stringify(projects);
      check(
        Buffer.byteLength(serialized, "utf8") <= MAX_BYTES,
        "本地工程超过 16 MB",
      );
      const operation = writes.then(async () => {
        await mkdir(userDataDirectory, { recursive: true });
        const temporary = path.join(
          userDataDirectory,
          `demo-projects-${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, serialized, {
            encoding: "utf8",
            flag: "wx",
          });
          await rename(temporary, destination);
        } finally {
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      });
      writes = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { createDemoStore, validateProjects };
