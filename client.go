package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
	"time"

	"github.com/gorilla/websocket"
	lsp "github.com/sourcegraph/go-lsp"
	"github.com/sourcegraph/jsonrpc2"
	websocketjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
)

var (
	urlStr           = flag.String("url", "ws://localhost:4288", "WebSocket URL of language server (ws:// or wss://)")
	requestHeaderStr = flag.String("header", "", "HTTP header to include (example: \"Authorization: token abc123\")")
	verbose          = flag.Bool("verbose", false, "show verbose output")
)

func main() {
	flag.Parse()
	log.SetFlags(0)

	url, err := url.Parse(*urlStr)
	if err != nil {
		log.Fatal(err)
	}
	if url.Scheme != "ws" && url.Scheme != "wss" {
		log.Fatalf("Invalid -url value: WebSocket URL must be ws:// or wss:// (got %q).", url)
	}

	var requestHeader http.Header
	if *requestHeaderStr != "" {
		i := strings.Index(*requestHeaderStr, ":")
		if i == -1 {
			log.Fatal("Invalid -header value: HTTP header must be of the form \"Name: value\".")
		}
		requestHeader = http.Header{
			(*requestHeaderStr)[:i]: []string{strings.TrimSpace((*requestHeaderStr)[i+1:])},
		}
	}

	// HACK: parallelize by duplicating
	testCases = append(testCases, testCases[0])
	testCases[0].Name += "(A)"
	testCases[1].Name += "(B)"

	ctx := context.Background()
	results := make([]*testCaseResult, len(testCases))
	var wg sync.WaitGroup
	for i, c := range testCases {
		wg.Add(1)
		go func(i int, testCase testCase) {
			defer wg.Done()
			var err error
			results[i], err = runTestCase(ctx, *urlStr, requestHeader, testCase)
			if err != nil {
				log.Fatal(err)
			}
		}(i, c)
	}
	wg.Wait()

	for i, result := range results {
		if i > 0 {
			log.Printf("================================================================================")
		}

		tw := tabwriter.NewWriter(os.Stdout, 1, 8, 1, '\t', 0)
		fmt.Fprintf(tw, "Initialization\t%s\t\n", msec(result.InitializeDuration))
		fmt.Fprintf(tw, "Extract archive\t%s\t\n", msec(result.ExtractArchiveDuration))
		if err := tw.Flush(); err != nil {
			log.Fatal(err)
		}

		fmt.Println()

		var msgs []string
		tw = tabwriter.NewWriter(os.Stdout, 1, 8, 1, '\t', 0)
		for i, hoverResult := range result.Hovers {
			fmt.Fprintf(tw, "Hover %d\t%s\t%s\t\n", i, hoverResult.PassString(), hoverResult.Duration)
			msgs = append(msgs, hoverResult.Messages...)
		}
		if err := tw.Flush(); err != nil {
			log.Fatal(err)
		}

		if len(msgs) > 0 {
			log.Printf("ERRORS")
			for _, msg := range msgs {
				log.Println(" - ", msg)
			}
		}
	}
}

type testCase struct {
	Name       string
	ArchiveURL string
	Hovers     []hoverTestCase
}

type hoverTestCase struct {
	Params lsp.TextDocumentPositionParams
	Want   []string
}

var testCases = []testCase{
	{
		Name:       "python-sample-0",
		ArchiveURL: "http://localhost:3080/github.com/sgtest/python-sample-0@ad924954afa36439105efa03cce4c5981a2a5384/-/raw",
		Hovers: []hoverTestCase{
			{
				Params: lsp.TextDocumentPositionParams{
					TextDocument: lsp.TextDocumentIdentifier{URI: lsp.DocumentURI("$ROOT/pkg0/m1.py")},
					Position:     lsp.Position{Line: 12, Character: 11},
				},
				Want: []string{"class pkg0.m0.Class0(object)", "Class0 docstring"},
			},
			{
				Params: lsp.TextDocumentPositionParams{
					TextDocument: lsp.TextDocumentIdentifier{URI: lsp.DocumentURI("$ROOT/pkg0/m1.py")},
					Position:     lsp.Position{Line: 13, Character: 11},
				},
				Want: []string{"class pkg0.m1.Class0_0(Class0)"},
			},
		},
	},
}

type testCaseResult struct {
	InitializeDuration     time.Duration
	ExtractArchiveDuration time.Duration
	Hovers                 []hoverTestCaseResult
}

type hoverTestCaseResult struct {
	Duration time.Duration
	Pass     bool
	Messages []string
}

func (r hoverTestCaseResult) PassString() string {
	if r.Pass {
		return "✔️"
	}
	return "❌"
}

