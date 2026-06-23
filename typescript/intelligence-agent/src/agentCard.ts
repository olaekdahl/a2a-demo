// Agent Card for the Intelligence Agent (§3 / §12.2).
// Returned verbatim at GET /.well-known/agent-card.json (no auth).

export const AGENT_NAME = "intelligence-agent";
export const AGENT_LANGUAGE = "typescript";

/** The agent's own base URL (docker-compose service name + port). */
const SELF_URL = `http://${AGENT_NAME}:8011`;

export const agentCard = {
  name: AGENT_NAME,
  description: "Resistance intelligence scouting agent.",
  provider: { organization: "Rebel Alliance", url: "https://resistance.local" },
  version: "1.0.0",
  url: SELF_URL,
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [
    {
      id: "scout_system",
      name: "Scout Star System",
      description: "Scans a star system for Imperial activity.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Scout Hoth for Imperial movement"],
    },
    {
      id: "detect_empire_presence",
      name: "Detect Empire Presence",
      description: "Detects whether Imperial forces are present in a system.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Detect Empire presence near Hoth"],
    },
    {
      id: "estimate_force_strength",
      name: "Estimate Force Strength",
      description: "Estimates the size and composition of detected Imperial forces.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Estimate Imperial force strength on Hoth"],
    },
    {
      id: "produce_intelligence_report",
      name: "Produce Intelligence Report",
      description: "Compiles a full intelligence report for a scouted system.",
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      examples: ["Produce an intelligence report for the Hoth system"],
    },
  ],
  securitySchemes: {
    demoApiKey: { type: "apiKey", in: "header", name: "X-Demo-Token" },
  },
  security: [{ demoApiKey: [] }],
} as const;

/** Skill ids advertised by this agent (used in the startup banner). */
export const SKILL_IDS = agentCard.skills.map((s) => s.id);
