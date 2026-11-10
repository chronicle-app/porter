# Porter

A local blob store and [RASL](https://dasl.ing/rasl.html) server for
[Chronicle](https://chronicle.app). Blobs are addressed by
[DASL CIDs](https://dasl.ing/cid.html), kept on local disk, and replicated to
S3-compatible storage.

Not released yet. `porter serve` serves blobs and uploads them to remotes;
`porter` also manages remotes and shows status. Run `porter --help` for the
commands.

```js
import { Porter, ensureServe } from '@chronicle.app/porter';

const porter = await Porter.open(); // the platform's app-data directory
const { cid } = await porter.local.put(fileStream); // bafkrei…, queued for remotes

const server = await ensureServe(); // starts `porter serve` in the background if needed
server.urlFor(cid); // a URL a video player or <img> can load for 12 hours
```

## Where things live

Porter keeps blobs, its index, settings, and the server's token and secret in
`porter` inside Chronicle's data directory, such as
`~/Library/Application Support/Chronicle/porter`. `CHRONICLE_DATA_DIR` and
`CHRONICLE_PROFILE=dev` move it as they move Chronicle, and `--home` overrides
it. Remote keys live in `porter-credentials.json` (`0600`) in Chronicle's
config directory, `~/.config/chronicle`, next to Chronicle's own
credentials.

## HTTP

`porter serve` listens on 127.0.0.1, port 7413 unless `--port` says
otherwise, and only reads. One runs per Porter directory.

| Request | Response |
| --- | --- |
| `GET /.well-known/rasl/CID` | The blob, as `application/octet-stream`. `Range` gives `206`. |
| `HEAD /.well-known/rasl/CID` | The same headers, with no body. |

Every request needs `Authorization: Bearer TOKEN`, with the token from
`porter-token` in Porter's root, or a capability URL from `urlFor`, which reads
one CID until it expires. Requests must name the host as `127.0.0.1:PORT` or
`localhost:PORT`. There are no CORS headers.

A blob missing locally is read from each remote in turn. A full read that
doesn't match its CID stops short of its `Content-Length`, so clients see a
broken transfer. Ranges aren't checked.

## Develop

With nix and direnv, `echo 'use flake' > .envrc && direnv allow`, or run
`nix develop`. The shell provides Node 22 and versitygw, an S3-compatible
server for tests, and `menu` lists its commands.

```sh
setup          # npm ci
check          # typecheck and test
porter status  # build, then run porter from this checkout
```

The shell sets `CHRONICLE_PROFILE=dev`, so `porter` there keeps its data in
Chronicle Dev, apart from an installed Chronicle's. Remote keys still go to
Chronicle's config directory, as Chronicle's own credentials do.

## The name

The porter kept the lodge at the gate of a college or great house. Deliveries
came to the porter, who took them in, kept them safe, and handed each one to
whoever was allowed it.
