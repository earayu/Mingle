package main

import (
	"reflect"
	"testing"
	"time"
)

func ptr(s string) *string { return &s }

func agent(name, status string, conns ...connectionSummary) agentSummary {
	return agentSummary{ID: "id-" + name, Slug: name, Name: name, Status: status, Connections: conns}
}

func conn(id, platform, state string) connectionSummary {
	return connectionSummary{ID: id, Platform: platform, State: state}
}

func TestAgentLine(t *testing.T) {
	zh := zhTexts()
	working := agent("alex", "working", conn("n1", "feishu", "connected"))
	working.Task = ptr("整理周报")
	cases := []struct {
		a    agentSummary
		want string
	}{
		{agent("alex", "idle", conn("n1", "feishu", "connected")), "空闲"},
		{working, "工作中：整理周报"},
		{agent("alex", "working", conn("n1", "feishu", "connected")), "工作中"},
		{agent("alex", "idle", conn("n1", "feishu", "error")), "离线：飞书连接出错"},
		{agent("alex", "idle", conn("n1", "slack", "awaiting_approval")), "离线：Slack等待管理员审核"},
		{agent("alex", "idle"), "还没有连接聊天软件"},
		// One chat app connected is enough to be online.
		{agent("alex", "thinking", conn("n1", "feishu", "error"), conn("n2", "telegram", "connected")), "思考中"},
		// Paused says so, even with a bot online or none at all.
		{agent("alex", "paused", conn("n1", "feishu", "connected")), "已暂停"},
		{agent("alex", "paused"), "已暂停"},
	}
	for _, c := range cases {
		if got := agentLine(c.a, zh); got != c.want {
			t.Errorf("agentLine(%+v) = %q, want %q", c.a, got, c.want)
		}
	}
}

func TestNeeds(t *testing.T) {
	en := enTexts()
	bob := agent("Bob", "idle", conn("n2", "feishu", "awaiting_approval"))
	bob.Failed, bob.Unanswered = 1, 2
	s := &summary{Agents: []agentSummary{
		agent("Alex", "idle", conn("n1", "telegram", "connected"), conn("n3", "discord", "error")),
		bob,
	}}
	got := needs(s, en)
	want := []need{
		{"Alex", "Alex · Discord connection failed"},
		{"Bob", "Bob · Feishu waiting for admin approval"},
		{"Bob", "Bob · 1 message not answered because of an error"},
		{"Bob", "Bob · 2 messages not answered"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("needs = %#v\nwant %#v", got, want)
	}
	if got := en.toolTip(1, len(got)); got != "Mingle — 4 things need you" {
		t.Errorf("toolTip = %q", got)
	}
	if got := zhTexts().runningOnline(1); got != "Mingle 正在运行 · 1 个 Agent 在线" {
		t.Errorf("runningOnline = %q", got)
	}
}

func TestShownAgents(t *testing.T) {
	s := &summary{}
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		s.Agents = append(s.Agents, agent(name, "idle", conn("n"+name, "telegram", "connected")))
	}
	s.Agents[6].Status = "working"
	s.Agents[5].Connections[0].State = "error"
	shown, rest := shownAgents(s)
	names := func(list []agentSummary) (out []string) {
		for _, a := range list {
			out = append(out, a.Name)
		}
		return out
	}
	if got := names(shown); !reflect.DeepEqual(got, []string{"f", "g", "a", "b", "c"}) {
		t.Errorf("shown = %v", got)
	}
	if got := names(rest); !reflect.DeepEqual(got, []string{"d", "e"}) {
		t.Errorf("rest = %v", got)
	}
	small := &summary{Agents: s.Agents[:3]}
	if shown, rest := shownAgents(small); len(shown) != 3 || rest != nil {
		t.Errorf("a short list shows all, in order: %v %v", names(shown), names(rest))
	}
}

func TestWatcherNotifiesOnlyWhatNeedsTheOwner(t *testing.T) {
	en := enTexts()
	var w watcher
	now := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	step := func(s *summary) []string {
		var ids []string
		for _, n := range w.next(s, now, en) {
			ids = append(ids, n.id+" "+n.title)
		}
		return ids
	}
	at := func(feishu, telegram string, failed int) *summary {
		a := agent("Alex", "idle", conn("n1", "feishu", feishu), conn("n2", "telegram", telegram))
		a.Failed = failed
		return &summary{Agents: []agentSummary{a}}
	}

	// What is already wrong when the app starts shows in the menu, not as a notification.
	if got := step(at("awaiting_approval", "error", 3)); got != nil {
		t.Fatalf("first look notified %v", got)
	}
	if got := step(at("connected", "error", 3)); !reflect.DeepEqual(got, []string{"approved:n1 Feishu approved"}) {
		t.Fatalf("approval: %v", got)
	}
	if got := step(at("error", "connected", 4)); !reflect.DeepEqual(got, []string{
		"failed:id-Alex Alex could not answer a message",
		"error:n1 Alex: Feishu connection failed",
	}) {
		t.Fatalf("error and failure: %v", got)
	}
	// Reconnecting briefly is normal; five minutes of it is worth a word, once.
	if got := step(at("connected", "reconnecting", 4)); got != nil {
		t.Fatalf("reconnecting: %v", got)
	}
	now = now.Add(4 * time.Minute)
	if got := step(at("connected", "reconnecting", 4)); got != nil {
		t.Fatalf("4 minutes: %v", got)
	}
	now = now.Add(time.Minute)
	if got := step(at("connected", "reconnecting", 4)); !reflect.DeepEqual(got, []string{"down:n2 Alex: Telegram disconnected for 5 minutes"}) {
		t.Fatalf("5 minutes: %v", got)
	}
	now = now.Add(time.Minute)
	if got := step(at("connected", "reconnecting", 4)); got != nil {
		t.Fatalf("told twice: %v", got)
	}
	// Back, then down again: the clock starts over.
	step(at("connected", "connected", 4))
	if got := step(at("connected", "reconnecting", 4)); got != nil {
		t.Fatalf("down again: %v", got)
	}

	// Offline while Mingle retries by itself flips between error and reconnecting: that is
	// being down, told once after five minutes, never "failed" on every attempt.
	step(at("connected", "connected", 4))
	retrying := func(state string) *summary {
		s := at("connected", state, 4)
		s.Agents[0].Connections[1].Retrying = state == "error"
		return s
	}
	for i := 0; i < 5; i++ {
		if got := step(retrying([]string{"error", "reconnecting"}[i%2])); got != nil {
			t.Fatalf("retry cycle %d: %v", i, got)
		}
		now = now.Add(time.Minute)
	}
	if got := step(retrying("error")); !reflect.DeepEqual(got, []string{"down:n2 Alex: Telegram disconnected for 5 minutes"}) {
		t.Fatalf("retrying 5 minutes: %v", got)
	}
}

func TestQuitDetail(t *testing.T) {
	if got := enTexts().quitDetail([]string{"Alex", "Bob", "Carol"}); got != "Alex, Bob and Carol will stop answering until you open Mingle again." {
		t.Errorf("en: %q", got)
	}
	if got := zhTexts().quitDetail([]string{"Alex", "Bob"}); got != "退出后，Alex、Bob 将不再回复消息，直到再次打开 Mingle。" {
		t.Errorf("zh: %q", got)
	}
}
