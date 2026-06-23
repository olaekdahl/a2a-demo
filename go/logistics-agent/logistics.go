package main

// logistics.go — domain logic for the Logistics Agent (§12.5).
//
// It receives a text instruction plus a data part
// { "system": "Hoth", "tactical": {...}, "skill": "assess_transport_capacity" }
// and returns the DETERMINISTIC "logistics-assessment" artifact whose payload is
// fixed by the contract (no randomness), matching §12.5 exactly.

// newAgent constructs the Logistics Agent (non-streaming, §12.5).
func newAgent(port string) *Agent {
	a := &Agent{
		Name:      agentName,
		Language:  language,
		Port:      port,
		Card:      buildAgentCard(),
		Store:     NewTaskStore(),
		Streaming: false,
	}
	a.produce = a.produceLogisticsAssessment
	return a
}

// produceLogisticsAssessment builds the logistics-assessment artifact (§12.5).
// The numbers are the exact deterministic values defined in the contract.
func (a *Agent) produceLogisticsAssessment(req *SendMessageRequest) ([]Artifact, string, string) {
	data := map[string]any{
		"available_transports":    14,
		"available_x_wings":       22,
		"available_medical_units": 6,
		"fuel_percentage":         82,
		"evacuation_capacity":     4200,
		"recommended_troop_movement": map[string]any{
			"reinforce_echo_base":     1200,
			"evacuate_civilians":      700,
			"reserve_defensive_units": 300,
		},
	}

	artifact := Artifact{
		ArtifactId:  "art-" + newUUID(),
		Name:        "logistics-assessment",
		Description: "Transport, fuel, and troop-movement assessment for the operation.",
		Parts: []Part{
			{Data: data, MediaType: "application/json"},
		},
		Metadata: map[string]any{"producedBy": a.Name},
	}

	display := "14 transports available, fuel at 82%."
	return []Artifact{artifact}, "completed", display
}
