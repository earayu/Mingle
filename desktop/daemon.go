package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// daemon runs `mingle start` with the bundled Node.js and keeps it running.
// When a Mingle started elsewhere (a terminal) is already running on the same
// data directory, the app shows that one and leaves it alone.
type daemon struct {
	node, entry, home, logs string
	onReady                 func(url, token string)
	onDown                  func(reason string)

	mu       sync.Mutex
	cmd      *exec.Cmd
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
	d.node = filepath.Join(resources, "node", "bin", "node")
	d.entry = filepath.Join(resources, "mingle", "dist", "cli", "main.js")
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

	cmd := exec.Command(d.node, d.entry, "start", "--no-open")
	cmd.Env = append(os.Environ(), "PATH="+userPath(filepath.Dir(d.node)))
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
	d.cmd, d.done = cmd, done
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
			_ = cmd.Process.Signal(syscall.SIGTERM)
			return exitError(<-exited)
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
	cmd, done := d.cmd, d.done
	d.mu.Unlock()
	if cmd == nil {
		return
	}
	select {
	case <-done:
		return
	default:
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		_ = cmd.Process.Kill()
	}
}

// userPath is the PATH of the user's login shell. Apps opened from Finder get a
// minimal PATH, which would hide the harnesses (claude, codex) installed with
// Homebrew, npm or the like. The bundled Node.js goes last, as a fallback.
func userPath(fallbackDir string) string {
	path := os.Getenv("PATH")
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const marker = "__MINGLE_PATH__"
	out, err := exec.CommandContext(ctx, shell, "-ilc", `printf '`+marker+`%s' "$PATH"`).Output()
	if err == nil {
		if i := bytes.LastIndex(out, []byte(marker)); i >= 0 {
			if found := strings.TrimSpace(string(out[i+len(marker):])); found != "" {
				path = found
			}
		}
	}
	for _, dir := range strings.Split(path, ":") {
		if dir == fallbackDir {
			return path
		}
	}
	return path + ":" + fallbackDir
}
