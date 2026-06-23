package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tasks.go — in-memory task store, all §8 endpoints, auth middleware, the §11
// JSON error helper, and the §9 SSE writer. This scaffolding is identical across
// the three Go agents; only the domain logic (the *.go domain file) and the
// agent card change.

// ---- in-memory task store ----

type TaskStore struct {
	mu    sync.Mutex
	tasks map[string]*Task
	order []string // insertion order for stable listing
}

func NewTaskStore() *TaskStore {
	return &TaskStore{tasks: make(map[string]*Task)}
}

func (s *TaskStore) Put(t *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tasks[t.Id]; !ok {
		s.order = append(s.order, t.Id)
	}
	s.tasks[t.Id] = t
}

func (s *TaskStore) Get(id string) (*Task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	return t, ok
}

func (s *TaskStore) Update(id string, fn func(*Task)) (*Task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return nil, false
	}
	fn(t)
	return t, true
}

func (s *TaskStore) List() []*Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Task, 0, len(s.order))
	for _, id := range s.order {
		if t, ok := s.tasks[id]; ok {
			out = append(out, t)
		}
	}
	return out
}

// ---- time helpers ----

// nowISO returns an ISO-8601 UTC timestamp with millisecond precision and a
// trailing Z, exactly as the contract requires (§6).
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// ---- error helper (§11) ----

func writeError(w http.ResponseWriter, r *http.Request, code string, status int, message string) {
	corr := r.Header.Get("X-Correlation-ID")
	body := ErrorBody{Error: ErrorDetail{
		Code:          code,
		Message:       message,
		HttpStatus:    status,
		CorrelationId: corr,
	}}
	echoTraceHeaders(w, r)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	echoTraceHeaders(w, r)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// echoTraceHeaders echoes correlation/trace ids back on the response (§1).
func echoTraceHeaders(w http.ResponseWriter, r *http.Request) {
	if v := r.Header.Get("X-Correlation-ID"); v != "" {
		w.Header().Set("X-Correlation-ID", v)
	}
	if v := r.Header.Get("X-Trace-ID"); v != "" {
		w.Header().Set("X-Trace-ID", v)
	}
}

// ---- content-type acceptance (§2) ----

// contentTypeOK accepts application/json and application/a2a+json (and empty,
// since some callers omit it). The media-type parameters (charset) are ignored.
func contentTypeOK(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return true
	}
	ct = strings.TrimSpace(strings.SplitN(ct, ";", 2)[0])
	ct = strings.ToLower(ct)
	return ct == "application/json" || ct == "application/a2a+json"
}

// ---- auth middleware (§1) ----

// requireToken wraps a handler and enforces the presence (not value) of the
// X-Demo-Token header, returning a §11 error body on 401.
func requireToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Demo-Token") == "" {
			writeError(w, r, "AUTH_REQUIRED", http.StatusUnauthorized, "Missing X-Demo-Token header")
			return
		}
		next(w, r)
	}
}

// ---- SSE writer (§9) ----

// sseWriter serializes A2A SSE events with flushing after every event.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newSSEWriter(w http.ResponseWriter, r *http.Request) (*sseWriter, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	echoTraceHeaders(w, r)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return &sseWriter{w: w, flusher: flusher}, true
}

// send writes one SSE event: "event: <kind>\n" then "data: <single-line-json>\n"
// then a blank line, and flushes.
func (s *sseWriter) send(kind string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\n", kind); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", data); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

// ---- request parsing ----

func parseSendRequest(r *http.Request) (*SendMessageRequest, error) {
	var req SendMessageRequest
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		return nil, err
	}
	return &req, nil
}

// firstDataPart returns the first part that carries a JSON data payload as a
// map, or nil if none. Used by domain logic to read the incoming payload.
func firstDataPart(m Message) map[string]any {
	for _, p := range m.Parts {
		if p.Data != nil {
			if mp, ok := p.Data.(map[string]any); ok {
				return mp
			}
		}
	}
	return nil
}

// ---- HTTP handlers ----

// Agent bundles the per-agent configuration and domain behavior the generic
// handlers need.
type Agent struct {
	Name     string
	Language string
	Port     string
	Card     AgentCard
	Store    *TaskStore

	// streaming indicates the agent advertises/serves SSE on /message:stream.
	Streaming bool

	// cardETag is the strong validator for the agent card (§17.1), computed once
	// at first access from the canonical JSON of the card and then cached.
	cardOnce sync.Once
	cardETag string

	// produce runs the domain work synchronously and returns the artifact(s)
	// plus the completed status metadata (phase/display).
	produce func(req *SendMessageRequest) (artifacts []Artifact, phase string, display string)

	// streamPhases lists the (phase,display) progress steps emitted for a
	// streaming agent between WORKING and COMPLETED.
	streamPhases []phaseStep
}

