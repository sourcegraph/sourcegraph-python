// +build ignore

package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"syscall"

	"github.com/gorilla/websocket"
	"github.com/sourcegraph/jsonrpc2"
	websocketjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
)

var (
	addr = flag.String("addr", ":4288", "HTTP listen address")
)

func main() {
	flag.Parse()
	log.SetFlags(0)

	host, port, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatal(err)
	}
	if host == "" {
		host = "0.0.0.0"
	}

	args := flag.Args()
	if len(args) == 0 {
		log.Fatal("missing required exec args")
	}

	log.Printf("# WebSocket handler on http://%s:%s forwarding to stdin/stdout of exec %q", host, port, args)
	log.Fatal(http.ListenAndServe(*addr, &handler{execArgs: args}))
}

var websocketUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type handler struct {
	execArgs []string
}

func (h handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log.Println("Connection opened")
	clientConn, err := websocketUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // HTTP error is already written
	}

	cmd := exec.Command(h.execArgs[0], h.execArgs[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	serverConn := struct {
		io.Reader
		io.Writer
		io.Closer
	}{stdout, stdin, &cmdCloser{stdin, stdout, cmd}}

	proxy := &jsonrpc2Proxy{
		httpCtx: r.Context(),
		ready:   make(chan struct{}),
	}

	proxy.client = jsonrpc2.NewConn(r.Context(), websocketjsonrpc2.NewObjectStream(clientConn), jsonrpc2HandlerFunc(proxy.handleClientRequest))
	proxy.server = jsonrpc2.NewConn(r.Context(), jsonrpc2.NewBufferedStream(serverConn, jsonrpc2.VSCodeObjectCodec{}), jsonrpc2.AsyncHandler(jsonrpc2HandlerFunc(proxy.handleServerRequest)))

	proxy.start()

	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	go func() {
		// Note: can't use cmd.Wait here due to data races on the file
		//       descriptors being closed. Use cmd.Process.Wait() instead.
		if _, err := cmd.Process.Wait(); err != nil {
			log.Printf("Server exited: %s", err)
		}
	}()

	select {
	case <-proxy.client.DisconnectNotify():
		log.Println("Client disconnected")
		proxy.server.Close()
	case <-proxy.server.DisconnectNotify():
		log.Println("Server disconnected")
		proxy.client.Close()
	}
	log.Println("Connection closed")
}

type cmdCloser struct {
	stdin, stdout io.Closer
	cmd           *exec.Cmd
}

func (c *cmdCloser) Close() error {
	_ = c.stdin.Close()
	_ = c.stdout.Close()
	return c.cmd.Process.Kill()
}

type jsonrpc2HandlerFunc func(context.Context, *jsonrpc2.Conn, *jsonrpc2.Request)

func (h jsonrpc2HandlerFunc) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	h(ctx, conn, req)
}

// jsonrpc2Proxy is a proxy between a client WebSocket JSON-RPC 2.0 connection (typically with a
// user's Web browser) and a server raw JSON-RPC 2.0 connection.
type jsonrpc2Proxy struct {
	httpCtx context.Context
	client  *jsonrpc2.Conn // connection to the HTTP client (e.g., the user's browser)
	server  *jsonrpc2.Conn // connection to server
	ready   chan struct{}
}

func (p *jsonrpc2Proxy) start() {
	close(p.ready)
}

// jsonrpc2FromConn defines the subset of jsonrpc2.Conn we use to pass on a response.
type jsonrpc2FromConn interface {
	ReplyWithError(context.Context, jsonrpc2.ID, *jsonrpc2.Error) error
	Reply(context.Context, jsonrpc2.ID, interface{}) error
}

func (p *jsonrpc2Proxy) roundTrip(ctx context.Context, from jsonrpc2FromConn, to jsonrpc2.JSONRPC2, req *jsonrpc2.Request) error {
	if req.Params == nil {
		log.Printf("REQ %s nil", req.Method)
	} else {
		log.Printf("REQ %s %s", req.Method, *req.Params)
	}

	if req.Notif {
		if err := to.Notify(ctx, req.Method, req.Params); err != nil {
			log.Println(err)
		}
		return nil
	}

	callOpts := []jsonrpc2.CallOption{
		// Proxy the ID used. Otherwise we assign our own ID, breaking calls that depend on
		// controlling the ID such as $/cancelRequest and $/partialResult.
		jsonrpc2.PickID(req.ID),
	}

	var result json.RawMessage
	if err := to.Call(ctx, req.Method, req.Params, &result, callOpts...); err != nil {
		log.Printf("ERR: %+v", result)
		log.Println(err)

		var respErr *jsonrpc2.Error
		if e, ok := err.(*jsonrpc2.Error); ok {
			respErr = e
		} else {
			respErr = &jsonrpc2.Error{Message: err.Error()}
		}
		if err := from.ReplyWithError(ctx, req.ID, respErr); err != nil {
			log.Println(err)
		}
		return respErr
	}
	log.Printf("RESULT: %s", result)
	if err := from.Reply(ctx, req.ID, &result); err != nil {
		log.Println(err)
	}
	return nil
}

func (p *jsonrpc2Proxy) handleClientRequest(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	<-p.ready
	go p.roundTrip(ctx, conn, p.server, req)
}

func (p *jsonrpc2Proxy) handleServerRequest(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	<-p.ready
	p.roundTrip(ctx, conn, p.client, req)
}
