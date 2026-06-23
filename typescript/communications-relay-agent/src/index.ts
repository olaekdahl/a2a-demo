// Communications Relay Agent — TypeScript / Fastify v5 — port 8012 (§12.3).
// Implements the full A2A endpoint set (§8), auth (§1), structured JSON
// logging (§16) and SSE streaming (§9). Responds on /message:send (synchronous)
// and also streams on /message:stream for completeness.

import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createHash, randomUUID } from "node:crypto";

import { AGENT_LANGUAGE, AGENT_NAME, SKILL_IDS, agentCard } from "./agentCard.js";
import {
  SendMessageRequestSchema,
  TaskState,
  type Message,
  type TaskStatus,
} from "./schemas.js";
import {
  TaskStore,
  artifactUpdateEvent,
  buildAgentMessage,
  nowIso,
  sleep,
  statusUpdateEvent,
  taskEvent,
  writeSseEvent,
} from "./tasks.js";
import {
  COMPLETED_PHASE,
  RELAY_PHASES,
  buildSecureTransmissionArtifact,
  canonicalJson,
  extractDataPayload,
} from "./relay.js";

const PORT = Number(process.env.PORT ?? 8012);
const HOST = "0.0.0.0";

/** Milliseconds between streamed status updates (§9: ~250–500 ms). */
const STEP_DELAY_MS = 300;

const store = new TaskStore();

// --- Structured JSON logging (§16) -----------------------------------------

interface LogFields {
  level?: string;
  event: string;
  correlationId?: string;
  traceId?: string;
  contextId?: string;
  taskId?: string;
  sender?: string;
  recipient?: string;
  [key: string]: unknown;
}

function log(fields: LogFields): void {
  const line = {
    timestamp: nowIso(),
    service: AGENT_NAME,
    language: AGENT_LANGUAGE,
    level: fields.level ?? "info",
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// --- Error helper (§11) ----------------------------------------------------

type ErrorCode =
  | "AUTH_REQUIRED"
  | "BAD_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELABLE"
  | "SKILL_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "INTERNAL";

function sendError(
  reply: FastifyReply,
  httpStatus: number,
  code: ErrorCode,
  message: string,
  correlationId?: string,
): void {
  reply.code(httpStatus).type("application/json").send({
    error: { code, message, httpStatus, correlationId: correlationId ?? null },
  });
}

function correlationOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-correlation-id"];
  return Array.isArray(header) ? header[0] : header;
}

function traceOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-trace-id"];
  return Array.isArray(header) ? header[0] : header;
}

/** Echo correlation/trace ids back onto the response (§1). */
function echoCorrelation(request: FastifyRequest, reply: FastifyReply): void {
  const corr = correlationOf(request);
  const trace = traceOf(request);
  if (corr) reply.header("X-Correlation-ID", corr);
  if (trace) reply.header("X-Trace-ID", trace);
}

// --- Fastify setup ---------------------------------------------------------

const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

