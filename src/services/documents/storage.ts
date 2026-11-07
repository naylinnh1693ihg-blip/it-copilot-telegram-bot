import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseError } from "../../utils/errors.js";
import { redactString } from "../../utils/text.js";

export const DOCUMENT_BUCKET = "documents";
export const SIGNED_URL_SECONDS = 600;

export interface ObjectStorage {
  upload(path: string, body: Buffer, contentType: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, ttlSeconds: number): Promise<string>;
}

export class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>();

  has(path: string): boolean {
    return this.objects.has(path);
  }

  async upload(path: string, body: Buffer, _contentType: string): Promise<void> {
    this.objects.set(path, Buffer.from(body));
  }

  async download(path: string): Promise<Buffer> {
    const body = this.objects.get(path);
    if (!body) throw new Error(`Missing stored file: ${path}`);
    return Buffer.from(body);
  }

  async remove(path: string): Promise<void> {
    this.objects.delete(path);
  }

  async signedUrl(path: string, ttlSeconds: number): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    return `https://example.invalid/signed/${encodeURIComponent(path)}?expires=${expires}`;
  }
}

export function createSupabaseStorage(client: SupabaseClient): ObjectStorage {
  return {
    async upload(path, body, contentType) {
      const { error } = await client.storage.from(DOCUMENT_BUCKET).upload(path, new Uint8Array(body), {
        contentType,
        upsert: false,
      });
      if (error) throw new DatabaseError(redactString(error.message));
    },
    async download(path) {
      const { data, error } = await client.storage.from(DOCUMENT_BUCKET).download(path);
      if (error || !data) throw new DatabaseError(redactString(error?.message ?? "Could not download the stored file."));
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(path) {
      const { error } = await client.storage.from(DOCUMENT_BUCKET).remove([path]);
      if (error) throw new DatabaseError(redactString(error.message));
    },
    async signedUrl(path, ttlSeconds) {
      const { data, error } = await client.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, ttlSeconds);
      if (error || !data?.signedUrl) throw new DatabaseError("Could not create a download link.");
      return data.signedUrl;
    },
  };
}
