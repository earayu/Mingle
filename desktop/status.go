package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// summary is Mingle's /v1/admin/summary: every agent in a line, for the menu bar.
type summary struct {
	Agents []agentSummary `json:"agents"`
}

type agentSummary struct {
	ID          string              `json:"id"`
	Slug        string              `json:"slug"`
	Name        string              `json:"name"`
	Status      string              `json:"status"`
	Task        *string             `json:"task"`
	Connections []connectionSummary `json:"connections"`
	Failed      int                 `json:"failed"`
	Unanswered  int                 `json:"unanswered"`
}

type connectionSummary struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	State    string `json:"state"`
	// Retrying is an offline connection Mingle tries again by itself (docs/spec.md 6.4).
	Retrying bool `json:"retrying"`
}

// notifyState is the state notifications go by: offline while Mingle retries on its own
// counts as reconnecting, so each automatic attempt does not notify "failed" again.
func (c connectionSummary) notifyState() string {
	if c.State == "error" && c.Retrying {
		return "reconnecting"
	}
	return c.State
}

// online is whether people can reach the agent: one of its chat apps is connected.
func (a agentSummary) online() bool {
	// A paused agent answers nobody, whatever its bots' state (docs/spec.md 4.11).
	if a.Status == "paused" {
		return false
	}
	for _, c := range a.Connections {
		if c.State == "connected" {
			return true
		}
	}
	return false
}

func fetchSummary(url, token string) (*summary, error) {
	req, err := http.NewRequest("GET", url+"/v1/admin/summary", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("summary: %s", resp.Status)
	}
	var s summary
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

// need is one thing that needs the owner, as the console's "Needs you" lists them.
type need struct {
	slug, label string
}

// needs lists what needs the owner: connections that failed or wait for an admin,
// and messages the agent could not or did not answer.
func needs(s *summary, t texts) []need {
	var out []need
	if s == nil {
		return out
	}
	for _, a := range s.Agents {
		for _, c := range a.Connections {
			if c.State == "error" || c.State == "awaiting_approval" {
				out = append(out, need{a.Slug, a.Name + " · " + t.connection(c.Platform, c.State)})
			}
		}
		if a.Failed > 0 {
			out = append(out, need{a.Slug, a.Name + " · " + t.failed(a.Failed)})
		}
		if a.Unanswered > 0 {
			out = append(out, need{a.Slug, a.Name + " · " + t.unanswered(a.Unanswered)})
		}
	}
	return out
}

// agentLine is what the menu says about one agent, under its name.
func agentLine(a agentSummary, t texts) string {
	if a.Status == "paused" {
		return t.status("paused")
	}
	if len(a.Connections) == 0 {
		return t.noChatApps
	}
	if !a.online() {
		for _, c := range a.Connections {
			if reason := t.connection(c.Platform, c.State); reason != "" {
				return t.offlineBecause(reason)
			}
		}
		return t.status("offline")
	}
	if a.Status == "working" && a.Task != nil && *a.Task != "" {
		return t.workingOn(*a.Task)
	}
	return t.status(a.Status)
}

// shownAgents picks the agents the menu lists by name: all of them up to five,
// else the ones that need the owner or are at work first. The rest go under "N more".
func shownAgents(s *summary) (shown, rest []agentSummary) {
	const most = 5
	if s == nil {
		return nil, nil
	}
	if len(s.Agents) <= most {
		return s.Agents, nil
	}
	pressing := func(a agentSummary) bool {
		if a.Failed > 0 || a.Unanswered > 0 || a.Status == "working" || a.Status == "thinking" || a.Status == "error" {
			return true
		}
		for _, c := range a.Connections {
			if c.State == "error" || c.State == "awaiting_approval" {
				return true
			}
		}
		return false
	}
	for _, first := range []bool{true, false} {
		for _, a := range s.Agents {
			if pressing(a) != first {
				continue
			}
			if len(shown) < most {
				shown = append(shown, a)
			} else {
				rest = append(rest, a)
			}
		}
	}
	return shown, rest
}

func onlineNames(s *summary) []string {
	var names []string
	if s == nil {
		return names
	}
	for _, a := range s.Agents {
		if a.online() {
			names = append(names, a.Name)
		}
	}
	return names
}

// note is a desktop notification about something that needs the owner; slug says
// which agent's page a click opens.
type note struct {
	id, slug, title, body string
}

// watcher turns successive summaries into notifications: only what needs the owner,
// each once. Answers reach people through the chat apps, which notify on their own.
type watcher struct {
	last *summary
	// down is when each connection started reconnecting; told is whether that was notified.
	down map[string]time.Time
	told map[string]bool
}

const downFor = 5 * time.Minute

func (w *watcher) next(s *summary, now time.Time, t texts) []note {
	if w.down == nil {
		w.down, w.told = map[string]time.Time{}, map[string]bool{}
	}
	before := map[string]connectionSummary{}
	failed := map[string]int{}
	if w.last != nil {
		for _, a := range w.last.Agents {
			failed[a.ID] = a.Failed
			for _, c := range a.Connections {
				before[c.ID] = c
			}
		}
	}
	first := w.last == nil
	w.last = s
	var out []note
	seen := map[string]bool{}
	for _, a := range s.Agents {
		if !first && a.Failed > failed[a.ID] {
			out = append(out, note{"failed:" + a.ID, a.Slug, t.failedTitle(a.Name), t.failedBody})
		}
		for _, c := range a.Connections {
			seen[c.ID] = true
			was, known := before[c.ID]
			state := c.notifyState()
			if state == "reconnecting" {
				if _, ok := w.down[c.ID]; !ok {
					w.down[c.ID] = now
				}
				if since := now.Sub(w.down[c.ID]); since >= downFor && !w.told[c.ID] {
					w.told[c.ID] = true
					out = append(out, note{"down:" + c.ID, a.Slug, t.downTitle(a.Name, c.Platform, int(since.Minutes())), t.downBody})
				}
			} else {
				delete(w.down, c.ID)
				delete(w.told, c.ID)
			}
			if first || !known || was.notifyState() == state {
				continue
			}
			switch {
			case state == "error":
				out = append(out, note{"error:" + c.ID, a.Slug, t.errorTitle(a.Name, c.Platform), t.errorBody})
			case state == "connected" && was.State == "awaiting_approval":
				out = append(out, note{"approved:" + c.ID, a.Slug, t.approvedTitle(c.Platform), t.approvedBody(a.Name, c.Platform)})
			}
		}
	}
	for id := range w.down {
		if !seen[id] {
			delete(w.down, id)
			delete(w.told, id)
		}
	}
	return out
}
