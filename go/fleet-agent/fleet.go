package main

// fleet.go — domain logic for the Fleet Movement Agent (§12.6).
//
// This agent STREAMS on /message:stream (capabilities.streaming = true) and runs
// synchronously on /message:send. It receives a text instruction plus a data
// part { "destination": "Hoth", "troops": {...}, "skill": "reinforce_planet" }
// and emits the progress phases (in order):
//
//	submitted -> calculating_hyperspace_route -> loading_transports ->
//	jump_to_lightspeed -> arriving_hoth_orbit -> deployed -> completed
//
// then returns the DETERMINISTIC "deployment-order" artifact (§12.6).
//
// The shared scaffolding (tasks.go) always emits the "submitted" task event
// first and the terminal "completed" final status-update; streamPhases below
// covers the intermediate working phases.

// newAgent constructs the Fleet Movement Agent (streaming, §12.6).
func newAgent(port string) *Agent {
	a := &Agent{
		Name:      agentName,
		Language:  language,
		Port:      port,
		Card:      buildAgentCard(),
		Store:     NewTaskStore(),
		Streaming: true,
		streamPhases: []phaseStep{
			{Phase: "calculating_hyperspace_route", Display: "Calculating hyperspace route to Hoth."},
			{Phase: "loading_transports", Display: "Loading transports at the rendezvous point."},
			{Phase: "jump_to_lightspeed", Display: "Punch it — jumping to lightspeed!"},
			{Phase: "arriving_hoth_orbit", Display: "Arriving in Hoth orbit."},
			{Phase: "deployed", Display: "Reinforcements deployed to Echo Base."},
		},
	}
	a.produce = a.produceDeploymentOrder
	return a
}

// produceDeploymentOrder builds the deployment-order artifact (§12.6). The
// numbers are the exact deterministic values defined in the contract.
func (a *Agent) produceDeploymentOrder(req *SendMessageRequest) ([]Artifact, string, string) {
	destination := "Hoth"
	if payload := firstDataPart(req.Message); payload != nil {
		if d, ok := payload["destination"].(string); ok && d != "" {
			destination = d
		}
	}

	data := map[string]any{
		"deployment_status": "DEPLOYED",
		"destination":       destination,
		"eta_minutes":       18,
		"units_deployed": map[string]any{
			"troop_transports": 8,
			"x_wing_squadrons": 3,
			"medical_units":    4,
			"ground_troops":    1200,
		},
		"transmission": "Rogue transports are inbound. Reinforcements en route to Echo Base.",
	}

	artifact := Artifact{
		ArtifactId:  "art-" + newUUID(),
		Name:        "deployment-order",
		Description: "Deterministic deployment order for the reinforcement of " + destination + ".",
		Parts: []Part{
			{Data: data, MediaType: "application/json"},
		},
		Metadata: map[string]any{"producedBy": a.Name},
	}

	display := "Reinforcements deployed to " + destination + "."
	return []Artifact{artifact}, "completed", display
}
