package main

// agent_card.go — the static Agent Card for the Fleet Movement Agent (§3,
// §12.6). The structure mirrors the other Go agents; only the name, description,
// url, capabilities (streaming = true), and skills differ.

const (
	agentName   = "fleet-agent"
	defaultPort = "8023"
	agentURL    = "http://fleet-agent:8023"
)

func buildAgentCard() AgentCard {
	return AgentCard{
		Name:        agentName,
		Description: "Resistance fleet movement agent — hyperspace routing, deployment, and reinforcement.",
		Provider: AgentProvider{
			Organization: "Rebel Alliance",
			Url:          "https://resistance.local",
		},
		Version: "1.0.0",
		Url:     agentURL,
		Capabilities: AgentCapabilities{
			Streaming:         true,
			PushNotifications: false,
		},
		DefaultInputModes:  []string{"text/plain", "application/json"},
		DefaultOutputModes: []string{"text/plain", "application/json"},
		Skills: []AgentSkill{
			{
				Id:          "move_fleet",
				Name:        "Move Fleet",
				Description: "Calculates a hyperspace route and moves the fleet to a destination.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Move the fleet to Hoth"},
			},
			{
				Id:          "deploy_troops",
				Name:        "Deploy Troops",
				Description: "Deploys ground troops and support units on arrival.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Deploy ground troops to Echo Base on Hoth"},
			},
			{
				Id:          "reinforce_planet",
				Name:        "Reinforce Planet",
				Description: "Reinforces a planet with transports, fighters, medical, and ground troops.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Reinforce Echo Base on Hoth"},
			},
			{
				Id:          "confirm_arrival",
				Name:        "Confirm Arrival",
				Description: "Confirms arrival and reports the deployment status.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Confirm the fleet's arrival at Hoth orbit"},
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
