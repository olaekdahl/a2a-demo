// Deterministic scout mission logic for the Intelligence Agent (§12.2).
// No randomness — the domain numbers are the exact contract values so the
// demo is reproducible.

import { randomUUID } from "node:crypto";
import type { Artifact, Message } from "./schemas.js";
import { AGENT_NAME } from "./agentCard.js";

/** A single progress phase emitted while scouting. */
export interface ScoutPhase {
  /** status.metadata.phase — domain-specific progress label. */
  phase: string;
  /** status.metadata.display — human-friendly, Star-Wars-flavored string. */
  display: string;
}

/**
 * The "progressing" working phases streamed between SUBMITTED and COMPLETED
 * (§12.2 stream phases: scanning_orbit → scanning_surface → decoding_transmission).
 */
export const SCOUT_PHASES: ScoutPhase[] = [
  {
    phase: "scanning_orbit",
    display: "Scanning orbital space for Imperial vessels...",
  },
  {
    phase: "scanning_surface",
    display: "Scanning the surface for ground forces and installations...",
  },
  {
    phase: "decoding_transmission",
    display: "Decoding intercepted Imperial transmissions...",
  },
];

/** The completed phase label/display (terminal status). */
export const COMPLETED_PHASE: ScoutPhase = {
  phase: "completed",
  display: "Scan complete. Intelligence report ready.",
};

/**
 * Extract the target system name from the incoming message. Prefers the
 * `system` key in any JSON data part; falls back to "Hoth" (the canonical
 * Operation Echo Shield target).
 */
export function extractSystem(message: Message): string {
  for (const part of message.parts) {
    if (part.data && typeof part.data === "object" && part.data !== null) {
      const data = part.data as Record<string, unknown>;
      if (typeof data.system === "string" && data.system.length > 0) {
        return data.system;
      }
    }
  }
  return "Hoth";
}

/**
 * Build the deterministic intelligence-report artifact (§12.2). The payload
 * numbers are fixed by the contract.
 */
export function buildIntelligenceArtifact(system: string): Artifact {
  const payload = {
    system,
    empire_presence: true,
    confidence: 0.94,
    detected_units: {
      stormtroopers: 1800,
      at_at_walkers: 12,
      at_st_walkers: 28,
      star_destroyers: 3,
      probe_droids: 9,
    },
    transmission:
      "Imperial armor columns detected beyond the northern ridge.",
  };

  return {
    artifactId: `art-${randomUUID()}`,
    name: "intelligence-report",
    description: `Imperial activity scan of the ${system} system.`,
    parts: [{ data: payload, mediaType: "application/json" }],
    metadata: { producedBy: AGENT_NAME },
  };
}
