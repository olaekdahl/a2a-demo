package main

// models.go — A2A wire types shared across the Go agents.
// JSON tags match the protocol contract (docs/protocol.md) EXACTLY (camelCase).
// These structs are intentionally identical across the three Go agents so the
// A2A scaffolding stays consistent; only the domain logic + agent card differ.

// Part is one element of a Message or Artifact. It carries EITHER text OR data,
// never both. omitempty ensures an empty text/data is never serialized.
type Part struct {
	Text      *string `json:"text,omitempty"`
	Data      any     `json:"data,omitempty"`
	MediaType string  `json:"mediaType"`
}

// Message is a single A2A message in a task's history.
type Message struct {
	MessageId string         `json:"messageId"`
	ContextId string         `json:"contextId"`
	Role      string         `json:"role"`
	Parts     []Part         `json:"parts"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// Configuration is the optional request configuration block.
type Configuration struct {
	AcceptedOutputModes []string `json:"acceptedOutputModes,omitempty"`
}

// SendMessageRequest is the body of POST /message:send and POST /message:stream.
type SendMessageRequest struct {
	Message       Message        `json:"message"`
	Configuration *Configuration `json:"configuration,omitempty"`
}

// SendMessageResponse is the body returned by POST /message:send.
type SendMessageResponse struct {
	Task Task `json:"task"`
}

// TaskStatus is the current state of a Task.
type TaskStatus struct {
	State     string         `json:"state"`
	Timestamp string         `json:"timestamp"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// Artifact is a structured output produced by an agent.
type Artifact struct {
	ArtifactId  string         `json:"artifactId"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parts       []Part         `json:"parts"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

// Task is the unit of work tracked in the in-memory store.
type Task struct {
	Id        string     `json:"id"`
	ContextId string     `json:"contextId"`
	Status    TaskStatus `json:"status"`
	History   []Message  `json:"history"`
	Artifacts []Artifact `json:"artifacts"`
}

// ---- SSE event envelopes (§9) ----

// TaskEvent is the first event in a stream: { "kind": "task", "task": {...} }.
type TaskEvent struct {
	Kind string `json:"kind"`
	Task Task   `json:"task"`
}

// StatusUpdateEvent is a status-update SSE event.
type StatusUpdateEvent struct {
	Kind      string     `json:"kind"`
	TaskId    string     `json:"taskId"`
	ContextId string     `json:"contextId"`
	Status    TaskStatus `json:"status"`
	Final     bool       `json:"final"`
}

// ArtifactUpdateEvent is an artifact-update SSE event.
type ArtifactUpdateEvent struct {
	Kind      string   `json:"kind"`
	TaskId    string   `json:"taskId"`
	ContextId string   `json:"contextId"`
	Artifact  Artifact `json:"artifact"`
	Final     bool     `json:"final"`
}

// ---- Agent Card types (§3) ----

type AgentProvider struct {
	Organization string `json:"organization"`
	Url          string `json:"url"`
}

type AgentCapabilities struct {
	Streaming         bool `json:"streaming"`
	PushNotifications bool `json:"pushNotifications"`
}

type AgentSkill struct {
	Id          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	InputModes  []string `json:"inputModes"`
	OutputModes []string `json:"outputModes"`
	Examples    []string `json:"examples,omitempty"`
}

type SecurityScheme struct {
	Type string `json:"type"`
	In   string `json:"in"`
	Name string `json:"name"`
}

type AgentCard struct {
	Name               string                    `json:"name"`
	Description        string                    `json:"description"`
	Provider           AgentProvider             `json:"provider"`
	Version            string                    `json:"version"`
	Url                string                    `json:"url"`
	Capabilities       AgentCapabilities         `json:"capabilities"`
	DefaultInputModes  []string                  `json:"defaultInputModes"`
	DefaultOutputModes []string                  `json:"defaultOutputModes"`
	Skills             []AgentSkill              `json:"skills"`
	SecuritySchemes    map[string]SecurityScheme `json:"securitySchemes"`
	Security           []map[string][]string     `json:"security"`
}

// ---- Error body (§11) ----

type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	HttpStatus    int    `json:"httpStatus"`
	CorrelationId string `json:"correlationId"`
}

// ---- helpers ----

// textPtr returns a pointer to s (used to populate Part.Text safely).
func textPtr(s string) *string { return &s }
