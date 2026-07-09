package ex

import "embed"

//go:embed all:dist
var FrontendFS embed.FS
