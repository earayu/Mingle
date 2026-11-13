package main

import (
	"fmt"

	"github.com/egoist/mygo"
)

// Appearance keeps the native window material and controls in the console's theme.
type Appearance struct{}

func (*Appearance) SetTheme(theme string) error {
	switch theme {
	case "system", "light", "dark":
		mygo.Theme.SetSource(mygo.ThemeSource(theme))
		return nil
	default:
		return fmt.Errorf("invalid theme: %q", theme)
	}
}
