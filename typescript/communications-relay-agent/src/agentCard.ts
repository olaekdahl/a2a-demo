// Agent Card for the Communications Relay Agent (§3 / §12.3).
// Returned verbatim at GET /.well-known/agent-card.json (no auth).

export const AGENT_NAME = "communications-relay-agent";
export const AGENT_LANGUAGE = "typescript";

/** The agent's own base URL (docker-compose service name + port). */
const SELF_URL = `http://${AGENT_NAME}:8012`;

export const agentCard = {
  name: AGENT_NAME,
  description: "Resistance secure communications relay agent.",
  provider: { organization: "Rebel Alliance", url: "https://resistance.local" },
  version: "1.0.0",
  url: SELF_URL,
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [
    {
      id: "relay_transmission",
      name: "Relay Transmission",
      description: "Wraps a payload as a secure Resistance transmission and relays it.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Relay the tactical and logistics payloads over Fulcrum"],
    },
    {
      id: "encode_transmission",
      name: "Encode Transmission",
      description: "Encodes a payload into a base64 secure transmission envelope.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Encode this transmission for the Fulcrum channel"],
    },
    {
      id: "decode_transmission",
      name: "Decode Transmission",
      description: "Decodes a previously encoded secure transmission.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Decode the intercepted Fulcrum transmission"],
    },
    {
      id: "verify_message_integrity",
      name: "Verify Message Integrity",
      description: "Verifies a transmission checksum against its payload.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Verify the integrity of this transmission"],
    },
  ],
  securitySchemes: {
    demoApiKey: { type: "apiKey", in: "header", name: "X-Demo-Token" },
  },
  security: [{ demoApiKey: [] }],
} as const;

/** Skill ids advertised by this agent (used in the startup banner). */
export const SKILL_IDS = agentCard.skills.map((s) => s.id);
