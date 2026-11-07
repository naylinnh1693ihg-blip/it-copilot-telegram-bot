import "dotenv/config";
import { parseEnv } from "../config/env.js";
import { createSupabaseClient, SupabaseDatabase } from "../database/supabase.js";
import { createXaiClient } from "../services/grok/xai.js";
import { buildRagContext } from "../services/rag/context.js";
import { findPromptCase, PROMPT_CASES, type PromptCase } from "../services/rag/promptCases.js";
import { formatPromptRun, runRagPrompt } from "../services/rag/promptTest.js";
import type { AnswerStyle } from "../services/rag/prompt.js";
import { hybridSearch } from "../services/rag/search.js";
import { ragConfig } from "../services/rag/config.js";
import { MemoryStorage } from "../services/documents/storage.js";
import { createLogger } from "../utils/logger.js";
import { assertZone, zoneClock } from "../utils/time.js";

interface Cli {
  question: string;
  context: string | null;
  caseName: string;
  samples: boolean;
  search: boolean;
  userId: string;
  style: AnswerStyle;
  model: string;
  debug: boolean;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (!cli) {
    console.log(usage());
    return;
  }
  const env = parseEnv(process.env);
  assertZone(env.APP_TIMEZONE);
  if (!env.XAI_API_KEY) {
    console.error("XAI_API_KEY is required. No request was sent.");
    process.exit(1);
  }
  const model = cli.model || env.XAI_MODEL;
  const llm = createXaiClient({
    apiKey: env.XAI_API_KEY,
    baseUrl: env.XAI_BASE_URL,
    model,
    timeoutMs: env.XAI_TIMEOUT_MS,
  });
  console.log(`Model: ${model}`);
  console.log(`Style: ${cli.style}`);

  const cases = await casesToRun(cli, env, llm);
  let failed = 0;
  for (const item of cases) {
    const result = await runRagPrompt({
      llm,
      question: item.question,
      context: item.context,
      sourcesLine: item.sourcesLine,
      style: cli.style,
    });
    console.log("");
    console.log(item.name ? `Case: ${item.name}` : "Case: custom");
    console.log(formatPromptRun(result, cli.debug));
    if (!result.ok) failed += 1;
  }
  if (failed > 0) process.exitCode = 1;
}

async function casesToRun(cli: Cli, env: ReturnType<typeof parseEnv>, llm: ReturnType<typeof createXaiClient>): Promise<PromptCase[]> {
  if (cli.samples) return PROMPT_CASES;
  if (cli.caseName) {
    const found = findPromptCase(cli.caseName);
    if (!found) {
      console.error(`Unknown case "${cli.caseName}". Choices: ${PROMPT_CASES.map((item) => item.name).join(", ")}`);
      process.exit(1);
    }
    return [found];
  }
  if (!cli.search) return [{ name: "custom", question: cli.question, context: cli.context, sourcesLine: "" }];

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --search. No request was sent.");
    process.exit(1);
  }
  const logger = createLogger(env.LOG_LEVEL);
  const db = new SupabaseDatabase(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY));
  const ping = await db.ping();
  if (!ping.ok) {
    console.error("Database ping failed. No request was sent.");
    process.exit(1);
  }
  const userId = cli.userId || (await onlyUserId(db));
  const deps = {
    env,
    db,
    clock: zoneClock(env.APP_TIMEZONE),
    logger,
    llm,
    storage: new MemoryStorage(),
  };
  const config = ragConfig(env);
  let hits: Awaited<ReturnType<typeof hybridSearch>> = [];
  try {
    hits = await hybridSearch(deps, userId, cli.question);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Search failed. Continuing with no context.");
    hits = [];
  }
  const built = buildRagContext(logger, hits, cli.question, { maxTokens: config.contextTokens, minScore: config.minScore });
  return [
    {
      name: "search",
      question: cli.question,
      context: built.relevant ? built.context : null,
      sourcesLine: built.sourcesLine,
    },
  ];
}

async function onlyUserId(db: SupabaseDatabase): Promise<string> {
  const ids = await db.listUserIds();
  if (ids.length === 1 && ids[0]) return ids[0];
  console.error("Pass --user <uuid> so search knows whose notes to read.");
  process.exit(1);
}

function parseCli(argv: string[]): Cli | null {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else flags.add(name);
  }
  const samples = flags.has("samples");
  const search = flags.has("search");
  const caseName = values.get("case") ?? "";
  const question = values.get("question") ?? "";
  if (!samples && !caseName && !question) return null;
  const style = values.get("style") ?? "normal";
  if (style !== "brief" && style !== "normal") {
    console.error('Style must be "brief" or "normal".');
    process.exit(1);
  }
  return {
    question,
    context: values.get("context")?.replace(/\\n/g, "\n") ?? null,
    caseName,
    samples,
    search,
    userId: values.get("user") ?? "",
    style,
    model: values.get("model") ?? "",
    debug: flags.has("debug"),
  };
}

function usage(): string {
  const names = PROMPT_CASES.map((item) => item.name).join(", ");
  return [
    "Test a RAG prompt against Grok.",
    "",
    "Sample cases (no database):",
    `  npm run test:rag -- --samples`,
    `  npm run test:rag -- --case ip --style brief`,
    "",
    "One question, with context you paste:",
    `  npm run test:rag -- --question "What's the IP of the floor 2 printer?" --context "[1] Note #14 (narrative)\\n192.168.1.10"`,
    "",
    "One question, using saved chunks:",
    `  npm run test:rag -- --search --question "What's the IP of the floor 2 printer?" --user <uuid>`,
    "",
    "Flags: --model <name>  --style brief|normal  --debug",
    `Cases: ${names}`,
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Prompt test failed.");
  process.exit(1);
});
