// Dump a user's NYTimes cookies as a JSON object to stdout, so they
// can paste it into Crossplay's "Get from NYT" settings UI. Reads
// from any browser kooky recognizes (Chrome / Firefox / Safari /
// Edge / Brave / Vivaldi / Opera / Chromium) on macOS, Linux, or
// Windows. The output shape is `{cookieName: value, ...}` — the
// same flat dict the Python nytxw_puz tool's cache file uses, and
// the same shape Crossplay's `users.nyt_cookie` column expects.
//
// Build for the local machine:
//
//	go build -o dump-nyt-cookies .
//
// Cross-compile distributable binaries from one host (Mac shown):
//
//	GOOS=darwin  GOARCH=arm64 go build -o dist/dump-nyt-cookies-macos-arm64 .
//	GOOS=darwin  GOARCH=amd64 go build -o dist/dump-nyt-cookies-macos-amd64 .
//	GOOS=linux   GOARCH=amd64 go build -o dist/dump-nyt-cookies-linux-amd64 .
//	GOOS=windows GOARCH=amd64 go build -o dist/dump-nyt-cookies-windows-amd64.exe .
//
// Whether the cross-builds actually work without a C toolchain
// depends on whether kooky's per-platform paths need cgo — we'll
// find out at build time.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"github.com/browserutils/kooky"
	_ "github.com/browserutils/kooky/browser/all"
)

func main() {
	// `Valid` skips expired cookies; `DomainContains("nytimes.com")`
	// matches every NYT subdomain (www., myaccount., etc.) without
	// dragging in unrelated sites whose cookies happen to mention NYT.
	// kooky walks every browser store it knows about; it returns a
	// joined error if any failed to open (very common — most users
	// don't have Opera *and* Vivaldi *and* lynx installed). Ignore
	// that error and key off `len(cookies)` instead: zero is the only
	// outcome worth surfacing.
	cookies, _ := kooky.ReadCookies(
		context.Background(),
		kooky.Valid,
		kooky.DomainContains("nytimes.com"),
	)
	if len(cookies) == 0 {
		fmt.Fprintln(os.Stderr,
			"No nytimes.com cookies found. Are you logged in to nytimes.com in a supported browser?")
		os.Exit(1)
	}

	// Dedup by cookie name: the same name can appear under multiple
	// (domain, path) pairs (e.g. .nytimes.com vs www.nytimes.com).
	// Last write wins — matches what requests.utils.dict_from_cookiejar
	// does in the Python tool, so the output shape stays compatible.
	out := make(map[string]string, len(cookies))
	for _, c := range cookies {
		out[c.Name] = c.Value
	}

	jsonBytes, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Emit base64 of the JSON rather than raw JSON so terminal line-
	// wrapping during copy/paste can't corrupt the value. Node's
	// `Buffer.from(s, "base64")` ignores embedded whitespace, so even
	// a paste that picked up newlines from wrapped lines decodes back
	// to the original bytes cleanly.
	fmt.Println(base64.StdEncoding.EncodeToString(jsonBytes))
	fmt.Fprintf(os.Stderr,
		"Found %d nytimes.com cookies. Copy the line above and paste it into Crossplay → Settings → NYT cookie.\n",
		len(out))
}