type phaseStep struct {
	Phase   string
	Display string
}

// handleHealth — GET /health (no auth).
func (a *Agent) handleHealth(w http.ResponseWriter, r *http.Request) {
	logRequest(a, r, "health", nil)
	writeJSON(w, r, http.StatusOK, map[string]string{
		"status":   "ok",
		"agent":    a.Name,
		"language": a.Language,
	})
}

// etag returns the strong validator for the agent card (§17.1). The canonical
// card JSON is marshaled once and the etag cached for the life of the process.
func (a *Agent) etag() string {
	a.cardOnce.Do(func() {
		canonical, err := json.Marshal(a.Card)
		if err != nil {
			a.cardETag = ""
			return
		}
		sum := sha256.Sum256(canonical)
		a.cardETag = `"a2a-` + hex.EncodeToString(sum[:])[:16] + `"`
	})
	return a.cardETag
}

// handleAgentCard — GET /.well-known/agent-card.json (no auth). Carries a strong
// ETag validator and honors conditional If-None-Match requests with 304 (§17.1).
func (a *Agent) handleAgentCard(w http.ResponseWriter, r *http.Request) {
	logRequest(a, r, "agent_card", nil)
	etag := a.etag()
	if etag != "" {
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			echoTraceHeaders(w, r)
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	writeJSON(w, r, http.StatusOK, a.Card)
}

// buildSubmittedTask creates a new Task in TASK_STATE_SUBMITTED with the inbound
// message recorded in history.
func (a *Agent) buildSubmittedTask(req *SendMessageRequest) *Task {
	ctxId := req.Message.ContextId
	if ctxId == "" {
		ctxId = "operation-echo-shield"
	}
	task := &Task{
		Id:        "task-" + newUUID(),
		ContextId: ctxId,
		Status: TaskStatus{
			State:     "TASK_STATE_SUBMITTED",
			Timestamp: nowISO(),
			Metadata:  map[string]any{"phase": "submitted", "display": "Task received."},
		},
		History:   []Message{req.Message},
		Artifacts: []Artifact{},
	}
	return task
}

// agentResponseMessage builds the ROLE_AGENT reply message added to history when
// work completes.
func (a *Agent) agentResponseMessage(ctxId, display string) Message {
	return Message{
		MessageId: "msg-" + newUUID(),
		ContextId: ctxId,
		Role:      "ROLE_AGENT",
		Parts:     []Part{{Text: textPtr(display), MediaType: "text/plain"}},
		Metadata: map[string]any{
			"sender": a.Name,
		},
	}
}

// runSync executes the domain work synchronously and returns the completed task.
func (a *Agent) runSync(req *SendMessageRequest) *Task {
	task := a.buildSubmittedTask(req)
	a.Store.Put(task)

	artifacts, phase, display := a.produce(req)

	a.Store.Update(task.Id, func(t *Task) {
		t.Artifacts = artifacts
		t.Status = TaskStatus{
			State:     "TASK_STATE_COMPLETED",
			Timestamp: nowISO(),
			Metadata:  map[string]any{"phase": phase, "display": display},
		}
		t.History = append(t.History, a.agentResponseMessage(t.ContextId, display))
	})
	final, _ := a.Store.Get(task.Id)
	return final
}

// handleMessageSend — POST /message:send. Runs synchronously, returns the
// completed Task wrapped in a SendMessageResponse (§5).
func (a *Agent) handleMessageSend(w http.ResponseWriter, r *http.Request) {
	if !contentTypeOK(r) {
		writeError(w, r, "BAD_REQUEST", http.StatusUnsupportedMediaType, "Unsupported Content-Type")
		return
	}
	req, err := parseSendRequest(r)
	if err != nil {
		writeError(w, r, "BAD_REQUEST", http.StatusBadRequest, "Invalid SendMessageRequest body: "+err.Error())
		return
	}
	logRequest(a, r, "message_send", &req.Message)
	task := a.runSync(req)
	writeJSON(w, r, http.StatusOK, SendMessageResponse{Task: *task})
}

// handleMessageStream — POST /message:stream. For streaming agents this emits
// the full §9 SSE sequence; for non-streaming agents it still produces a valid
// stream (task → working → artifact(s) → completed) so the endpoint always works.
func (a *Agent) handleMessageStream(w http.ResponseWriter, r *http.Request) {
	if !contentTypeOK(r) {
		writeError(w, r, "BAD_REQUEST", http.StatusUnsupportedMediaType, "Unsupported Content-Type")
		return
	}
	req, err := parseSendRequest(r)
	if err != nil {
		writeError(w, r, "BAD_REQUEST", http.StatusBadRequest, "Invalid SendMessageRequest body: "+err.Error())
		return
	}
	logRequest(a, r, "message_stream", &req.Message)

	task := a.buildSubmittedTask(req)
	a.Store.Put(task)

	sse, ok := newSSEWriter(w, r)
	if !ok {
		writeError(w, r, "INTERNAL", http.StatusInternalServerError, "Streaming unsupported by server")
		return
	}
	a.streamTask(sse, task, req)
}

// streamTask runs the domain work while emitting the §9 SSE sequence.
func (a *Agent) streamTask(sse *sseWriter, task *Task, req *SendMessageRequest) {
	// 1. one task event (TASK_STATE_SUBMITTED).
	if err := sse.send("task", TaskEvent{Kind: "task", Task: *task}); err != nil {
		return
	}

	// 2. status-update events: TASK_STATE_WORKING with progressing phases.
	phases := a.streamPhases
	if len(phases) == 0 {
		phases = []phaseStep{{Phase: "processing", Display: "Working on it."}}
	}
	for _, ph := range phases {
		// honor cancellation between phases
		if cur, ok := a.Store.Get(task.Id); ok && cur.Status.State == "TASK_STATE_CANCELED" {
			return
		}
		status := TaskStatus{
			State:     "TASK_STATE_WORKING",
			Timestamp: nowISO(),
			Metadata:  map[string]any{"phase": ph.Phase, "display": ph.Display},
		}
		a.Store.Update(task.Id, func(t *Task) { t.Status = status })
		evt := StatusUpdateEvent{
			Kind:      "status-update",
			TaskId:    task.Id,
			ContextId: task.ContextId,
			Status:    status,
			Final:     false,
		}
		if err := sse.send("status-update", evt); err != nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}

	// 3. produce artifacts, emit one artifact-update per artifact.
	artifacts, phase, display := a.produce(req)
	for _, art := range artifacts {
		evt := ArtifactUpdateEvent{
			Kind:      "artifact-update",
			TaskId:    task.Id,
			ContextId: task.ContextId,
			Artifact:  art,
			Final:     false,
		}
		if err := sse.send("artifact-update", evt); err != nil {
			return
		}
	}

	// commit final state to the store.
	a.Store.Update(task.Id, func(t *Task) {
		t.Artifacts = artifacts
		t.Status = TaskStatus{
			State:     "TASK_STATE_COMPLETED",
			Timestamp: nowISO(),
			Metadata:  map[string]any{"phase": phase, "display": display},
		}
		t.History = append(t.History, a.agentResponseMessage(t.ContextId, display))
	})

	// 4. final status-update: TASK_STATE_COMPLETED, final: true.
	finalStatus := TaskStatus{
		State:     "TASK_STATE_COMPLETED",
		Timestamp: nowISO(),
		Metadata:  map[string]any{"phase": phase, "display": display},
	}
	finalEvt := StatusUpdateEvent{
		Kind:      "status-update",
		TaskId:    task.Id,
		ContextId: task.ContextId,
		Status:    finalStatus,
		Final:     true,
	}
	_ = sse.send("status-update", finalEvt)
}

// handleGetTask — GET /tasks/{id}.
func (a *Agent) handleGetTask(w http.ResponseWriter, r *http.Request, id string) {
	logRequest(a, r, "get_task", nil)
	t, ok := a.Store.Get(id)
	if !ok {
		writeError(w, r, "TASK_NOT_FOUND", http.StatusNotFound, "No task "+id)
		return
	}
	writeJSON(w, r, http.StatusOK, t)
}

// handleListTasks — GET /tasks with optional contextId, state, pageSize filters.
func (a *Agent) handleListTasks(w http.ResponseWriter, r *http.Request) {
	logRequest(a, r, "list_tasks", nil)
	q := r.URL.Query()
	wantCtx := q.Get("contextId")
	wantState := q.Get("state")
	pageSize := 50
	if ps := q.Get("pageSize"); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil && n > 0 {
			pageSize = n
		}
	}
	all := a.Store.List()
	out := make([]*Task, 0, len(all))
	for _, t := range all {
		if wantCtx != "" && t.ContextId != wantCtx {
			continue
		}
		if wantState != "" && t.Status.State != wantState {
			continue
		}
		out = append(out, t)
		if len(out) >= pageSize {
			break
		}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"tasks": out})
}

