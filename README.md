# Code intelligence for Python (beta)

![](https://user-images.githubusercontent.com/1387653/51012886-6a645400-1514-11e9-8958-8ebe3e40aff9.png)

This extension provides Python code intelligence on Sourcegraph. Ensure this extension is enabled and then try it on some examples:

-   Tensorflow: [tensorflow_ranking/examples/tf_ranking_libsvm.py](https://sourcegraph.com/github.com/tensorflow/ranking@931e4e18d68612d0b29dc3c81994acdd4b6ab743/-/blob/tensorflow_ranking/examples/tf_ranking_libsvm.py#L294:27&tab=references)
-   Flask: [flask/views.py](https://sourcegraph.com/github.com/pallets/flask/-/blob/flask/views.py)
-   Zulip: [corporate/lib/stripe.py](https://sourcegraph.com/github.com/zulip/zulip/-/blob/corporate/lib/stripe.py)
-   Trivial sample: [pkg0/m0.py](http://sourcegraph.com/github.com/sgtest/python-sample-0/-/blob/pkg0/m0.py)

![Screenshot](https://user-images.githubusercontent.com/1976/49628952-d4c92800-f99b-11e8-9605-d880b733cde6.png)

## Usage with private Sourcegraph instances

This extension is configured to talk to a language server over WebSockets. If you are running a
private Sourcegraph instance, you should run your own language server. The server is available as a
Docker image `sourcegraph/lang-python` from Docker Hub.

### Using Docker

1. Run the Python language server Docker container:

    ```sh
    docker run --rm -p 4288:4288 sourcegraph/lang-python:insiders
    ```

1. Enable this extension on your Sourcegraph  https://sourcegraph.example.com/extensions/sourcegraph/lang-python


1. Add these to your Sourcegraph settings:

    ```json
      "python.languageServer.url": "ws://localhost:4288",
      "python.sourcegraph.url": "http://host.docker.internal:7080",
    ```

    If you're running on Linux, change `python.sourcegraph.url` to the IP given by:

    ```bash
    ip addr show docker0 | grep -Po 'inet \K[\d.]+'
    ```

### Authentication proxies and firewalls

Some customers deploy Sourcegraph behind an authentication proxy or firewall. If you do this, we
recommend deploying the language server behind the proxy so that it can issue requests directly to
Sourcegraph without going through the proxy. (Otherwise, you will need to configure the language
server to authenticate through your proxy.) Make sure you set `python.sourcegraphUrl` to the URL
that the language server should use to reach Sourcegraph, which is likely different from the URL
that end users use.

## Known issues

-   Dependencies are not installed. Hovers, definitions, and references only work for sources checked into the single repository you are viewing.
-   Cross-repository definitions and references are not yet supported.
-   Hangs on very large repositories (e.g. django/django)
