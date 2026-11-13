package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
)

// prefs are the desktop app's own settings, kept in mingle-desktop.json in the
// app's data folder. Mingle's settings live with Mingle; these are about the app.
type prefs struct {
	// AutomaticDownloadsSet records that automatic downloads were turned on once,
	// so the user's later choice stays (see defaultAutomaticDownloads).
	AutomaticDownloadsSet bool `json:"automaticDownloadsSet,omitempty"`
	// KeepAwake keeps the computer from sleeping while idle, on power, while an agent is online.
	KeepAwake bool `json:"keepAwake,omitempty"`
	// NotificationsOff turns off the notifications about what needs the owner (on by default).
	NotificationsOff bool `json:"notificationsOff,omitempty"`
	// CloseHintShown records that Windows was told, once, that closing the window keeps Mingle running.
	CloseHintShown bool `json:"closeHintShown,omitempty"`
	// OnlineCardDismissed hides the console's "keep your agents online" card.
	OnlineCardDismissed bool `json:"onlineCardDismissed,omitempty"`
}

var (
	prefsMu   sync.Mutex
	prefsData *prefs
)

func prefsFile() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "mingle-desktop.json")
}

// loadPrefs returns a copy of the preferences, read from disk the first time.
func loadPrefs() prefs {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	return *loadedPrefs()
}

func loadedPrefs() *prefs {
	if prefsData == nil {
		prefsData = &prefs{}
		if file := prefsFile(); file != "" {
			if data, err := os.ReadFile(file); err == nil {
				_ = json.Unmarshal(data, prefsData)
			}
		}
	}
	return prefsData
}

// updatePrefs changes the preferences and saves them.
func updatePrefs(change func(p *prefs)) prefs {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	p := loadedPrefs()
	change(p)
	if file := prefsFile(); file != "" {
		if data, err := json.Marshal(p); err == nil {
			_ = os.MkdirAll(filepath.Dir(file), 0o755)
			_ = os.WriteFile(file, data, 0o644)
		}
	}
	return *p
}
