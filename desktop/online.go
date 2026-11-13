package main

import "github.com/egoist/mygo"

// Online lets the console show and change what keeps the agents online while the
// computer is on (docs/spec.md 9.1): the app opening at login, the computer kept
// awake on power, and notifications about what needs the owner. The menu bar has
// the first two as well; both stay in step through OnlineChanged.
type Online struct {
	tray *trayController
}

// OnlineState is what the console shows about staying online.
type OnlineState struct {
	OpenAtLogin   bool `json:"openAtLogin"`
	KeepAwake     bool `json:"keepAwake"`
	Notifications bool `json:"notifications"`
	// CardDismissed is set once the owner closed the console's "keep online" card.
	CardDismissed bool `json:"cardDismissed"`
	// Platform is "darwin", "windows" or "linux", for words that differ (closing the lid).
	Platform string `json:"platform"`
}

// OnlineChanged tells the console that one of these settings changed.
var OnlineChanged = mygo.NewEvent[OnlineState]("mingle:online")

func newOnline(tray *trayController) *Online {
	o := &Online{tray: tray}
	tray.onChange = o.broadcast
	return o
}

// State returns the settings.
func (o *Online) State() OnlineState {
	p := loadPrefs()
	return OnlineState{
		OpenAtLogin:   mygo.App.OpenAtLogin(),
		KeepAwake:     p.KeepAwake,
		Notifications: !p.NotificationsOff,
		CardDismissed: p.OnlineCardDismissed,
		Platform:      goos,
	}
}

// SetOpenAtLogin opens the app when the user logs in, or stops doing so.
func (o *Online) SetOpenAtLogin(on bool) {
	setOpenAtLogin(on)
	o.tray.changed()
}

// SetKeepAwake keeps the computer from sleeping while idle on power, while an agent is online.
func (o *Online) SetKeepAwake(on bool) {
	updatePrefs(func(p *prefs) { p.KeepAwake = on })
	o.tray.changed()
}

// SetNotifications turns the notifications about what needs the owner on or off.
func (o *Online) SetNotifications(on bool) {
	updatePrefs(func(p *prefs) { p.NotificationsOff = !on })
	o.broadcast()
}

// DismissCard hides the console's "keep your agents online" card for good.
func (o *Online) DismissCard() {
	updatePrefs(func(p *prefs) { p.OnlineCardDismissed = true })
	o.broadcast()
}

func (o *Online) broadcast() { _ = OnlineChanged.Broadcast(o.State()) }
