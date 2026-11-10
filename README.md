# Porter

A local blob store and [RASL](https://dasl.ing/rasl.html) server for
[Chronicle](https://chronicle.app). Blobs are addressed by
[DASL CIDs](https://dasl.ing/cid.html), kept on local disk, and replicated to
S3-compatible storage.

Early scaffold: CIDs and the in-memory store work; the filesystem and S3
stores, the replication queue, and `porter serve` are next.

```sh
porter cid ./photo.jpg   # bafkrei…
```

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
