// Deterministic relay logic for the Communications Relay Agent (§12.3).
//
// checksum        = first 16 hex chars of SHA-256 of the canonical JSON of the
//                   incoming data payload.
// encoded_payload = base64 of that same canonical JSON.
//
// Canonical JSON = JSON.stringify with sorted keys (recursively). Both values
// are deterministic and verifiable by the receiver. Uses only Node built-in
// crypto (no extra dependencies).

import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Message } from "./schemas.js";
import { AGENT_NAME } from "./agentCard.js";

/**
 * Produce a canonical JSON string with recursively sorted object keys. Arrays
 * preserve order; objects have their keys sorted lexicographically. This makes
 * the serialization deterministic across implementations.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Extract the incoming data payload from the message. Prefers the first JSON
 * data part; falls back to an empty object so the relay never breaks.
 */
export function extractDataPayload(message: Message): Record<string, unknown> {
  for (const part of message.parts) {
    if (part.data && typeof part.data === "object" && part.data !== null) {
      return part.data as Record<string, unknown>;
    }
  }
  return {};
}

/** Result of the deterministic relay computation. */
export interface RelayResult {
  checksum: string;
  encodedPayload: string;
}

/**
 * Compute the deterministic checksum and base64 encoding for a payload.
 * checksum = first 16 hex of sha256(canonicalJson), encoded = base64(canonicalJson).
 */
export function computeRelay(payload: Record<string, unknown>): RelayResult {
  const canonical = canonicalJson(payload);
  const checksum = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 16);
  const encodedPayload = Buffer.from(canonical, "utf8").toString("base64");
  return { checksum, encodedPayload };
}

/**
 * Build the deterministic secure-transmission artifact (§12.3). The static
 * channel/signal/station values are fixed by the contract.
 */
export function buildSecureTransmissionArtifact(
  payload: Record<string, unknown>,
): Artifact {
  const { checksum, encodedPayload } = computeRelay(payload);

  const data = {
    encryption_channel: "Fulcrum",
    signal_strength: 0.97,
    relay_station: "Echo-Relay-7",
    checksum,
    encoded_payload: encodedPayload,
    verified: true,
    transmission: "Transmission secured over the Fulcrum channel.",
  };

  return {
    artifactId: `art-${randomUUID()}`,
    name: "secure-transmission",
    description: "Secure Resistance transmission relayed over the Fulcrum channel.",
    parts: [{ data, mediaType: "application/json" }],
    metadata: { producedBy: AGENT_NAME },
  };
}

/** Working phases streamed between SUBMITTED and COMPLETED for the relay. */
export interface RelayPhase {
  phase: string;
  display: string;
}

export const RELAY_PHASES: RelayPhase[] = [
  {
    phase: "encoding_payload",
    display: "Encoding payload for secure transmission...",
  },
  {
    phase: "securing_channel",
    display: "Securing the Fulcrum encryption channel...",
  },
  {
    phase: "verifying_integrity",
    display: "Verifying transmission integrity checksum...",
  },
];

/** The completed phase label/display (terminal status). */
export const COMPLETED_PHASE: RelayPhase = {
  phase: "completed",
  display: "Transmission secured over the Fulcrum channel.",
};
