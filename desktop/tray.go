package main

import (
	"bytes"
	_ "embed"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

// Menu bar icons (macOS templates) and notification area icons (Windows, Linux),
// each normal, with a dot when something needs the owner, and faded while Mingle
// has stopped. Drawn by scripts/icons.mjs.
var (
	//go:embed resources/tray-attention.png
	trayAttention []byte
	//go:embed resources/tray-stopped.png
	trayStopped []byte
	//go:embed resources/tray-color.png
	trayColor []byte
	//go:embed resources/tray-color-attention.png
	trayColorAttention []byte
	//go:embed resources/tray-color-stopped.png
	trayColorStopped []byte
)

// NavigateEvent asks the console to show a page, such as an agent's, by its path.
var NavigateEvent = mygo.NewEvent[string]("mingle:navigate")

// trayController keeps the menu bar icon and its menu true to what Mingle does
// (docs/spec.md 9.1): which agents are online, what they do, what needs the owner.
// It also holds the computer awake when asked, and sends the notifications.
type trayController struct {
	t       texts
	tray    *mygo.Tray
	logs    string
	updates *Updates
	show    func()
	// onChange tells the console that the settings shown in the menu changed.
	onChange func()

	mu        sync.Mutex
	url       string
	token     string
	running   bool
	started   bool // Mingle answered once: when it stops now, it has stopped, not yet to start
	sum       *summary
	watch     watcher
	shown     string // the menu last set, to set it again only when it changes
	icon      string
	noteSlugs map[string]string
	awake     func()
	unNapped  func()

	dots map[string]*mygo.MenuIcon
}

func newTrayController(t texts, logs string, updates *Updates, show func()) *trayController {
	c := &trayController{t: t, logs: logs, updates: updates, show: show, noteSlugs: map[string]string{}}
	c.dots = map[string]*mygo.MenuIcon{}
	for name, rgb := range map[string]color.RGBA{
		// The console's status colours (DESIGN.md): green online, amber needs you, red error, grey offline.
		"online":  {0x2f, 0x9e, 0x5a, 0xff},
		"amber":   {0xdf, 0x86, 0x01, 0xff},
		"error":   {0xc3, 0x2c, 0x18, 0xff},
		"offline": {0x8a, 0x8a, 0x93, 0xff},
	} {
		if icon, err := mygo.NewMenuIcon(dotPNG(rgb), false); err == nil {
			c.dots[name] = icon
		}
	}
	return c
}

// start makes the icon and keeps it current until the app quits.
func (c *trayController) start() {
	icon, template := c.iconFor("normal")
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "mingle",
		Icon:           icon,
		IconIsTemplate: template,
		ToolTip:        "Mingle",
		Menu:           mygo.NewMenu([]*mygo.MenuItem{{Label: c.t.starting, Disabled: true}}),
	})
	if err != nil {
		log.Println("tray:", err)
		return
	}
	c.tray = tray
	// Windows opens the window on a click and the menu on a right click; Linux panels
	// send a click for a double click. On macOS a click opens the menu.
	if !isMac {
		tray.OnClick(c.show)
	}
	mygo.App.OnNotificationClick(func(id string) {
		c.mu.Lock()
		slug := c.noteSlugs[id]
		c.mu.Unlock()
		if slug != "" {
			c.openAgent(slug)
		} else if id != closeHintID {
			c.show()
		}
	})
	c.render()
	go func() {
		for {
			c.poll()
			time.Sleep(3 * time.Second)
		}
	}()
}

// ready is called each time Mingle (re)starts and answers at url.
func (c *trayController) ready(url, token string) {
	c.mu.Lock()
	c.url, c.token, c.running, c.started = url, token, true, true
	c.mu.Unlock()
	go c.poll()
}

// down is called when Mingle stopped; the app restarts it.
func (c *trayController) down() {
	c.mu.Lock()
	c.running = false
	c.sum = nil
	c.mu.Unlock()
	c.render()
	c.power()
}

func (c *trayController) poll() {
	c.mu.Lock()
	running, url, token := c.running, c.url, c.token
	c.mu.Unlock()
	if !running {
		return
	}
	s, err := fetchSummary(url, token)
	if err != nil {
		// A Mingle older than the app has no summary; one that went away is reported by the daemon.
		return
	}
	c.mu.Lock()
	c.sum = s
	notes := c.watch.next(s, time.Now(), c.t)
	c.mu.Unlock()
	c.render()
	c.power()
	c.notify(notes)
}

