// Mingle's desktop app: a menu bar icon and a window around the same local
// console that `mingle start` serves. The app starts the Mingle process with
// the Node.js runtime it ships, keeps it running, and stops it on quit.
// See docs/spec.md, "桌面应用".
package main

import (
	_ "embed"
	"log"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

//go:embed resources/tray.png
var trayIcon []byte

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // the running app shows its window
	}
	logs, _ := mygo.App.Path(mygo.PathLogs)
	resources, _ := mygo.App.Path(mygo.PathResources)
	d := newDaemon(resources, logs)
	origin := d.origin()
	t := texts()

	mygo.Use(updater.Plugin)
	// A menu bar app: the Dock icon shows only while the window does.
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})

	var win *mygo.Window
	quitting := false
	show := func() {
		if win == nil {
			return
		}
		mygo.App.SetActivationPolicy(mygo.ActivationPolicyRegular)
		win.Show()
		win.Focus()
		mygo.App.Focus()
	}
	mygo.App.OnSecondInstance(func([]string, string) { show() })
	mygo.App.OnActivate(func(bool) { show() })
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { d.stop() })

	mygo.App.WhenReady(func() {
		mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
			{Label: "Mingle", Submenu: []*mygo.MenuItem{
				{Role: mygo.RoleAbout},
				updater.MenuItem(),
				mygo.Separator(),
				{Role: mygo.RoleHide},
				mygo.Separator(),
				{Role: mygo.RoleQuit},
			}},
			{Role: mygo.RoleEditMenu},
			{Role: mygo.RoleWindowMenu},
		}))

		win = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Mingle",
			Width:     1180,
			Height:    800,
			MinWidth:  720,
			MinHeight: 520,
			Hidden:    true,
			StateKey:  "main",
			// The console draws its own title bar: the traffic lights sit in the sidebar's
			// brand row, centred in its 52 points, and the sidebar shows the window's material.
			TitleBarStyle:        mygo.TitleBarHidden,
			TrafficLightPosition: &mygo.Point{X: 18, Y: 19},
			Transparent:          true,
			Vibrancy:             mygo.VibrancySidebar,
			// Trusted, so the page gets the title bar's insets and can move the window.
			Page: mygo.PageOptions{TrustedOrigins: []string{origin}},
			URL:  "data:text/html;charset=utf-8," + loadingPage(t.starting),
		})
		// Closing the window keeps Mingle running in the menu bar.
		win.OnClose(func(e *mygo.CloseEvent) {
			if quitting {
				return
			}
			e.PreventDefault()
			win.Hide()
			mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
		})
		if !mygo.App.WasOpenedAtLogin() {
			show()
		}

		loginItem := &mygo.MenuItem{Label: t.openAtLogin, Type: mygo.MenuItemCheckbox, Checked: mygo.App.OpenAtLogin()}
		loginItem.Click = func(item *mygo.MenuItem, _ *mygo.Window) {
			if err := mygo.App.SetOpenAtLogin(!mygo.App.OpenAtLogin()); err != nil {
				log.Println("open at login:", err)
			}
			item.Checked = mygo.App.OpenAtLogin()
		}
		status := &mygo.MenuItem{Label: t.starting, Disabled: true}
		tray, err := mygo.NewTray(mygo.TrayOptions{
			ID:             "mingle",
			Icon:           trayIcon,
			IconIsTemplate: true,
			ToolTip:        "Mingle",
			Menu: mygo.NewMenu([]*mygo.MenuItem{
				status,
				mygo.Separator(),
				{Label: t.open, Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
				{Label: t.logs, Click: func(*mygo.MenuItem, *mygo.Window) { go mygo.Shell.OpenPath(logs) }},
				mygo.Separator(),
				loginItem,
				updater.MenuItem(),
				mygo.Separator(),
				{Label: t.quit, Role: mygo.RoleQuit},
			}),
		})
		if err != nil {
			log.Println("tray:", err)
		}
		_ = tray

		// Each time Mingle (re)starts, point the window at its console.
		d.onReady = func(url, token string) {
			status.Label = t.running
			_ = win.Page().LoadURL(url + "/#token=" + token)
		}
		d.onDown = func(reason string) {
			status.Label = t.stopped
			_ = win.Page().LoadURL("data:text/html;charset=utf-8," + loadingPage(t.restarting+" "+reason))
		}
		go d.run()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

type strings_ struct {
	starting, restarting, running, stopped, open, logs, openAtLogin, quit string
}

func texts() strings_ {
	for _, lang := range mygo.App.PreferredLanguages() {
		if strings.HasPrefix(lang, "zh") {
			return strings_{
				starting:    "Mingle 正在启动…",
				restarting:  "Mingle 已停止，正在重新启动。",
				running:     "Mingle 正在运行",
				stopped:     "Mingle 已停止",
				open:        "打开 Mingle",
				logs:        "查看日志",
				openAtLogin: "登录时打开",
				quit:        "退出 Mingle",
			}
		}
		if strings.HasPrefix(lang, "en") {
			break
		}
	}
	return strings_{
		starting:    "Mingle is starting…",
		restarting:  "Mingle stopped and is restarting.",
		running:     "Mingle is running",
		stopped:     "Mingle has stopped",
		open:        "Open Mingle",
		logs:        "Show Logs",
		openAtLogin: "Open at Login",
		quit:        "Quit Mingle",
	}
}

// loadingPage is shown until the console answers, in the console's own look (DESIGN.md).
func loadingPage(text string) string {
	html := `<!doctype html><meta name="color-scheme" content="light dark"><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;font:13px -apple-system,system-ui,sans-serif;
background:light-dark(#fff,#161616);color:light-dark(#6b6b66,#9c9c96)}
</style><p>` + escape(text) + `</p>`
	return strings.NewReplacer("%", "%25", "#", "%23", "\n", "%0A").Replace(html)
}

func escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
