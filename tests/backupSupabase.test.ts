import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, type BackupOptions, type BackupSource } from "../src/jobs/backupSupabase.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "it-copilot-backup-test-"));
  directories.push(directory);
  return directory;
}

function source(overrides: Partial<BackupSource> = {}): BackupSource {
  return {
    fetchConversationTurns: vi.fn(async () => []),
    listStorage: vi.fn(async () => []),
    downloadStorage: vi.fn(async () => Buffer.from("file bytes")),
    ...overrides,
  };
}

function fakeRunner(commands: Array<[string, string[]]>, config = "[drive]\ntype = crypt\n") {
  return async (command: string, args: string[]) => {
    commands.push([command, args]);
    if (command === "rclone" && args[0] === "config") return { stdout: config };
    if (command === "tar") {
      await writeFile(args[1], "test archive");
    }
    return { stdout: "" };
  };
}

describe("createBackup", () => {
  it("exports the last 30 days, includes nested files, uploads encrypted archive, and prunes only backups", async () => {
    const directory = await temporaryDirectory();
    const commands: Array<[string, string[]]> = [];
    const now = new Date("2026-11-14T12:00:00.000Z");
    const backupSource = source({
      fetchConversationTurns: vi.fn(async (cutoff: string) => {
        expect(cutoff).toBe("2026-10-15T12:00:00.000Z");
        return [{ id: "turn-1", user_id: "user-1", role: "user" as const, content: "hello", created_at: cutoff }];
      }),
      listStorage: vi.fn(async (folder) => folder === ""
        ? [{ name: "folder", folder: true }]
        : [{ name: "scan.pdf", folder: false }]),
    });
    const options: BackupOptions = {
      source: backupSource,
      remote: "drive-crypt:it-work-copilot-backups",
      now,
      temporaryDirectory: directory,
      runCommand: fakeRunner(commands),
    };

    const result = await createBackup(options);

    expect(result.turns).toBe(1);
    expect(result.files).toBe(1);
    expect(result.archiveName).toBe("copilot-backup-20261114T120000.000Z.tar.gz");
    expect(backupSource.downloadStorage).toHaveBeenCalledWith("folder/scan.pdf");
    expect(commands[1][0]).toBe("tar");
    expect(commands[2]).toEqual(["rclone", ["copyto", expect.any(String), `drive-crypt:it-work-copilot-backups/${result.archiveName}`]]);
    expect(commands[3]).toEqual(["rclone", [
      "delete",
      "drive-crypt:it-work-copilot-backups",
      "--min-age",
      "29d",
      "--include",
      "copilot-backup-*.tar.gz",
    ]]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a remote that is not encrypted", async () => {
    const directory = await temporaryDirectory();
    const runner = fakeRunner([], "[drive]\ntype = drive\n");

    await expect(createBackup({
      source: source(),
      remote: "drive-crypt:it-work-copilot-backups",
      temporaryDirectory: directory,
      runCommand: runner,
    })).rejects.toThrow("must be an rclone crypt remote");
  });

  it("refuses backup remotes outside the dedicated project folder", async () => {
    await expect(createBackup({
      source: source(),
      remote: "drive-crypt:../",
      runCommand: fakeRunner([]),
    })).rejects.toThrow("dedicated folder named it-work-copilot-backups");
  });

  it("rejects storage paths that could escape the backup directory", async () => {
    const directory = await temporaryDirectory();
    const backupSource = source({
      listStorage: vi.fn(async () => [{ name: "../outside.txt", folder: false }]),
    });

    await expect(createBackup({
      source: backupSource,
      remote: "drive-crypt:it-work-copilot-backups",
      temporaryDirectory: directory,
      runCommand: fakeRunner([]),
    })).rejects.toThrow("invalid uploaded-file path");
  });
});
