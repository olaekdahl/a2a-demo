package main

// agent_card.go — the static Agent Card for the Tactical Analysis Agent (§3,
// §12.4). The structure mirrors the other Go agents; only the name, description,
// url, capabilities, and skills differ.

const (
	agentName   = "tactical-agent"
	defaultPort = "8021"
	agentURL    = "http://tactical-agent:8021"
)

func buildAgentCard() AgentCard {
	return AgentCard{
		Name:        agentName,
		Description: "Resistance tactical analysis agent — deterministic risk scoring and strategy.",
		Provider: AgentProvider{
			Organization: "Rebel Alliance",
			Url:          "https://resistance.local",
		},
		Version: "1.0.0",
		Url:     agentURL,
		Capabilities: AgentCapabilities{
			Streaming:         false,
			PushNotifications: false,
		},
		DefaultInputModes:  []string{"text/plain", "application/json"},
		DefaultOutputModes: []string{"text/plain", "application/json"},
		Skills: []AgentSkill{
			{
				Id:          "calculate_risk",
				Name:        "Calculate Risk",
				Description: "Computes a deterministic threat/risk score from an intelligence report.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Calculate the risk of the Imperial buildup at Hoth"},
			},
			{
				Id:          "generate_strategy",
				Name:        "Generate Strategy",
				Description: "Produces a recommended defensive strategy for the engagement.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Generate a defensive strategy for Echo Base"},
			},
			{
				Id:          "prioritize_targets",
				Name:        "Prioritize Targets",
				Description: "Ranks priority targets by tactical value.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Prioritize the Imperial targets at Hoth"},
			},
			{
				Id:          "recommend_action",
				Name:        "Recommend Action",
				Description: "Recommends a course of action given the assessed threat level.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Recommend an action for the HIGH threat at Hoth"},
			},
		},
		SecuritySchemes: map[string]SecurityScheme{
			"demoApiKey": {Type: "apiKey", In: "header", Name: "X-Demo-Token"},
		},
		Security: []map[string][]string{
			{"demoApiKey": {}},
		},
	}
}