// handleSubscribe — POST /tasks/{id}:subscribe. Replays the current task as a
// task event, then (if still active) the working/completed sequence; if already
// completed it emits task → completed final.
func (a *Agent) handleSubscribe(w http.ResponseWriter, r *http.Request, id string) {
	logRequest(a, r, "subscribe", nil)
	t, ok := a.Store.Get(id)
	if !ok {
		writeError(w, r, "TASK_NOT_FOUND", http.StatusNotFound, "No task "+id)
		return
	}
	sse, ok := newSSEWriter(w, r)
	if !ok {
		writeError(w, r, "INTERNAL", http.StatusInternalServerError, "Streaming unsupported by server")
		return
	}
	// one task event first.
	if err := sse.send("task", TaskEvent{Kind: "task", Task: *t}); err != nil {
		return
	}
	// replay existing artifacts.
	for _, art := range t.Artifacts {
		evt := ArtifactUpdateEvent{
			Kind:      "artifact-update",
			TaskId:    t.Id,
			ContextId: t.ContextId,
			Artifact:  art,
			Final:     false,
		}
		if err := sse.send("artifact-update", evt); err != nil {
			return
		}
	}
	// final status-update reflecting the task's current status.
	final := t.Status.State == "TASK_STATE_COMPLETED" ||
		t.Status.State == "TASK_STATE_CANCELED" ||
		t.Status.State == "TASK_STATE_FAILED"
	evt := StatusUpdateEvent{
		Kind:      "status-update",
		TaskId:    t.Id,
		ContextId: t.ContextId,
		Status:    t.Status,
		Final:     final,
	}
	_ = sse.send("status-update", evt)
}