// refresh shows a change of the settings in the menu.
func (c *trayController) refresh() {
	c.render()
	c.power()
}

func (c *trayController) openAgent(slug string) {
	c.show()
	_ = NavigateEvent.Broadcast("/a/" + url.PathEscape(slug))
}

func (c *trayController) iconFor(state string) ([]byte, bool) {
	switch {
	case isMac && state == "attention":
		return trayAttention, true
	case isMac && state == "stopped":
		return trayStopped, true
	case isMac:
		return trayTemplate, true
	case state == "attention":
		return trayColorAttention, false
	case state == "stopped":
		return trayColorStopped, false
	default:
		return trayColor, false
	}
}

// render sets the icon, its tooltip and its menu, when they changed.
func (c *trayController) render() {
	if c.tray == nil {
		return
	}
	c.mu.Lock()
	running, started, s := c.running, c.started, c.sum
	c.mu.Unlock()
	t := c.t
	list := needs(s, t)
	online := len(onlineNames(s))

	state := "normal"
	switch {
	case !running && started:
		state = "stopped"
	case len(list) > 0:
		state = "attention"
	}

	var items []*mygo.MenuItem
	var key strings.Builder // what the menu shows, to tell whether it changed
	add := func(item *mygo.MenuItem) {
		items = append(items, item)
		key.WriteString(item.Label + "\x00" + item.Subtitle + "\x00")
		if item.Checked {
			key.WriteString("✓")
		}
		key.WriteString("\x01")
	}

	head := t.starting
	switch {
	case running:
		head = t.runningOnline(online)
	case started:
		head = t.stopped
	}
	add(&mygo.MenuItem{Label: head, Disabled: true})

	shown, rest := shownAgents(s)
	if len(shown) > 0 {
		add(mygo.Separator())
		for _, a := range shown {
			add(c.agentItem(a))
		}
		if len(rest) > 0 {
			more := &mygo.MenuItem{Label: t.others(len(rest))}
			for _, a := range rest {
				more.Submenu = append(more.Submenu, c.agentItem(a))
				key.WriteString(a.Name + agentLine(a, t))
			}
			add(more)
		}
	}
	if len(list) > 0 {
		add(mygo.Separator())
		item := &mygo.MenuItem{Label: t.needs(len(list))}
		for _, n := range list {
			slug := n.slug
			item.Submenu = append(item.Submenu, &mygo.MenuItem{
				Label: n.label,
				Click: func(*mygo.MenuItem, *mygo.Window) { c.openAgent(slug) },
			})
			key.WriteString(n.label)
		}
		add(item)
	}

	add(mygo.Separator())
	add(&mygo.MenuItem{Label: t.open, Accelerator: "CmdOrCtrl+O", Click: func(*mygo.MenuItem, *mygo.Window) { c.show() }})
	add(mygo.Separator())
	add(&mygo.MenuItem{
		Label:   t.openAtLogin,
		Type:    mygo.MenuItemCheckbox,
		Checked: mygo.App.OpenAtLogin(),
		Click: func(*mygo.MenuItem, *mygo.Window) {
			go func() {
				setOpenAtLogin(!mygo.App.OpenAtLogin())
				c.changed()
			}()
		},
	})
	add(&mygo.MenuItem{
		Label:   t.keepAwake,
		Type:    mygo.MenuItemCheckbox,
		Checked: loadPrefs().KeepAwake,
		Click: func(*mygo.MenuItem, *mygo.Window) {
			go func() {
				updatePrefs(func(p *prefs) { p.KeepAwake = !p.KeepAwake })
				c.changed()
			}()
		},
	})
	if u := c.updates.State(); u.Ready {
		add(&mygo.MenuItem{Label: t.restartToUpdate(u.Available), Click: func(*mygo.MenuItem, *mygo.Window) { go c.updates.Restart() }})
	} else {
		add(updater.MenuItem())
	}
	add(&mygo.MenuItem{Label: t.logs, Click: func(*mygo.MenuItem, *mygo.Window) { go mygo.Shell.OpenPath(c.logs) }})
	add(mygo.Separator())
	add(&mygo.MenuItem{Label: t.quit, Click: func(*mygo.MenuItem, *mygo.Window) { go c.quit() }})

	tip := "Mingle"
	if running {
		tip = t.toolTip(online, len(list))
	}

	c.mu.Lock()
	menuChanged := key.String() != c.shown
	iconChanged := state != c.icon
	c.shown, c.icon = key.String(), state
	c.mu.Unlock()
	if iconChanged {
		icon, template := c.iconFor(state)
		_ = c.tray.SetIcon(icon, template)
	}
	if menuChanged {
		c.tray.SetToolTip(tip)
		c.tray.SetMenu(mygo.NewMenu(items))
	}
}

