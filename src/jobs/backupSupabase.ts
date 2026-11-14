import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const DOCUMENT_BUCKET = "documents";
const BACKUP_FOLDER = "it-work-copilot-backups";
const PAGE_SIZE = 500;
const STORAGE_PAGE_SIZE = 100;
export const BACKUP_RETENTION_DAYS = 30;
const BACKUP_DELETE_AFTER_DAYS = BACKUP_RETENTION_DAYS - 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConversationTurnBackup {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface StorageEntry {
  name: string;
  folder: boolean;
}

export interface BackupSource {
  fetchConversationTurns(cutoffIso: string, offset: number, limit: number): Promise<ConversationTurnBackup[]>;
  listStorage(path: string, offset: number, limit: number): Promise<StorageEntry[]>;
  downloadStorage(path: string): Promise<Buffer>;
}

export interface BackupOptions {
  source: BackupSource;
  remote: string;
  now?: Date;
  temporaryDirectory?: string;
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string }>;
}

export function createBackupSource(client: SupabaseClient): BackupSource {
  return {
    async fetchConversationTurns(cutoffIso, offset, limit) {
      const { data, error } = await client
        .from("conversation_turns")
        .select("id,user_id,role,content,created_at")
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw new Error(`Could not export conversation turns: ${error.message}`);
      return (data ?? []) as ConversationTurnBackup[];
    },
    async listStorage(folder, offset, limit) {
      const { data, error } = await client.storage.from(DOCUMENT_BUCKET).list(folder, {
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Could not list uploaded documents: ${error.message}`);
      return (data ?? []).map((entry) => ({
        name: entry.name,
        folder: entry.id === null && entry.metadata === null,
      }));
    },
    async downloadStorage(objectPath) {
      const { data, error } = await client.storage.from(DOCUMENT_BUCKET).download(objectPath);
      if (error) throw new Error(`Could not download an uploaded document: ${error.message}`);
      if (!data) throw new Error("Supabase returned no bytes for an uploaded document.");
      return Buffer.from(await data.arrayBuffer());
    },
  };
}

export async function createBackup(options: BackupOptions): Promise<{
  turns: number;
  files: number;
  archiveName: string;
}> {
  const { remote, configuredRemote } = normalizeBackupRemote(options.remote);
  const runCommand = options.runCommand ?? runCommandSafely;
  const config = await runCommand("rclone", ["config", "show", configuredRemote]);
  if (!/^\s*type\s*=\s*crypt\s*$/im.test(config.stdout)) {
    throw new Error("The configured Google Drive remote must be an rclone crypt remote.");
  }

  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - BACKUP_RETENTION_DAYS * DAY_MS).toISOString();
  const timestamp = now.toISOString().replaceAll(":", "").replaceAll("-", "");
  const archiveName = `copilot-backup-${timestamp}.tar.gz`;
  const workDirectory = await mkdtemp(path.join(options.temporaryDirectory ?? tmpdir(), "it-copilot-backup-"));
  const payloadDirectory = path.join(workDirectory, "payload");
  const archivePath = path.join(workDirectory, archiveName);
  await mkdir(path.join(payloadDirectory, "files"), { recursive: true });

  try {
    const turns: ConversationTurnBackup[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await options.source.fetchConversationTurns(cutoffIso, offset, PAGE_SIZE);
      turns.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const files = await downloadStorageTree(options.source, "", path.join(payloadDirectory, "files"));
    await writeFile(path.join(payloadDirectory, "conversation_turns.json"), `${JSON.stringify({
      exported_at: now.toISOString(),
      since: cutoffIso,
      count: turns.length,
      turns,
    }, null, 2)}\n`);
    await writeFile(path.join(payloadDirectory, "manifest.json"), `${JSON.stringify({
      exported_at: now.toISOString(),
      conversation_turns_since: cutoffIso,
      conversation_turns: turns.length,
      uploaded_files: files,
    }, null, 2)}\n`);
    await runCommand("tar", ["-czf", archivePath, "-C", payloadDirectory, "."]);
    await runCommand("rclone", ["copyto", archivePath, `${remote}/${archiveName}`]);
    await deleteExpiredBackups(remote, runCommand);
    return { turns: turns.length, files, archiveName };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function pruneBackups(
  remote: string,
  runCommand: NonNullable<BackupOptions["runCommand"]> = runCommandSafely,
): Promise<void> {
  const { remote: normalizedRemote, configuredRemote } = normalizeBackupRemote(remote);
  const config = await runCommand("rclone", ["config", "show", configuredRemote]);
  if (!/^\s*type\s*=\s*crypt\s*$/im.test(config.stdout)) {
    throw new Error("The configured Google Drive remote must be an rclone crypt remote.");
  }
  await deleteExpiredBackups(normalizedRemote, runCommand);
}

function normalizeBackupRemote(remote: string): { remote: string; configuredRemote: string } {
  const normalized = remote.trim().replace(/\/+$/, "");
  const separator = normalized.indexOf(":");
  const configuredRemote = normalized.slice(0, separator);
  const pathSegments = normalized.slice(separator + 1).split("/");
  if (
    separator <= 0
    || pathSegments.some((segment) => !segment || segment === "." || segment === "..")
    || pathSegments.at(-1) !== BACKUP_FOLDER
  ) {
    throw new Error(`RCLONE_REMOTE must point to a dedicated folder named ${BACKUP_FOLDER}.`);
  }
  return { remote: normalized, configuredRemote };
}

async function deleteExpiredBackups(
  remote: string,
  runCommand: NonNullable<BackupOptions["runCommand"]>,
): Promise<void> {
  await runCommand("rclone", [
    "delete",
    remote,
    "--min-age",
    `${BACKUP_DELETE_AFTER_DAYS}d`,
    "--include",
    "copilot-backup-*.tar.gz",
  ]);
}

async function downloadStorageTree(source: BackupSource, folder: string, destination: string): Promise<number> {
  let count = 0;
  for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
    const entries = await source.listStorage(folder, offset, STORAGE_PAGE_SIZE);
    for (const entry of entries) {
      const relativePath = folder ? `${folder}/${entry.name}` : entry.name;
      const safePath = storagePathSegments(relativePath);
      if (entry.folder) {
        count += await downloadStorageTree(source, relativePath, path.join(destination, ...safePath));
        continue;
      }
      const outputPath = path.join(destination, ...safePath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, await source.downloadStorage(relativePath));
      count += 1;
    }
    if (entries.length < STORAGE_PAGE_SIZE) break;
  }
  return count;
}

function storagePathSegments(value: string): string[] {
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("Supabase returned an invalid uploaded-file path.");
  }
  return segments;
}

async function runCommandSafely(command: string, args: string[]): Promise<{ stdout: string }> {
  try {
    const result = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024 });
    return { stdout: result.stdout };
  } catch {
    throw new Error(`${command} failed while creating or storing the Supabase backup.`);
  }
}

async function main(): Promise<void> {
  const remote = process.env.RCLONE_REMOTE;
  if (!remote) throw new Error("Set RCLONE_REMOTE before running the backup.");
  if (process.argv.includes("--prune-only")) {
    await pruneBackups(remote);
    console.log("Expired backup archives pruned.");
    return;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the backup.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await createBackup({ source: createBackupSource(client), remote });
  console.log(`Backup uploaded: ${result.turns} conversation turns, ${result.files} files (${result.archiveName}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Supabase backup failed.");
    process.exitCode = 1;
  });
}