// Treat application/a2a+json as JSON too (§1/§2).
app.addContentTypeParser(
  "application/a2a+json",
  { parseAs: "string" },
  (_req, body, done) => {
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

// Per-request structured access log + correlation echo.
app.addHook("onResponse", async (request, reply) => {
  log({
    event: "http_request",
    method: request.method,
    path: request.url,
    statusCode: reply.statusCode,
    correlationId: correlationOf(request),
    traceId: traceOf(request),
  });
});

/**
 * Auth guard (§1): every A2A endpoint except /health and the agent card
 * requires the X-Demo-Token header. The token VALUE is not validated.
 */
function requireToken(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const token = request.headers["x-demo-token"];
  if (token === undefined || token === "") {
    log({
      level: "warn",
      event: "auth_missing_token",
      path: request.url,
      correlationId: correlationOf(request),
      traceId: traceOf(request),
    });
    sendError(
      reply,
      401,
      "AUTH_REQUIRED",
      "Missing required X-Demo-Token header.",
      correlationOf(request),
    );
    return false;
  }
  return true;
}

// --- Agent Card ETag caching (§17.1) ---------------------------------------
//
// Strong validator ETag `"a2a-<first 16 hex of sha256(canonical card JSON)>"`.
// Computed once at startup since the card contents never change at runtime.

const CARD_ETAG = `"a2a-${createHash("sha256")
  .update(canonicalJson(agentCard), "utf8")
  .digest("hex")
  .slice(0, 16)}"`;

// --- Public endpoints (no auth) --------------------------------------------

app.get("/health", async (_request, reply) => {
  reply
    .type("application/json")
    .send({ status: "ok", agent: AGENT_NAME, language: AGENT_LANGUAGE });
});

app.get("/.well-known/agent-card.json", async (request, reply) => {
  reply.header("ETag", CARD_ETAG);
  if (request.headers["if-none-match"] === CARD_ETAG) {
    reply.code(304).send();
    return;
  }
  reply.type("application/json").send(agentCard);
});

// --- POST /message:send (primary; synchronous) -----------------------------

// Path uses a literal colon (`/message:send`); Fastify treats a single colon as
// a route param, so the literal colon is escaped as `::` in the registered path.
app.post("/message::send", async (request, reply) => {
  echoCorrelation(request, reply);
  if (!requireToken(request, reply)) return;

  const parsed = SendMessageRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    sendError(
      reply,
      400,
      "BAD_REQUEST",
      `Invalid SendMessageRequest: ${parsed.error.message}`,
      correlationOf(request),
    );
    return;
  }

  const requestMessage = parsed.data.message;
  const contextId = requestMessage.contextId;
  const payload = extractDataPayload(requestMessage);
  const task = store.create(contextId, requestMessage);

  log({
    event: "message_send_received",
    contextId,
    taskId: task.id,
    correlationId: correlationOf(request),
    traceId: traceOf(request),
    sender: senderOf(requestMessage),
    recipient: AGENT_NAME,
  });

  // Relay the payload synchronously and return the completed Task (§5).
  runRelaySync(task.id, payload);

  const completed = store.get(task.id);
  reply.type("application/json").send({ task: completed });
});

// --- POST /message:stream (also implemented for completeness) --------------

app.post("/message::stream", async (request, reply) => {
  echoCorrelation(request, reply);
  if (!requireToken(request, reply)) return;

  const parsed = SendMessageRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    sendError(
      reply,
      400,
      "BAD_REQUEST",
      `Invalid SendMessageRequest: ${parsed.error.message}`,
      correlationOf(request),
    );
    return;
  }

  const requestMessage = parsed.data.message;
  const contextId = requestMessage.contextId;
  const payload = extractDataPayload(requestMessage);
  const task = store.create(contextId, requestMessage);

  log({
    event: "message_stream_started",
    contextId,
    taskId: task.id,
    correlationId: correlationOf(request),
    traceId: traceOf(request),
    sender: senderOf(requestMessage),
    recipient: AGENT_NAME,
  });

  startSseResponse(request, reply);
  await runRelayStream(reply, task.id, payload);
  reply.raw.end();
});

// --- GET /tasks/{id} -------------------------------------------------------

app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
  echoCorrelation(request, reply);
  if (!requireToken(request, reply)) return;

  const task = store.get(request.params.id);
  if (!task) {
    sendError(
      reply,
      404,
      "TASK_NOT_FOUND",
      `No task ${request.params.id}`,
      correlationOf(request),
    );
    return;
  }
  reply.type("application/json").send(task);
});

// --- GET /tasks ------------------------------------------------------------

app.get<{
  Querystring: { contextId?: string; state?: string; pageSize?: string };
}>("/tasks", async (request, reply) => {
  echoCorrelation(request, reply);
  if (!requireToken(request, reply)) return;

  const { contextId, state, pageSize } = request.query;
  const tasks = store.list({
    contextId,
    state,
    pageSize: pageSize ? Number(pageSize) : undefined,
  });
  reply.type("application/json").send({ tasks });
});

