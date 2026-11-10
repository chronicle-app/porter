# Porter

A local blob store and [RASL](https://dasl.ing/rasl.html) server for
[Chronicle](https://chronicle.app). Blobs are addressed by
[DASL CIDs](https://dasl.ing/cid.html), kept on local disk, and replicated to
S3-compatible storage.

Not released yet. `porter serve` serves blobs and uploads them to remotes;
`porter` also manages remotes and shows status. Run `porter --help` for the
commands.

```js
import { LocalStore, ReadThrough, Access, serveRasl } from '@chronicle.app/porter';

const local = new LocalStore({ root: '/path/to/porter' });
const { cid } = await local.put(fileStream); // bafkrei…

const server = await serveRasl({ reader: new ReadThrough(local), access: await Access.load('/path/to/porter') });
server.urlFor(cid); // a URL a video player or <img> can load for 12 hours
```

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
setup   # npm ci
check   # typecheck and test
```

## The name

The porter kept the lodge at the gate of a college or great house. Deliveries
came to the porter, who took them in, kept them safe, and handed each one to
whoever was allowed it.
