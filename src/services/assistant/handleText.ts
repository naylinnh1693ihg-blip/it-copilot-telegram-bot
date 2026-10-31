import type { Deps } from "../../app/deps.js";
import { IntentSchema, INTENT_JSON_SCHEMA, blankIntent, type Intent } from "../../types/intent.js";
import type { User } from "../../types/models.js";
import { intentPrompt } from "../grok/prompts.js";
import { AppError, GrokError, toUserMessage } from "../../utils/errors.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { execute, type Reply } from "./execute.js";
import { parseLocalIntent } from "./localIntent.js";

async function interpret(deps: Deps, user: User, text: string): Promise<Intent> {
  const local = parseLocalIntent(text);
  if (local?.intent === "rename_document") return local;
  if (!deps.llm) {
    return (
      local ??
      blankIntent({
        intent: "clarify",
        clarification_question:
          "I can run the examples in /help. To understand other wording, report writing, and English rewriting, add XAI_API_KEY.",
      })
    );
  }
  try {
    const history = await deps.db.recentTurns(user.id, 8);
    const prompt = intentPrompt(history, text);
    const result = await deps.llm.completeStructured({
      system: prompt.system,
      user: prompt.user,
      schemaName: "copilot_intent",
      schema: INTENT_JSON_SCHEMA,
    });
    await deps.db.recordUsage({
      userId: user.id,
      model: deps.env.XAI_MODEL,
      purpose: "intent",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedUsd:
        (result.inputTokens / 1_000_000) * deps.env.XAI_INPUT_USD_PER_MILLION +
        (result.outputTokens / 1_000_000) * deps.env.XAI_OUTPUT_USD_PER_MILLION,
      createdAt: toIso(deps.clock.now()),
    }).catch(() => undefined);
    const parsed = IntentSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) return local ?? blankIntent({ intent: "clarify", clarification_question: "I couldn't read that request. Please try /help." });
    if (parsed.data.confidence < 0.35) {
      return local ?? blankIntent({ intent: "clarify", clarification_question: parsed.data.clarification_question || "Can you say that more specifically?" });
    }
    return parsed.data;
  } catch (error) {
    deps.logger.warn({ event: "grok_intent_failed", message: redactString(error instanceof Error ? error.message : "error") }, "using local parser");
    if (local) return local;
    if (error instanceof GrokError) throw error;
    if (error instanceof AppError) {
      throw new AppError("Grok could not understand that message. Try a shorter request, or use /help.");
    }
    throw error;
  }
}

async function remember(deps: Deps, user: User, userText: string, assistantText: string): Promise<void> {
  const at = toIso(deps.clock.now());
  await deps.db.appendTurn(user.id, "user", userText, at);
  await deps.db.appendTurn(user.id, "assistant", assistantText, at);
}

export async function handleText(deps: Deps, user: User, text: string): Promise<Reply> {
  try {
    const cleaned = text.trim().slice(0, 8000);
    const now = deps.clock.now().setZone(user.timezone || deps.env.APP_TIMEZONE);
    const pending = await deps.db.getConfirmation(user.id);
    if (/^(yes|confirm)$/i.test(cleaned)) {
      if (!pending) return { text: "There is nothing waiting for confirmation." };
      if (Date.parse(pending.expiresAt) < now.toMillis()) {
        await deps.db.clearConfirmation(user.id);
        return { text: "That confirmation expired. Ask me again if you still want to do it." };
      }
      await deps.db.clearConfirmation(user.id);
      const reply = await execute(deps, user, pending.action, { confirmed: true });
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    if (pending && /^(no|cancel)$/i.test(cleaned)) {
      await deps.db.clearConfirmation(user.id);
      return { text: "Okay. I left it unchanged." };
    }
    if (pending) await deps.db.clearConfirmation(user.id);
    const intent = await interpret(deps, user, cleaned);
    const reply = await execute(deps, user, intent, { confirmed: false });
    if (reply.confirmation) {
      const expires = now.plus({ minutes: 10 }).toUTC().toISO();
      if (expires) await deps.db.putConfirmation(user.id, reply.confirmation, expires);
    }
    await remember(deps, user, cleaned, reply.text);
    return reply;
  } catch (error) {
    deps.logger.error({ event: "message_failed", message: redactString(error instanceof Error ? error.message : "error") }, "message failed");
    return { text: toUserMessage(error) };
  }
}