// --- POST /tasks/{id}:subscribe and POST /tasks/{id}:cancel ----------------
//
// The A2A action paths use a literal colon before the verb
// (`/tasks/{id}:subscribe`, `/tasks/{id}:cancel`). Fastify's radix router does
// not cleanly distinguish a parametric segment from a trailing `:verb` literal,
// so we register a single wildcard route and dispatch on the parsed suffix.

const ACTION_PATH = /^(.+):(subscribe|cancel)$/;

app.post<{ Params: { "*": string } }>("/tasks/*", async (request, reply) => {
  echoCorrelation(request, reply);
  if (!requireToken(request, reply)) return;

  const rest = request.params["*"];
  const match = ACTION_PATH.exec(rest);
  if (!match) {
    sendError(
      reply,
      404,
      "TASK_NOT_FOUND",
      `No task action ${rest}`,
      correlationOf(request),
    );
    return;
  }

  const taskId = match[1];
  const action = match[2];

  if (action === "subscribe") {
    handleSubscribe(request, reply, taskId);
    return;
  }
  handleCancel(request, reply, taskId);
});

/** POST /tasks/{id}:subscribe — stream a task's updates (§8/§9). */
function handleSubscribe(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
): void {
  const task = store.get(taskId);
  if (!task) {
    sendError(
      reply,
      404,
      "TASK_NOT_FOUND",
      `No task ${taskId}`,
      correlationOf(request),
    );
    return;
  }

  startSseResponse(request, reply);
  // Emit the current task snapshot, then attach as a live subscriber.
  writeSseEvent(reply, "task", taskEvent(task));
  if (isTerminal(task.status.state)) {
    for (const artifact of task.artifacts) {
      writeSseEvent(
        reply,
        "artifact-update",
        artifactUpdateEvent(task, artifact, false),
      );
    }
    writeSseEvent(
      reply,
      "status-update",
      statusUpdateEvent(task, task.status, true),
    );
    reply.raw.end();
    return;
  }

  const sub = store.addSubscriber(taskId, reply);
  request.raw.on("close", () => {
    if (sub) store.removeSubscriber(taskId, sub);
  });
}

/** POST /tasks/{id}:cancel — cancel an active task, else 409 (§8). */
function handleCancel(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
): void {
  const task = store.get(taskId);
  if (!task) {
    sendError(
      reply,
      404,
      "TASK_NOT_FOUND",
      `No task ${taskId}`,
      correlationOf(request),
    );
    return;
  }

  if (isTerminal(task.status.state)) {
    sendError(
      reply,
      409,
      "TASK_NOT_CANCELABLE",
      `Task ${task.id} is in terminal state ${task.status.state}`,
      correlationOf(request),
    );
    return;
  }

  const status: TaskStatus = {
    state: TaskState.CANCELED,
    timestamp: nowIso(),
    metadata: { phase: "canceled", display: "Transmission relay canceled." },
  };
  store.setStatus(task.id, status);
  log({
    event: "task_canceled",
    taskId: task.id,
    contextId: task.contextId,
    correlationId: correlationOf(request),
  });
  reply.type("application/json").send(store.get(task.id));
}

// --- Relay execution -------------------------------------------------------

function isTerminal(state: string): boolean {
  return (
    state === TaskState.COMPLETED ||
    state === TaskState.FAILED ||
    state === TaskState.CANCELED ||
    state === TaskState.REJECTED
  );
}

function senderOf(message: Message): string | undefined {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const sender = meta?.sender;
  return typeof sender === "string" ? sender : undefined;
}

/** Run all relay phases with no delay; mutate the task to COMPLETED. */
function runRelaySync(
  taskId: string,
  payload: Record<string, unknown>,
): void {
  for (const phase of RELAY_PHASES) {
    store.setStatus(taskId, {
      state: TaskState.WORKING,
      timestamp: nowIso(),
      metadata: { phase: phase.phase, display: phase.display },
    });
  }
  finishRelay(taskId, payload);
}

