const fs = require("fs");
const path = require("path");

let logPath = "";
let linesSinceSizeCheck = 0;
let lastSizeCheckAtMs = 0;

const kTruncateCheckEveryLines = 25;
const kTruncateCheckMinIntervalMs = 2000;

const shouldCheckTruncate = () => {
  linesSinceSizeCheck += 1;
  const now = Date.now();
  if (
    linesSinceSizeCheck >= kTruncateCheckEveryLines ||
    now - lastSizeCheckAtMs >= kTruncateCheckMinIntervalMs
  ) {
    linesSinceSizeCheck = 0;
    lastSizeCheckAtMs = now;
    return true;
  }
  return false;
};

const appendLine = (line, maxBytes) => {
  if (!logPath) return;
  const prefixed = /^\d{4}-\d{2}-\d{2}T/.test(line)
    ? line
    : `${new Date().toISOString()} ${line}`;
  fs.appendFileSync(logPath, prefixed.endsWith("\n") ? prefixed : `${prefixed}\n`);
  if (shouldCheckTruncate()) truncateIfNeeded(maxBytes);
};

const truncateIfNeeded = (maxBytes) => {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= maxBytes) return;
    const keepBytes = Math.floor(maxBytes / 2);
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(keepBytes);
    const startPos = Math.max(0, stat.size - keepBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, keepBytes, startPos);
    fs.closeSync(fd);
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewLine = chunk.indexOf("\n");
    const safeChunk = firstNewLine === -1 ? chunk : chunk.slice(firstNewLine + 1);
    fs.writeFileSync(logPath, safeChunk, "utf8");
  } catch (err) {
    console.error(`[alphaclaw] log truncate error: ${err.message}`);
  }
};

const initLogWriter = ({ rootDir, maxBytes }) => {
  const logsDir = path.join(rootDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  logPath = path.join(logsDir, "process.log");
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "", "utf8");
  linesSinceSizeCheck = 0;
  lastSizeCheckAtMs = Date.now();

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      appendLine(line, maxBytes);
    }
    return stdoutWrite(chunk, encoding, cb);
  };

  process.stderr.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      appendLine(line, maxBytes);
    }
    return stderrWrite(chunk, encoding, cb);
  };
};

const getLogPath = () => logPath;

const readLogTail = (tailBytes = 65536) => {
  if (!logPath || !fs.existsSync(logPath)) return "";
  const stat = fs.statSync(logPath);
  const readBytes = Math.max(1024, Number.parseInt(String(tailBytes || 65536), 10) || 65536);
  const startPos = Math.max(0, stat.size - readBytes);
  const len = stat.size - startPos;
  const fd = fs.openSync(logPath, "r");
  const buffer = Buffer.alloc(len);
  fs.readSync(fd, buffer, 0, len, startPos);
  fs.closeSync(fd);
  return buffer.toString("utf8");
};

module.exports = {
  initLogWriter,
  getLogPath,
  readLogTail,
};
