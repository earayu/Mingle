package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

// Updates lets the console show the app's updates: a new version that is
// downloading or ready, and a button to restart into it. The updater plugin
// checks in the background and, unless the user turned it off, downloads and
// installs new versions without asking; they run at the next launch, or now
// when the user restarts from the console. See docs/spec.md, "桌面应用".
type Updates struct {
	mu    sync.Mutex
	ready string // the version installed while the app runs, "" before
}

// UpdateState is what the console shows about updates.
type UpdateState struct {
	// Supported is false where the app cannot update itself: development
	// builds and installs by a package manager.
	Supported bool `json:"supported"`
	// Current is the version that runs.
	Current string `json:"current"`
	// Available is a newer version that a check found, or "".
	Available string `json:"available,omitzero"`
	// Ready is set once Available is installed: restarting runs it.
	Ready bool `json:"ready"`
	// AutomaticDownloads is whether new versions install without asking.
	AutomaticDownloads bool `json:"automaticDownloads"`
}

// UpdatesChanged tells the console that the state of updates changed.
var UpdatesChanged = mygo.NewEvent[UpdateState]("mingle:updates")

func newUpdates() *Updates {
	u := &Updates{}
	mygo.App.WhenReady(func() {
		defaultAutomaticDownloads()
		updater.OnChange(u.broadcast)
		updater.OnInstalled(func() {
			u.mu.Lock()
			u.ready = updater.AvailableVersion()
			u.mu.Unlock()
			u.broadcast()
		})
	})
	return u
}

// State returns the state of updates.
func (u *Updates) State() UpdateState {
	u.mu.Lock()
	ready := u.ready
	u.mu.Unlock()
	s := UpdateState{
		Supported:          mygo.Updater.Enabled(),
		Current:            mygo.App.Version(),
		Available:          updater.AvailableVersion(),
		AutomaticDownloads: updater.AutomaticDownloads(),
	}
	if ready != "" {
		s.Available, s.Ready = ready, true
	}
	return s
}

// Check checks for updates as the user asked: the update window shows, with
// the release notes of a new version and its download progress.
func (u *Updates) Check() { updater.CheckForUpdates() }

// Restart quits the app and opens it again, running the update that is ready.
func (u *Updates) Restart() {
	if u.State().Ready {
		mygo.App.Relaunch()
	}
}

// SetAutomaticDownloads turns installing new versions without asking on or off.
func (u *Updates) SetAutomaticDownloads(on bool) { updater.SetAutomaticDownloads(on) }

func (u *Updates) broadcast() { _ = UpdatesChanged.Broadcast(u.State()) }

// defaultAutomaticDownloads turns automatic downloads on the first time the app
// runs, so that updates come without asking: the update window and the console
// can turn them off, and that choice stays.
func defaultAutomaticDownloads() {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return
	}
	file := filepath.Join(dir, "mingle-desktop.json")
	var prefs struct {
		AutomaticDownloadsSet bool `json:"automaticDownloadsSet"`
	}
	if data, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(data, &prefs)
	}
	if prefs.AutomaticDownloadsSet {
		return
	}
	updater.SetAutomaticDownloads(true)
	prefs.AutomaticDownloadsSet = true
	if data, err := json.Marshal(prefs); err == nil {
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(file, data, 0o644)
	}
}
