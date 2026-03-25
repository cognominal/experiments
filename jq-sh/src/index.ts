import readline from "node:readline";
import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

let commandIndex = 0;
let previousResult: string | null = null;

function getHomeInfo() {
  const homeDir = os.homedir();
  const user = path.basename(homeDir);
  return { homeDir, user };
}

function formatCwd(cwd: string): string {
  const { homeDir, user } = getHomeInfo();

  if (cwd === homeDir) {
    return `~${user}`;
  }

  if (cwd.startsWith(homeDir + path.sep)) {
    return `~${user}${cwd.slice(homeDir.length)}`;
  }

  return cwd;
}

function looksLikePathStart(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.startsWith("~") || value.includes(path.sep);
}

function expandHome(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }

  const { homeDir, user } = getHomeInfo();
  const prefix = `~${user}`;
  if (value === "~" || value === prefix) {
    return homeDir;
  }

  if (value.startsWith(prefix + path.sep)) {
    return path.join(homeDir, value.slice(prefix.length + 1));
  }

  return value;
}

async function completePath(line: string): Promise<[string[], string]> {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !looksLikePathStart(trimmed)) {
    return [[], line];
  }

  const lastSlashIndex = trimmed.lastIndexOf(path.sep);
  const originalDir = lastSlashIndex === -1 ? "" : trimmed.slice(0, lastSlashIndex + 1);
  const prefix = lastSlashIndex === -1 ? trimmed : trimmed.slice(lastSlashIndex + 1);
  let expandedDir = process.cwd();
  if (lastSlashIndex >= 0) {
    if (lastSlashIndex === 0) {
      expandedDir = path.sep;
    } else {
      expandedDir = expandHome(trimmed.slice(0, lastSlashIndex)) || process.cwd();
    }
  }

  try {
    const entries = await readdir(expandedDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => {
        const suffix = entry.isDirectory() ? path.sep : "";
        return `${originalDir}${entry.name}${suffix}`;
      });
    return [matches, line];
  } catch {
    return [[], line];
  }
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines += 1;
    }
  }
  return lines;
}

function printError(message: string): void {
  console.error(chalk.red(message));
}

async function writeToStdin(stdin: unknown, input: string): Promise<void> {
  if (!stdin) {
    return;
  }

  if (typeof (stdin as { getWriter?: () => WritableStreamDefaultWriter<Uint8Array> }).getWriter === "function") {
    const writer = (stdin as WritableStream<Uint8Array>).getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    return;
  }

  if (typeof (stdin as { write?: (chunk: string) => void; end?: () => void }).write === "function") {
    const stream = stdin as { write: (chunk: string) => void; end?: () => void };
    stream.write(input);
    if (typeof stream.end === "function") {
      stream.end();
    }
  }
}

async function runJq(script: string, input: string): Promise<{ stdout: string; stderr: string; exitCode: number }>{
  const proc = Bun.spawn(["jq", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  await writeToStdin(proc.stdin, input);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  completer: (line: string, callback?: (err: Error | null, result: [string[], string]) => void) => {
    if (callback) {
      completePath(line)
        .then((result) => callback(null, result))
        .catch(() => callback(null, [[], line]));
      return;
    }
    return completePath(line);
  },
});

function prompt(): void {
  const displayCwd = formatCwd(process.cwd());
  rl.setPrompt(`${displayCwd} ${commandIndex}> `);
  rl.prompt();
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    prompt();
    return;
  }

  const forceJqIdentity = trimmed === ".";
  const startsWithDot = trimmed.startsWith(".");
  const resolvedPath = path.resolve(process.cwd(), trimmed);

  try {
    if (!forceJqIdentity) {
    const stats = await stat(resolvedPath);

    if (stats.isDirectory()) {
      try {
        process.chdir(resolvedPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        printError(`cd failed: ${message}`);
      }
      commandIndex += 1;
      prompt();
      return;
    }

    if (stats.isFile() && resolvedPath.endsWith(".json")) {
      try {
        const content = await readFile(resolvedPath, "utf8");
        const lines = countLines(content);
        const chars = content.length;
        console.log(`${lines} lines, ${chars} chars`);
        previousResult = content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        printError(`file not readable: ${message}`);
      }
      commandIndex += 1;
      prompt();
      return;
    }
    }
  } catch {
    // Not a readable path; treat as jq script.
    if (startsWithDot) {
      // If it looked like a path, allow fallback to jq when missing.
    }
  }

  try {
    const input = previousResult ?? "null";
    const { stdout, stderr, exitCode } = await runJq(trimmed, input);

    if (exitCode === 0) {
      process.stdout.write(stdout);
      previousResult = stdout;
      if (stderr.length > 0) {
        printError(stderr.trimEnd());
      }
    } else {
      const message = stderr.trim() || `jq error: exit ${exitCode}`;
      printError(message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(`jq error: ${message}`);
  }

  commandIndex += 1;
  prompt();
}

let lineQueue = Promise.resolve();
rl.on("line", (line) => {
  lineQueue = lineQueue.then(() => handleLine(line)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    printError(`jq error: ${message}`);
    commandIndex += 1;
    prompt();
  });
});

rl.on("close", () => {
  process.stdout.write("\n");
});

prompt();
