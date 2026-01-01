import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "src/index.ts");

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

async function runShell(commands: string[], cwd: string) {
  const proc = Bun.spawn(["bun", scriptPath], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  await writeToStdin(proc.stdin, `${commands.join("\n")}\n`);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

async function hasJq(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["jq", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

const jqAvailable = await hasJq();
const testIfJq = jqAvailable ? test : test.skip;

testIfJq("reads JSON, prints length, and supports jq identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jq-sh-"));
  const jsonPath = path.join(tempDir, "data.json");
  await writeFile(jsonPath, "{\"a\":1}");

  const { stdout, stderr, exitCode } = await runShell(["data.json", "."], tempDir);
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);

  expect(exitCode).toBe(0);
  expect(cleanStderr).toBe("");
  expect(cleanStdout).toContain("1 lines, 7 chars");
  expect(cleanStdout).toContain("\"a\": 1");

  await rm(tempDir, { recursive: true, force: true });
});

testIfJq("falls back to jq when dot-path is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jq-sh-"));
  const jsonPath = path.join(tempDir, "data.json");
  await writeFile(jsonPath, "{\"a\":1}");

  const { stdout } = await runShell(["data.json", ".missing"], tempDir);
  const cleanStdout = stripAnsi(stdout);

  expect(cleanStdout).toContain("null");

  await rm(tempDir, { recursive: true, force: true });
});

testIfJq("prints red errors for unreadable file and jq syntax errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jq-sh-"));
  const jsonPath = path.join(tempDir, "secret.json");
  await writeFile(jsonPath, "{\"a\":1}");
  await chmod(jsonPath, 0o000);

  const { stderr } = await runShell(["secret.json", "["], tempDir);
  const cleanStderr = stripAnsi(stderr);

  expect(cleanStderr).toContain("file not readable:");
  expect(stderr).toContain("\x1b[31m");

  await chmod(jsonPath, 0o644);
  await rm(tempDir, { recursive: true, force: true });
});