// handleCancel — POST /tasks/{id}:cancel.
func (a *Agent) handleCancel(w http.ResponseWriter, r *http.Request, id string) {
	logRequest(a, r, "cancel", nil)
	t, ok := a.Store.Get(id)
	if !ok {
		writeError(w, r, "TASK_NOT_FOUND", http.StatusNotFound, "No task "+id)
		return
	}
	terminal := map[string]bool{
		"TASK_STATE_COMPLETED": true,
		"TASK_STATE_CANCELED":  true,
		"TASK_STATE_FAILED":    true,
		"TASK_STATE_REJECTED":  true,
	}
	if terminal[t.Status.State] {
		writeError(w, r, "TASK_NOT_CANCELABLE", http.StatusConflict, "Task "+id+" is not cancelable in state "+t.Status.State)
		return
	}
	updated, _ := a.Store.Update(id, func(t *Task) {
		t.Status = TaskStatus{
			State:     "TASK_STATE_CANCELED",
			Timestamp: nowISO(),
			Metadata:  map[string]any{"phase": "canceled", "display": "Task canceled."},
		}
	})
	writeJSON(w, r, http.StatusOK, updated)
}

// router dispatches all §8 endpoints. /health and the agent card are unauthed;
// everything else requires X-Demo-Token.
func (a *Agent) router() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		a.handleHealth(w, r)
	})

	mux.HandleFunc("/.well-known/agent-card.json", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		a.handleAgentCard(w, r)
	})

	mux.HandleFunc("/message:send", requireToken(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		a.handleMessageSend(w, r)
	}))

	mux.HandleFunc("/message:stream", requireToken(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		a.handleMessageStream(w, r)
	}))

	mux.HandleFunc("/tasks", requireToken(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		a.handleListTasks(w, r)
	}))

	// /tasks/{id}, /tasks/{id}:subscribe, /tasks/{id}:cancel
	mux.HandleFunc("/tasks/", requireToken(func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/tasks/")
		switch {
		case strings.HasSuffix(rest, ":subscribe"):
			if r.Method != http.MethodPost {
				writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
				return
			}
			id := strings.TrimSuffix(rest, ":subscribe")
			a.handleSubscribe(w, r, id)
		case strings.HasSuffix(rest, ":cancel"):
			if r.Method != http.MethodPost {
				writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
				return
			}
			id := strings.TrimSuffix(rest, ":cancel")
			a.handleCancel(w, r, id)
		default:
			if r.Method != http.MethodGet {
				writeError(w, r, "BAD_REQUEST", http.StatusMethodNotAllowed, "Method not allowed")
				return
			}
			a.handleGetTask(w, r, rest)
		}
	}))

	return mux
}