/** Stream all relay phases over SSE, then finalize the task (§9 ordering). */
async function runRelayStream(
  reply: FastifyReply,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const task = store.get(taskId);
  if (!task) return;

  // 1) exactly one `task` event (TASK_STATE_SUBMITTED).
  writeSseEvent(reply, "task", taskEvent(task));

  // 2) one or more status-update events (TASK_STATE_WORKING, progressing phase).
  for (const phase of RELAY_PHASES) {
    if (store.get(taskId)?.status.state === TaskState.CANCELED) return;
    await sleep(STEP_DELAY_MS);
    const status: TaskStatus = {
      state: TaskState.WORKING,
      timestamp: nowIso(),
      metadata: { phase: phase.phase, display: phase.display },
    };
    store.setStatus(taskId, status);
    const updated = store.get(taskId)!;
    writeSseEvent(
      reply,
      "status-update",
      statusUpdateEvent(updated, status, false),
    );
    store.broadcast(taskId, "status-update", statusUpdateEvent(updated, status, false));
    log({
      event: "relay_phase",
      taskId,
      contextId: task.contextId,
      phase: phase.phase,
    });
  }

  // 3) one artifact-update per artifact.
  const artifact = buildSecureTransmissionArtifact(payload);
  store.addArtifact(taskId, artifact);
  const withArtifact = store.get(taskId)!;
  writeSseEvent(
    reply,
    "artifact-update",
    artifactUpdateEvent(withArtifact, artifact, false),
  );
  store.broadcast(
    taskId,
    "artifact-update",
    artifactUpdateEvent(withArtifact, artifact, false),
  );

  // 4) final status-update: TASK_STATE_COMPLETED, "final": true.
  await sleep(STEP_DELAY_MS);
  const finalStatus: TaskStatus = {
    state: TaskState.COMPLETED,
    timestamp: nowIso(),
    metadata: { phase: COMPLETED_PHASE.phase, display: COMPLETED_PHASE.display },
  };
  store.setStatus(taskId, finalStatus);
  store.appendHistory(
    taskId,
    buildAgentMessage(
      task.contextId,
      AGENT_NAME,
      "Secure transmission relayed over the Fulcrum channel.",
    ),
  );
  const done = store.get(taskId)!;
  writeSseEvent(
    reply,
    "status-update",
    statusUpdateEvent(done, finalStatus, true),
  );
  store.broadcast(taskId, "status-update", statusUpdateEvent(done, finalStatus, true));

  log({ event: "relay_completed", taskId, contextId: task.contextId });
}

/** Attach the artifact + completed status synchronously (no SSE). */
function finishRelay(
  taskId: string,
  payload: Record<string, unknown>,
): void {
  const task = store.get(taskId);
  if (!task) return;
  const artifact = buildSecureTransmissionArtifact(payload);
  store.addArtifact(taskId, artifact);
  store.setStatus(taskId, {
    state: TaskState.COMPLETED,
    timestamp: nowIso(),
    metadata: { phase: COMPLETED_PHASE.phase, display: COMPLETED_PHASE.display },
  });
  store.appendHistory(
    taskId,
    buildAgentMessage(
      task.contextId,
      AGENT_NAME,
      "Secure transmission relayed over the Fulcrum channel.",
    ),
  );
  log({ event: "relay_completed_sync", taskId, contextId: task.contextId });
}

// --- SSE response bootstrap -------------------------------------------------

function startSseResponse(request: FastifyRequest, reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Correlation-ID": correlationOf(request) ?? "",
    "X-Trace-ID": traceOf(request) ?? "",
  });
  // Hijack so Fastify does not try to send its own response body.
  reply.hijack();
}

// --- Startup ----------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    log({ level: "error", event: "startup_failed", error: String(err) });
    process.exit(1);
  }

  const banner = [
    "========================================================",
    `  ${agentCard.name}  (${AGENT_LANGUAGE})`,
    `  ${agentCard.description}`,
    `  listening on http://${HOST}:${PORT}`,
    `  skills: ${SKILL_IDS.join(", ")}`,
    "========================================================",
  ].join("\n");
  process.stdout.write(`${banner}\n`);

  log({
    event: "agent_started",
    agent: AGENT_NAME,
    port: PORT,
    skills: SKILL_IDS,
    correlationId: randomUUID(),
  });
}

main();
