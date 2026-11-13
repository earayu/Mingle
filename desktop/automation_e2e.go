//go:build e2e

package main

// End-to-end builds let a test or an agent drive the app over a socket:
// GOFLAGS=-tags=e2e go tool mygo build -debug -skip-dmg -o build-e2e
// MYGO_AUTOMATION=/tmp/mingle.sock build-e2e/darwin-arm64/Mingle.app/Contents/MacOS/Mingle
import _ "github.com/egoist/mygo/plugins/automation"
