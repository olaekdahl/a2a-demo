// In-memory Task store + lifecycle helpers + SSE event emission.
// Agents keep an in-memory task store (a map of taskId → Task); they never
// touch the shared SQLite database (§8).

import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import {
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatus,
} from "./schemas.js";

/** ISO-8601 UTC timestamp with milliseconds and a trailing Z (§6). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Sleep helper for animating status updates (§9: ~250–500 ms apart). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A live SSE subscriber attached to a task. */
interface Subscriber {
  reply: FastifyReply;
}

/** SSE event kinds (§9). */
export type SseKind = "task" | "status-update" | "artifact-update";

/**
 * In-memory store of tasks plus their live SSE subscribers, so that
 * `POST /tasks/{id}:subscribe` can attach to an already-running task.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  /** Create a fresh task in TASK_STATE_SUBMITTED with the request message in history. */
  create(contextId: string, requestMessage: Message): Task {
    const id = `task-${randomUUID()}`;
    const task: Task = {
      id,
      contextId,
      status: {
        state: TaskState.SUBMITTED,
        timestamp: nowIso(),
        metadata: { phase: "submitted", display: "Task accepted." },
      },
      history: [requestMessage],
      artifacts: [],
    };
    this.tasks.set(id, task);
    this.subscribers.set(id, new Set());
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** List tasks with optional contextId/state filters and a pageSize cap (§10). */
  list(filters: {
    contextId?: string;
    state?: string;
    pageSize?: number;
  }): Task[] {
    const pageSize = filters.pageSize ?? 50;
    let result = Array.from(this.tasks.values());
    if (filters.contextId) {
      result = result.filter((t) => t.contextId === filters.contextId);
    }
    if (filters.state) {
      result = result.filter((t) => t.status.state === filters.state);
    }
    return result.slice(0, pageSize);
  }

  /** Mutate a task's status (state + phase/display metadata). */
  setStatus(id: string, status: TaskStatus): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.status = status;
    return task;
  }

  /** Append a response message to a task's history. */
  appendHistory(id: string, message: Message): void {
    const task = this.tasks.get(id);
    if (task) task.history.push(message);
  }

  /** Attach an artifact to a task. */
  addArtifact(id: string, artifact: Artifact): void {
    const task = this.tasks.get(id);
    if (task) task.artifacts.push(artifact);
  }

  // --- SSE subscriber management -------------------------------------------

  addSubscriber(id: string, reply: FastifyReply): Subscriber | undefined {
    const set = this.subscribers.get(id);
    if (!set) return undefined;
    const sub: Subscriber = { reply };
    set.add(sub);
    return sub;
  }

  removeSubscriber(id: string, sub: Subscriber): void {
    this.subscribers.get(id)?.delete(sub);
  }

  /** Broadcast one SSE event to every subscriber attached to a task. */
  broadcast(id: string, kind: SseKind, payload: Record<string, unknown>): void {
    const set = this.subscribers.get(id);
    if (!set) return;
    for (const sub of set) {
      writeSseEvent(sub.reply, kind, payload);
    }
  }
}

/**
 * Write a single SSE event in the EXACT format mandated by §9:
 *   event: <kind>\n
 *   data: <single-line-json>\n
 *   \n
 * The same `kind` is also embedded in the JSON payload.
 */
export function writeSseEvent(
  reply: FastifyReply,
  kind: SseKind,
  payload: Record<string, unknown>,
): void {
  const body = { kind, ...payload };
  reply.raw.write(`event: ${kind}\n`);
  reply.raw.write(`data: ${JSON.stringify(body)}\n`);
  reply.raw.write(`\n`);
}

/** Build a status-update SSE payload (§9). */
export function statusUpdateEvent(
  task: Task,
  status: TaskStatus,
  final: boolean,
): Record<string, unknown> {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status,
    final,
  };
}

/** Build an artifact-update SSE payload (§9). */
export function artifactUpdateEvent(
  task: Task,
  artifact: Artifact,
  final: boolean,
): Record<string, unknown> {
  return {
    taskId: task.id,
    contextId: task.contextId,
    artifact,
    final,
  };
}

/** Build the initial `task` SSE payload (§9). */
export function taskEvent(task: Task): Record<string, unknown> {
  return { task };
}

/** Build the agent's response Message appended to task history (§4). */
export function buildAgentMessage(
  contextId: string,
  agentName: string,
  text: string,
): Message {
  return {
    messageId: `msg-${randomUUID()}`,
    contextId,
    role: "ROLE_AGENT",
    parts: [{ text, mediaType: "text/plain" }],
    metadata: { sender: agentName },
  };
}
