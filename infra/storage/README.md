# The development object store

`docker-compose.yml` runs **SeaweedFS**, not MinIO. MinIO's repository is
archived, and two advisories against it — both *unauthenticated object write* —
have no patched release and will not get one, because there is nobody to
publish it. What replaced it had to be actively maintained and had to answer
every call this repository makes:

- the running server — `HeadBucket`, `PutObject`, `DeleteObjects`;
- `pnpm storage:init` — `CreateBucket`, `PutBucketPolicy`, and a `PutObject`
  for the delivery check object;
- the browser suite's preparation — `ListObjectsV2`;
- delivery — an anonymous `GET`, returning the `Cache-Control` we set.

SeaweedFS answers all of them; Garage, the other candidate, implements no
bucket-policy API at all, which would have meant one code path in development
and another in production.

`s3-identities.json` is what makes the dev store behave like a real one:

- the credentials in `.env.example` are a real identity, and a wrong key is
  answered `403` rather than waved through;
- **anonymous is allowed `Read` and nothing else** — reads are public because
  media is public, and an anonymous `PUT` is refused;
- two narrower identities exist so that least privilege can be *asserted*
  rather than assumed. `presslabz-runtime` has no `Admin`, which is the shape
  of a real runtime account: it may read, write and list, and the store refuses
  it a bucket policy. `presslabz-readonly` may only read and list, which is how
  the API's integration suite pins the one thing `/health` does not promise —
  `HeadBucket` succeeds for it and `PutObject` is refused `403`.

Neither is used by any application code. They exist for the tests, and an
installation is free to use one account for `storage:init` and a narrower one
for the server — nothing in PressLabz requires them to be the same.

Measured, on the pinned image, before it was committed:

```
create bucket / head bucket / bucket policy / put object   ok   (dev key)
put object, head bucket                                    403  (wrong key)
anonymous GET                                              200
anonymous PUT                                              403
head bucket / put object                                   ok   (runtime key)
bucket policy                                              403  (runtime key)
head bucket                                                ok   (readonly key)
put object                                                 403  (readonly key)
```

These credentials are local throwaways and the API refuses them in production —
see the environment schema. They are in the repository because a fresh clone
should come up with `pnpm services:up`, not with a scavenger hunt.
