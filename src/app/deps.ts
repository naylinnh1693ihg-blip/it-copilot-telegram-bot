import type { Env } from "../config/env.js";
import type { Database } from "../database/types.js";
import type { ObjectStorage } from "../services/documents/storage.js";
import type { LlmClient } from "../services/grok/client.js";
import type { AppLogger } from "../utils/logger.js";
import type { Clock } from "../utils/time.js";

export interface Deps {
  env: Env;
  db: Database;
  clock: Clock;
  logger: AppLogger;
  llm: LlmClient | null;
  storage: ObjectStorage;
}
