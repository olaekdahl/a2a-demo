package main

// agent_card.go — the static Agent Card for the Logistics Agent (§3, §12.5).
// The structure mirrors the other Go agents; only the name, description, url,
// capabilities, and skills differ.

const (
	agentName   = "logistics-agent"
	defaultPort = "8022"
	agentURL    = "http://logistics-agent:8022"
)

func buildAgentCard() AgentCard {
	return AgentCard{
		Name:        agentName,
		Description: "Resistance logistics agent — transport capacity, fuel, and troop movement planning.",
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
				Id:          "assess_transport_capacity",
				Name:        "Assess Transport Capacity",
				Description: "Assesses available transports, fuel, and evacuation capacity.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"How many transports can we spare for Hoth?"},
			},
			{
				Id:          "check_fuel",
				Name:        "Check Fuel",
				Description: "Reports fleet fuel reserves.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Check the fleet fuel reserves for the Hoth run"},
			},
			{
				Id:          "allocate_supplies",
				Name:        "Allocate Supplies",
				Description: "Allocates medical units and supplies for the operation.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Allocate medical units and supplies for Echo Base"},
			},
			{
				Id:          "plan_troop_movement",
				Name:        "Plan Troop Movement",
				Description: "Plans reinforcement, evacuation, and reserve troop movements.",
				InputModes:  []string{"text/plain", "application/json"},
				OutputModes: []string{"application/json"},
				Examples:    []string{"Plan the troop movement to reinforce Echo Base"},
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
