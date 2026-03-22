/**
 * Request Deduplication Service
 *
 * Deduplicates **concurrent** identical requests to the same upstream.
 * Inspired by ClawRouter's dedup.ts (BlockRunAI / github.com/BlockRunAI/ClawRouter).
 *
 * IMPORTANT: In-memory only — does NOT persist across restarts and does NOT
 * work across multiple process instances (no cross-instance dedup).
 */

import { createHash } from "node:crypto";

export interface DedupConfig {
  enabled: boolean;
  maxTemperatureForDedup: number;
  timeoutMs: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  enabled: true,
  maxTemperatureForDedup: 0.1,
  timeoutMs: 60_000,
};

export interface DedupResult<T> {
  result: T;
  wasDeduplicated: boolean;
  hash: string;
}

const inflight = new Map<string, Promise<unknown>>();

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (!value || typeof value !== "object") return value ?? null;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = normalizeValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

/**
 * Compute a deterministic hash for a request body.
 * Includes user-visible prompt fields across chat/responses/gemini-style payloads.
 * Excludes transport-only fields such as stream/user/metadata.
 */
export function computeRequestHash(requestBody: unknown): string {
  const body = requestBody as Record<string, unknown>;
  const canonical = {
    model: body.model ?? null,
    messages: normalizeValue(body.messages ?? null),
    input: normalizeValue(body.input ?? null),
    instructions: normalizeValue(body.instructions ?? null),
    contents: normalizeValue(body.contents ?? null),
    prompt: normalizeValue(body.prompt ?? null),
    temperature: typeof body.temperature === "number" ? body.temperature : 1.0,
    tools: normalizeValue(body.tools ?? null),
    tool_choice: normalizeValue(body.tool_choice ?? null),
    max_tokens: normalizeValue(body.max_tokens ?? null),
    max_completion_tokens: normalizeValue(body.max_completion_tokens ?? null),
    max_output_tokens: normalizeValue(body.max_output_tokens ?? null),
    response_format: normalizeValue(body.response_format ?? null),
    top_p: normalizeValue(body.top_p ?? null),
    frequency_penalty: normalizeValue(body.frequency_penalty ?? null),
    presence_penalty: normalizeValue(body.presence_penalty ?? null),
    reasoning: normalizeValue(body.reasoning ?? null),
    reasoning_effort: normalizeValue(body.reasoning_effort ?? null),
    text: normalizeValue(body.text ?? null),
    modalities: normalizeValue(body.modalities ?? null),
    audio: normalizeValue(body.audio ?? null),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** Determine whether a request should be deduplicated */
export function shouldDeduplicate(
  requestBody: unknown,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): boolean {
  if (!config.enabled) return false;
  const body = requestBody as Record<string, unknown>;
  if (body.stream === true) return false;
  const temperature = typeof body.temperature === "number" ? body.temperature : 1.0;
  if (temperature > config.maxTemperatureForDedup) return false;
  return true;
}

/**
 * Execute a request with deduplication.
 * Concurrent identical requests share one upstream call.
 */
export async function deduplicate<T>(
  hash: string,
  fn: () => Promise<T>,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): Promise<DedupResult<T>> {
  if (!config.enabled) {
    return { result: await fn(), wasDeduplicated: false, hash };
  }

  const existing = inflight.get(hash);
  if (existing) {
    const result = (await existing) as T;
    return { result, wasDeduplicated: true, hash };
  }

  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const sharedPromise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  inflight.set(hash, sharedPromise as Promise<unknown>);

  const timer = setTimeout(() => {
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }, config.timeoutMs);

  try {
    const result = await fn();
    resolve(result);
    return { result, wasDeduplicated: false, hash };
  } catch (err) {
    reject(err);
    throw err;
  } finally {
    clearTimeout(timer);
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }
}

export function getInflightCount(): number {
  return inflight.size;
}
export function getInflightHashes(): string[] {
  return [...inflight.keys()];
}
export function clearInflight(): void {
  inflight.clear();
}
