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

### 🔐 Secure deployment 🔐

If you have private code, we recommend deploying the language server behind an
auth proxy (such as the example below using HTTP basic authentication in NGINX), a firewall, or a VPN.

### HTTP basic authentication

You can prevent unauthorized access to the language server by enforcing HTTP basic authentication in nginx, which comes with the sourcegraph/server image. At a high level, you'll create a secret then put it in both the nginx config and in your Sourcegraph global settings so that logged-in users are authenticated when their browser makes requests to the Python language server.

Here's how to set it up:

Create an `.htpasswd` file in the Sourcegraph config directory with one entry:

```
$ htpasswd -c ~/.sourcegraph/config/.htpasswd langserveruser
New password:
Re-type new password:
Adding password for user langserveruser
```

Add a location directive the [nginx.conf](https://docs.sourcegraph.com/admin/nginx) that will route requests to the Python language server:

```nginx
...
http {
    ...
    server {
        ...
        location / {
            ...
        }

        location /python {
            proxy_pass http://host.docker.internal:4288;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "Upgrade";

            auth_basic "basic authentication is required to access the language server";
            auth_basic_user_file /etc/sourcegraph/.htpasswd;
        }
    }
}
```

- If you're running the quickstart on Linux, change `host.docker.internal` to the output of `ip addr show docker0 | grep -Po 'inet \K[\d.]+'`.
- If you're using [Kubernetes](#using-kubernetes) (e.g. [deploy-sourcegraph](https://github.com/sourcegraph/deploy-sourcegraph)), change `host.docker.internal` to `lang-python`.

Add these to your Sourcegraph global settings:

```
  "python.serverUrl": "ws://langserveruser:PASSWORD@host.docker.internal:7080/python",
  "python.sourcegraphUrl": "http://host.docker.internal:7080",
```

Fill in the `PASSWORD` that you created above.

- If you're running the quickstart on Linux, change `host.docker.internal` to the output of `ip addr show docker0 | grep -Po 'inet \K[\d.]+'`.
- If you're using [Kubernetes](#using-kubernetes) (e.g. [deploy-sourcegraph](https://github.com/sourcegraph/deploy-sourcegraph)):
  - `python.serverUrl` is the address of the Python language server from the perspective of a user's browser (e.g. https://sourcegraph.example.com/python)
  - `python.sourcegraphUrl` is the address of the Sourcegraph instance from the perspective of the Python language server (e.g. http://sourcegraph-frontend:30080)

Finally, restart the sourcegraph/server container (or nginx deployment if deployed to Kubernetes) to pick up the configuration change.

After deploying the language server, unauthenticated access to `http://localhost:7080/python` (or https://sourcegraph.example.com/python) should be blocked, but code intelligence should work when you're logged in.

You can always revoke the `PASSWORD` by deleting the `.htpasswd` file and restarting nginx.

### Using Docker

1. Run the Python language server Docker container:

    ```sh
    docker run --rm -p 4288:4288 sourcegraph/lang-python:insiders
    ```

1. Enable this extension on your Sourcegraph  https://sourcegraph.example.com/extensions/sourcegraph/lang-python


1. Add these to your Sourcegraph settings:

    ```json
      "python.serverUrl": "ws://localhost:4288",
      "python.sourcegraphUrl": "http://host.docker.internal:7080",
    ```

    If you're running on Linux, change `python.sourcegraphUrl` to the IP given by:

    ```bash
    ip addr show docker0 | grep -Po 'inet \K[\d.]+'
    ```

## Known issues

-   Dependencies are not installed. Hovers, definitions, and references only work for sources checked into the single repository you are viewing.
-   Cross-repository definitions and references are not yet supported.
-   Hangs on very large repositories (e.g. django/django)
