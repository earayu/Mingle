package main

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps Windows from opening a console window for Mingle's Node.js process.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
