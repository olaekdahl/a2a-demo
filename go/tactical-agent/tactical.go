package main

import "math"

// tactical.go — domain logic for the Tactical Analysis Agent (§12.4).
//
// It reads the intelligence-report payload (under the "intelligence" key of the
// inbound data part), performs DETERMINISTIC risk scoring from the detected
// units, and returns a "tactical-assessment" artifact.
//
// Scoring formula (deterministic, no randomness), per docs/protocol.md §12.4.
// Every detected Imperial asset class contributes, weighted by how dangerous it
// is to a ground defense:
//
//	risk = min(100, round(
//	         star_destroyers * 4         // capital ships dominate the threat
//	       + at_at_walkers   * 2         // heavy walkers — the iconic Hoth threat
//	       + at_st_walkers   * 1         // light walkers add marginal pressure
//	       + probe_droids    * 1         // recon expands the engagement
//	       + stormtroopers   / 100 ))    // infantry density, normalized per 100
//
// With the canonical intelligence numbers (§12.2):
//
//	star_destroyers = 3    -> 3 * 4        = 12
//	at_at_walkers   = 12   -> 12 * 2       = 24
//	at_st_walkers   = 28   -> 28 * 1       = 28
//	probe_droids    = 9    -> 9 * 1        = 9
//	stormtroopers   = 1800 -> 1800 / 100   = 18
//	                                     total = 91
//
// 91 -> HIGH (>=70 HIGH, >=40 MODERATE, else LOW), exactly matching the
// contract's canonical tactical-assessment (risk_score 91 / HIGH).

// newAgent constructs the Tactical Analysis Agent (non-streaming, §12.4).
func newAgent(port string) *Agent {
	a := &Agent{
		Name:      agentName,
		Language:  language,
		Port:      port,
		Card:      buildAgentCard(),
		Store:     NewTaskStore(),
		Streaming: false,
	}
	a.produce = a.produceTacticalAssessment
	return a
}

// numFromAny coerces a decoded JSON value to int. Standard encoding/json decodes
// numbers into float64 when unmarshaling into interface{}, which is the case for
// our data parts.
func numFromAny(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

// extractIntelUnits pulls the detected_units map from the intelligence payload.
func extractIntelUnits(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	// The intelligence-report payload is nested under "intelligence".
	intel := payload
	if inner, ok := payload["intelligence"].(map[string]any); ok {
		intel = inner
	}
	if units, ok := intel["detected_units"].(map[string]any); ok {
		return units
	}
	return nil
}

// computeRisk applies the deterministic scoring formula (§12.4).
func computeRisk(units map[string]any) int {
	starDestroyers := numFromAny(units["star_destroyers"])
	atAtWalkers := numFromAny(units["at_at_walkers"])
	atStWalkers := numFromAny(units["at_st_walkers"])
	probeDroids := numFromAny(units["probe_droids"])
	stormtroopers := numFromAny(units["stormtroopers"])

	raw := float64(starDestroyers*4) +
		float64(atAtWalkers*2) +
		float64(atStWalkers*1) +
		float64(probeDroids*1) +
		float64(stormtroopers)/100.0

	risk := int(math.Round(raw))
	if risk > 100 {
		risk = 100
	}
	if risk < 0 {
		risk = 0
	}
	return risk
}

// threatLevelFor maps a risk score to a threat level (>=70 HIGH, >=40 MODERATE).
func threatLevelFor(risk int) string {
	switch {
	case risk >= 70:
		return "HIGH"
	case risk >= 40:
		return "MODERATE"
	default:
		return "LOW"
	}
}

// produceTacticalAssessment builds the tactical-assessment artifact (§12.4).
func (a *Agent) produceTacticalAssessment(req *SendMessageRequest) ([]Artifact, string, string) {
	payload := firstDataPart(req.Message)
	units := extractIntelUnits(payload)

	risk := computeRisk(units)
	threat := threatLevelFor(risk)

	data := map[string]any{
		"threat_level":       threat,
		"risk_score":         risk,
		"recommended_action": "REINFORCE_AND_EVACUATE_NONESSENTIAL_PERSONNEL",
		"priority_targets":   []string{"star_destroyers", "at_at_walkers", "orbital_probe_network"},
		"rationale":          "Detected Imperial strength exceeds local defensive capacity.",
	}

	artifact := Artifact{
		ArtifactId:  "art-" + newUUID(),
		Name:        "tactical-assessment",
		Description: "Deterministic tactical risk assessment of the engagement.",
		Parts: []Part{
			{Data: data, MediaType: "application/json"},
		},
		Metadata: map[string]any{"producedBy": a.Name},
	}

	display := "Threat level " + threat + "."
	return []Artifact{artifact}, "completed", display
}
