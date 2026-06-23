// Zod schemas for the A2A wire contract (§4–§7 of docs/protocol.md).
// Field names and enum values are NORMATIVE — do not rename them.

import { z } from "zod";

/** TaskState enum (§6) — string values are normative. */
export const TaskState = {
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
  COMPLETED: "TASK_STATE_COMPLETED",
  FAILED: "TASK_STATE_FAILED",
  CANCELED: "TASK_STATE_CANCELED",
  REJECTED: "TASK_STATE_REJECTED",
} as const;

export const TaskStateEnum = z.enum([
  TaskState.SUBMITTED,
  TaskState.WORKING,
  TaskState.INPUT_REQUIRED,
  TaskState.AUTH_REQUIRED,
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]);

export const RoleEnum = z.enum(["ROLE_USER", "ROLE_AGENT"]);

/**
 * A Part (§4) has EITHER `text` OR `data`, and `mediaType` is always present.
 */
export const PartSchema = z
  .object({
    text: z.string().optional(),
    data: z.unknown().optional(),
    mediaType: z.string(),
  })
  .refine(
    (p) => (p.text !== undefined) !== (p.data !== undefined),
    "A Part must have exactly one of `text` or `data`.",
  );

export type Part = z.infer<typeof PartSchema>;

/** A Message (§4). */
export const MessageSchema = z.object({
  messageId: z.string(),
  contextId: z.string(),
  role: RoleEnum,
  parts: z.array(PartSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

/** SendMessageRequest (§5). */
export const SendMessageRequestSchema = z.object({
  message: MessageSchema,
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
    })
    .partial()
    .optional(),
});

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/** TaskStatus (§6). */
export const TaskStatusSchema = z.object({
  state: TaskStateEnum,
  timestamp: z.string(),
  metadata: z
    .object({
      phase: z.string().optional(),
      display: z.string().optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Artifact (§7). */
export const ArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  parts: z.array(PartSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

/** Task (§6). */
export const TaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  history: z.array(MessageSchema),
  artifacts: z.array(ArtifactSchema),
});

export type Task = z.infer<typeof TaskSchema>;
