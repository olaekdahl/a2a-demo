package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// main.go — process entrypoint: structured JSON logging, startup banner, and the
// HTTP server. Shared scaffolding across the three Go agents; only newAgent()
// (in the domain file) differs.

const language = "go"

// newUUID returns a random hex token used for message/task/artifact ids.
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// extremely unlikely; fall back to a timestamp-derived value.
		return hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000000")))
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

// logLine emits a single structured JSON log line to stdout (§16).
func logLine(fields map[string]any) {
	fields["timestamp"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	data, err := json.Marshal(fields)
	if err != nil {
		fmt.Printf(`{"level":"error","event":"log_marshal_failed"}` + "\n")
		return
	}
	fmt.Println(string(data))
}

// logRequest emits a structured log line for an inbound request, pulling the
// conventional A2A correlation/trace ids and message metadata when present.
func logRequest(a *Agent, r *http.Request, event string, m *Message) {
	fields := map[string]any{
		"service":  a.Name,
		"language": a.Language,
		"level":    "info",
		"event":    event,
		"method":   r.Method,
		"path":     r.URL.Path,
	}
	if v := r.Header.Get("X-Correlation-ID"); v != "" {
		fields["correlationId"] = v
	}
	if v := r.Header.Get("X-Trace-ID"); v != "" {
		fields["traceId"] = v
	}
	if m != nil {
		if m.ContextId != "" {
			fields["contextId"] = m.ContextId
		}
		if m.Metadata != nil {
			if s, ok := m.Metadata["sender"].(string); ok {
				fields["sender"] = s
			}
			if rcp, ok := m.Metadata["recipient"].(string); ok {
				fields["recipient"] = rcp
			}
		}
	}
	logLine(fields)
}

// printBanner prints a clear startup banner with the agent name, language, port,
// and skills (§16).
func printBanner(a *Agent) {
	skillIds := make([]string, 0, len(a.Card.Skills))
	for _, s := range a.Card.Skills {
		skillIds = append(skillIds, s.Id)
	}
	border := strings.Repeat("=", 64)
	fmt.Println(border)
	fmt.Printf("  A2A AGENT ONLINE :: %s\n", a.Name)
	fmt.Printf("  language : %s\n", a.Language)
	fmt.Printf("  port     : %s\n", a.Port)
	fmt.Printf("  streaming: %t\n", a.Streaming)
	fmt.Printf("  skills   : %s\n", strings.Join(skillIds, ", "))
	fmt.Println(border)

	logLine(map[string]any{
		"service":  a.Name,
		"language": a.Language,
		"level":    "info",
		"event":    "startup",
		"port":     a.Port,
		"skills":   skillIds,
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	agent := newAgent(port)
	printBanner(agent)

	addr := "0.0.0.0:" + port
	server := &http.Server{
		Addr:    addr,
		Handler: agent.router(),
	}

	if err := server.ListenAndServe(); err != nil {
		logLine(map[string]any{
			"service":  agent.Name,
			"language": agent.Language,
			"level":    "error",
			"event":    "server_exit",
			"error":    err.Error(),
		})
		os.Exit(1)
	}
}