func (c *trayController) agentItem(a agentSummary) *mygo.MenuItem {
	slug := a.Slug
	dot := "offline"
	switch {
	case a.Status == "error":
		dot = "error"
	case a.Failed > 0 || a.Unanswered > 0:
		dot = "amber"
	case a.online():
		dot = "online"
	}
	for _, conn := range a.Connections {
		if conn.State == "error" {
			dot = "error"
		} else if conn.State == "awaiting_approval" && dot != "error" {
			dot = "amber"
		}
	}
	return &mygo.MenuItem{
		Label:    a.Name,
		Subtitle: agentLine(a, c.t),
		Icon:     c.dots[dot],
		Click:    func(*mygo.MenuItem, *mygo.Window) { c.openAgent(slug) },
	}
}

// changed shows a settings change in the menu and in the console.
func (c *trayController) changed() {
	c.refresh()
	if c.onChange != nil {
		c.onChange()
	}
}

// power keeps macOS from napping the app while an agent is online, and the computer
// awake while idle when the owner asked, on power only (a laptop on battery sleeps).
func (c *trayController) power() {
	c.mu.Lock()
	online := c.running && len(onlineNames(c.sum)) > 0
	c.mu.Unlock()
	wantAwake := online && loadPrefs().KeepAwake && !mygo.Power.IsOnBattery()

	c.mu.Lock()
	defer c.mu.Unlock()
	if online && c.unNapped == nil {
		c.unNapped = mygo.Power.KeepRunning("Mingle keeps your agents online")
	} else if !online && c.unNapped != nil {
		c.unNapped()
		c.unNapped = nil
	}
	if wantAwake && c.awake == nil {
		c.awake = mygo.Power.KeepAwake("Mingle keeps your agents online", false)
	} else if !wantAwake && c.awake != nil {
		c.awake()
		c.awake = nil
	}
}

func (c *trayController) notify(notes []note) {
	if len(notes) == 0 || loadPrefs().NotificationsOff {
		return
	}
	for _, n := range notes {
		c.mu.Lock()
		c.noteSlugs[n.id] = n.slug
		c.mu.Unlock()
		if err := mygo.NewNotification(mygo.NotificationOptions{ID: n.id, Title: n.title, Body: n.body}).Show(); err != nil {
			log.Println("notification:", err)
		}
	}
}

// quit asks first when agents would stop answering, then quits.
func (c *trayController) quit() {
	c.mu.Lock()
	names := onlineNames(c.sum)
	c.mu.Unlock()
	if len(names) > 0 {
		res, err := mygo.Dialog.Message(mygo.MessageOptions{
			Type:          mygo.MessageWarning,
			Message:       c.t.quitTitle,
			Detail:        c.t.quitDetail(names),
			Buttons:       []string{c.t.quitButton, c.t.cancel},
			DefaultButton: 1,
			CancelButton:  1,
		})
		if err != nil || res.Button != 0 {
			return
		}
	}
	mygo.App.Quit()
}

const closeHintID = "close-hint"

// closeHint tells a Windows user, once, that closing the window keeps Mingle running:
// there, closing a window usually quits the program.
func (c *trayController) closeHint() {
	if !isWindows || loadPrefs().CloseHintShown {
		return
	}
	updatePrefs(func(p *prefs) { p.CloseHintShown = true })
	go func() {
		_ = mygo.NewNotification(mygo.NotificationOptions{ID: closeHintID, Title: c.t.closeHintTitle, Body: c.t.closeHintBody, Silent: true}).Show()
	}()
}

func setOpenAtLogin(on bool) {
	if err := mygo.App.SetOpenAtLogin(on); err != nil {
		log.Println("open at login:", err)
	}
}

// dotPNG draws a status dot for a menu item: 16 points at 2x, the dot in its middle.
func dotPNG(fill color.RGBA) []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	const r = 5.5
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			d := math.Hypot(float64(x)+0.5-size/2, float64(y)+0.5-size/2)
			a := math.Max(0, math.Min(1, r-d+0.5))
			if a > 0 {
				img.SetRGBA(x, y, color.RGBA{
					uint8(float64(fill.R) * a), uint8(float64(fill.G) * a), uint8(float64(fill.B) * a), uint8(255 * a),
				})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
