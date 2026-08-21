# The development object store

`docker-compose.yml` runs **SeaweedFS**, not MinIO. MinIO's repository is
archived, and two advisories against it — both *unauthenticated object write* —
have no patched release and will not get one, because there is nobody to
publish it. What replaced it had to be actively maintained and had to answer
the seven S3 calls `apps/api/src/media/storage.ts` actually makes, including
`PutBucketPolicy` and anonymous reads with our `Cache-Control`. SeaweedFS does;
Garage, the other candidate, implements no bucket-policy API at all, which
would have meant one code path in development and another in production.

`s3-identities.json` is what makes the dev store behave like a real one:

- the credentials in `.env.example` are a real identity, and a wrong key is
  answered `403` rather than waved through;
- **anonymous is allowed `Read` and nothing else** — reads are public because
  media is public, and an anonymous `PUT` is refused.

Measured, on the pinned image, before it was committed:

```
create bucket / head bucket / bucket policy / put object   ok   (dev key)
put object, head bucket                                    403  (wrong key)
anonymous GET                                              200
anonymous PUT                                              403
```

These credentials are local throwaways and the API refuses them in production —
see the environment schema. They are in the repository because a fresh clone
should come up with `pnpm services:up`, not with a scavenger hunt.