func runTestCase(ctx context.Context, urlStr string, requestHeader http.Header, testCase testCase) (*testCaseResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()

	log := log.New(os.Stderr, testCase.Name+": ", 0)

	tmpDir, err := ioutil.TempDir("", "python-language-server-client-test")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	var testCaseResult testCaseResult

	wsConn, _, err := websocket.DefaultDialer.DialContext(ctx, urlStr, nil)
	if err != nil {
		return nil, err
	}
	conn := jsonrpc2.NewConn(ctx, websocketjsonrpc2.NewObjectStream(wsConn), clientHandler{})
	if *verbose {
		log.Printf("Connected")
	}

	log.Printf("Initializing...")
	initT0 := time.Now()
	var initResult struct{ RootURI string }
	if err := conn.Call(ctx, "initialize", InitializeParams{
		DocumentSelector: []DocumentSelector{{Language: "python"}},
		RootURI:          strptr("file://" + tmpDir),
		Capabilities:     rawJSON(`{ "textDocument": { "hover": { "contentFormat": ["markdown"] } } }`),
		WorkspaceFolders: []struct{}{},
		InitializationOptions: rawJSON(`{
            "interpreter": {
                "properties": {
                    "InterpreterPath": "/usr/local/bin/python",
                    "Version": "3.7.1",
                    "DatabasePath": "/usr/local/python-language-server"
                }
            },
            "displayOptions": {
                "preferredFormat": "markdown",
                "trimDocumentationLines": false,
                "maxDocumentationLineLength": 0,
                "trimDocumentationText": false,
                "maxDocumentationTextLength": 0
            },
            "testEnvironment": false,
            "searchPaths": [
                "/usr/lib/python3/dist-packages;/usr/local/lib/python3.7"
            ],
            "typeStubSearchPaths": ["/usr/local/python-language-server/Typeshed"],
            "excludeFiles": [],
            "analysisUpdates": true,
            "traceLogging": true,
            "asyncStartup": true
        }`),
	}, &initResult); err != nil {
		return nil, err
	}
	testCaseResult.InitializeDuration = time.Since(initT0)
	log.Printf("Initialized.")
	defer func() {
		if err := conn.Notify(ctx, "shutdown", nil); err == nil {
			_ = conn.Notify(ctx, "exit", nil)
		}
	}()
	if err := conn.Notify(ctx, "initialized", nil); err != nil {
		return nil, err
	}

	log.Printf("Extracting archive...")
	extractArchiveT0 := time.Now()
	if err := conn.Call(ctx, "workspace/executeCommand", lsp.ExecuteCommandParams{
		Command:   "workspace/extractArchive",
		Arguments: []interface{}{testCase.ArchiveURL, false},
	}, nil); err != nil {
		return nil, err
	}
	testCaseResult.ExtractArchiveDuration = time.Since(extractArchiveT0)
	log.Printf("Extracted archive.")

	if err := conn.Notify(ctx, "workspace/didChangeConfiguration", lsp.DidChangeConfigurationParams{Settings: json.RawMessage(`{ "python": {} }`)}); err != nil {
		return nil, err
	}

	testCaseResult.Hovers = make([]hoverTestCaseResult, len(testCase.Hovers))
	for i, hoverTestCase := range testCase.Hovers {
		testCaseResult.Hovers[i].Pass = true

		hoverTestCase.Params.TextDocument.URI = lsp.DocumentURI(strings.Replace(string(hoverTestCase.Params.TextDocument.URI), "$ROOT", initResult.RootURI, -1))
		if err := conn.Notify(ctx, "textDocument/didOpen", DidOpenTextDocumentParams{
			TextDocument: TextDocumentItem{
				URI:        hoverTestCase.Params.TextDocument.URI,
				LanguageID: "python",
				Version:    1,
				Text:       nil,
			},
		}); err != nil {
			return nil, err
		}
		var hoverResult json.RawMessage
		log.Printf("Hover %d...", i)
		t0 := time.Now()
		if err := conn.Call(ctx, "textDocument/hover", hoverTestCase.Params, &hoverResult); err != nil {
			return nil, err
		}
		testCaseResult.Hovers[i].Duration = time.Since(t0)
		log.Printf("Hover %d result received.", i)
		hoverResultStr := string(hoverResult)
		for _, wantStr := range hoverTestCase.Want {
			if !strings.Contains(hoverResultStr, wantStr) {
				testCaseResult.Hovers[i].Pass = false
				testCaseResult.Hovers[i].Messages = append(testCaseResult.Hovers[i].Messages, fmt.Sprintf("Hover result does not contain %q: %s", wantStr, hoverResultStr))
			}
		}
	}

	return &testCaseResult, nil
}

type InitializeParams struct {
	ProcessID             *int `json:"processId"`
	DocumentSelector      []DocumentSelector
	RootURI               *string          `json:"rootUri"`
	Capabilities          *json.RawMessage `json:"capabilities"`
	WorkspaceFolders      []struct{}       `json:"workspaceFolders"`
	InitializationOptions *json.RawMessage `json:"initializationOptions"`
}

type DocumentSelector struct {
	Language string `json:"language"`
}

type DidOpenTextDocumentParams struct {
	TextDocument TextDocumentItem `json:"textDocument"`
}

type TextDocumentItem struct {
	URI        lsp.DocumentURI `json:"uri"`
	LanguageID string          `json:"languageId"`
	Version    int             `json:"version"`
	Text       *string         `json:"text"` // nullable
}

func strptr(s string) *string { return &s }

func rawJSON(s string) *json.RawMessage {
	b := json.RawMessage([]byte(s))
	return &b
}

func msec(d time.Duration) string {
	return strconv.Itoa(int(d/time.Millisecond)) + "ms"
}

type clientHandler struct{}

func (clientHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var body json.RawMessage
	if req.Params != nil {
		body = *req.Params
	}
	if *verbose {
		log.Printf("# Client ignoring request: %s: %s", req.Method, body)
	}
}
