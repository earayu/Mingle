package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// daemon runs `mingle start` with the bundled Node.js and keeps it running.
// When a Mingle started elsewhere (a terminal) is already running on the same
// data directory, the app shows that one and leaves it alone.
type daemon struct {
	node, entry, home, logs string
	// port is where the Mingle this app starts listens; the window trusts that origin.
	port    int
	onReady func(url, token string)
	onDown  func(reason string)

	mu  sync.Mutex
	cmd *exec.Cmd
	// stdin is Mingle's standard input, which it watches: closing it stops Mingle on
	// every system (Windows has no SIGTERM), and the OS closes it if this app dies.
	stdin    io.Closer
	done     chan struct{} // closed when cmd exits
	stopping bool
}

type runtimeFile struct {
	URL        string `json:"url"`
	AdminToken string `json:"adminToken"`
	PID        int    `json:"pid"`
}

func newDaemon(resources, logs string) *daemon {
	home := os.Getenv("MINGLE_HOME")
	if home == "" {
		userHome, _ := os.UserHomeDir()
		home = filepath.Join(userHome, ".mingle")
	}
	d := &daemon{home: home, logs: logs}
	// The packaged app ships Node.js and Mingle among its resources. A development
	// build (`go run`, `mygo dev`) uses the Node.js on PATH and the repository's build.
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	d.node = filepath.Join(resources, "node", "bin", "node"+exe)
	d.entry = filepath.Join(resources, "core", "dist", "cli", "main.js")
	if _, err := os.Stat(d.entry); err != nil {
		d.entry = filepath.Join(resources, "..", "..", "dist", "cli", "main.js")
	}
	if _, err := os.Stat(d.node); err != nil {
		if found, err := exec.LookPath("node"); err == nil {
			d.node = found
		}
	}
	return d
}

// origin is the address the window will show: a Mingle already running on this data, or
// the one this app is about to start, on its usual port when that is free.
func (d *daemon) origin() string {
	if rt, ok := d.runtime(); ok && healthy(rt.URL) {
		return rt.URL
	}
	d.port = 7419
	if l, err := net.Listen("tcp", "127.0.0.1:7419"); err == nil {
		l.Close()
	} else if l, err := net.Listen("tcp", "127.0.0.1:0"); err == nil {
		d.port = l.Addr().(*net.TCPAddr).Port
		l.Close()
	}
	return "http://127.0.0.1:" + strconv.Itoa(d.port)
}

func (d *daemon) runtime() (runtimeFile, bool) {
	var rt runtimeFile
	data, err := os.ReadFile(filepath.Join(d.home, "runtime.json"))
	if err != nil || json.Unmarshal(data, &rt) != nil || rt.URL == "" {
		return rt, false
	}
	return rt, true
}

func healthy(url string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url + "/v1/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// run starts Mingle and restarts it when it exits, until the app quits.
func (d *daemon) run() {
	failures := 0
	for {
		if rt, ok := d.runtime(); ok && healthy(rt.URL) {
			// Someone else's Mingle: show it, and watch for it to go away.
			d.onReady(rt.URL, rt.AdminToken)
			for healthy(rt.URL) {
				time.Sleep(5 * time.Second)
			}
			if d.isStopping() {
				return
			}
			d.onDown("")
			continue
		}
		started := time.Now()
		err := d.startAndWait()
		if d.isStopping() {
			return
		}
		if time.Since(started) > time.Minute {
			failures = 0
		}
		failures++
		reason := ""
		if err != nil {
			reason = err.Error()
			log.Println("mingle:", err)
		}
		d.onDown(reason)
		time.Sleep(min(time.Duration(failures*failures)*time.Second, 30*time.Second))
	}
}

func (d *daemon) isStopping() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.stopping
}

// startAndWait starts one Mingle process, reports it ready, and returns when it exits.
func (d *daemon) startAndWait() error {
	if err := os.MkdirAll(d.logs, 0o755); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(d.logs, "mingle.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	// --login-shell-env: Mingle takes the user's login-shell environment (PATH, API keys,
	// base URLs, proxies set in ~/.zshrc), which apps opened from Finder or a Linux
	// desktop do not get, and puts the bundled Node.js last on PATH.
	cmd := exec.Command(d.node, d.entry, "start", "--no-open", "--stop-on-stdin-close", "--login-shell-env", "--port", strconv.Itoa(d.port))
	cmd.Env = withShell(os.Environ())
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	// The console URL with the admin token goes to stdout; keep it out of the log file.
	cmd.Stdout = io.Discard
	cmd.Stderr = logFile
	d.mu.Lock()
	if d.stopping {
		d.mu.Unlock()
		return nil
	}
	if err := cmd.Start(); err != nil {
		d.mu.Unlock()
		return fmt.Errorf("could not start Mingle: %w", err)
	}
	done := make(chan struct{})
	d.cmd, d.stdin, d.done = cmd, stdin, done
	d.mu.Unlock()

	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
		close(done)
	}()
	deadline := time.After(60 * time.Second)
	for {
		select {
		case err := <-exited:
			return exitError(err)
		case <-deadline:
			_ = stdin.Close()
			select {
			case err := <-exited:
				return exitError(err)
			case <-time.After(8 * time.Second):
				_ = cmd.Process.Kill()
				return exitError(<-exited)
			}
		case <-time.After(200 * time.Millisecond):
		}
		if rt, ok := d.runtime(); ok && rt.PID == cmd.Process.Pid && healthy(rt.URL) {
			d.onReady(rt.URL, rt.AdminToken)
			return exitError(<-exited)
		}
	}
}

func exitError(err error) error {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("exited with code %d", exit.ExitCode())
	}
	return err
}

// stop ends the Mingle this app started, giving it a few seconds to close its connections.
func (d *daemon) stop() {
	d.mu.Lock()
	d.stopping = true
	cmd, stdin, done := d.cmd, d.stdin, d.done
	d.mu.Unlock()
	if cmd == nil {
		return
	}
	select {
	case <-done:
		return
	default:
	}
	_ = stdin.Close()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		_ = cmd.Process.Kill()
	}
}

// withShell makes sure SHELL is set, so Mingle can find the user's login shell.
// Windows needs none: its apps already get the user's environment.
func withShell(env []string) []string {
	if runtime.GOOS == "windows" || os.Getenv("SHELL") != "" {
		return env
	}
	shell := "/bin/sh"
	if runtime.GOOS == "darwin" {
		shell = "/bin/zsh"
	}
	return append(env, "SHELL="+shell)
}
