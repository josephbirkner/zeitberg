# Encrypted workspace invitations

This is a separate service from the stateless GitHub authentication relay. The
browser encrypts a dedicated PAT capability using AES-256-GCM and uploads only
ciphertext. The resulting URL has this shape:

`https://zeitberg.io/join/<128-bit hex ID>#k=<256-bit base64url key>`

The key stays in the fragment; it is never included in a service request. The
browser scrubs the incoming URL before resolving and decrypting the invitation.
The existing capability validator then checks its provider, repository and route.
Pasted URLs and QR codes use the same resolver. OAuth account grants are not
shareable: use a dedicated, appropriately scoped repository token.

## Deployment

`INVITATION_SERVICE_URL` points to
`https://zeitbergauthjktlgxby-invitations.functions.fnc.fr-par.scw.cloud/`.
Existing full capability links continue to work. The public site uses this
service once the 1.4.0 frontend is deployed; publishing the frontend does not
redeploy the function or its storage configuration.

Created in the Scaleway `zeitberg` project:

- Private bucket: `zeitberg-invitations-par`, region `fr-par`.
- Lifecycle: `expire-invitations-30-days`, enabled for all objects after 30 days.
- Versioning and object lock remain disabled.
- IAM application: `zeitberg-invitations`, ID
  `f6668bff-14fc-4420-9834-d327be60b0d9`.
- Runtime IAM policy: `zeitberg-invitations-runtime`, ID
  `cca0b851-f70d-4554-b52a-7f5d2bdc8cd1`, with only
  `ObjectStorageObjectsRead`, `ObjectStorageObjectsWrite`, and
  `ObjectStorageObjectsDelete`, scoped to the `zeitberg` project.
- Bucket policy: owner access preserved; service may list this bucket and
  read/write/delete only `invitations/*` objects. No public access.
- Function: `invitations`, ID `b46edf67-ec3d-440f-9546-1819b5ff0f36`, in
  namespace `e1299703-a835-4083-b66f-f81fffbaa204`. Node 24, 128 MB,
  0–1 instances, 20-second timeout, public invocation over HTTPS only.
- Service API key is stored only in Function secret variables; rotate before
  its expiration on 2027-10-30. No owner credential is deployed.

Scaleway requires both IAM permission and bucket-policy permission. The project
scope is intentional and user-approved: any additional bucket in this project
must receive its own restrictive bucket policy before storing unrelated data,
or the service's object permissions could apply there too. See
[Scaleway's IAM and bucket policy rules](https://www.scaleway.com/en/docs/object-storage/api-cli/combining-iam-and-object-storage/).

## Configuration

1. Grant the service application's IAM policy the three object permission sets
   listed above, scoped to the intended project, without bucket administration.
   In the bucket policy, give the service application `s3:ListBucket` on this bucket and
   `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on its `invitations/*` prefix.
   Preserve the owner's existing bucket access. No public principal, public ACL,
   bucket administration is required. Restrict other buckets separately or use
   a dedicated project. Apply the policy through a temporary administrative grant,
   then remove that grant before running the service.
2. Generate an API key for the service application. Set its default project to
   `zeitberg`. Store the access key and secret key as Function **secret variables**
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Set the ordinary variable
   `INVITATIONS_BUCKET=zeitberg-invitations-par`. Never commit credentials.
3. Create a separate Paris Function: Node 24, handler `handler.handle`, 128 MB,
   minimum 0 / maximum 1 instance, HTTPS-only, public invocation, 20-second timeout.
   The S3 adapter aborts individual requests after eight seconds; the browser has
   a 15-second deadline. A timed-out create may leave an unreachable encrypted
   record until lifecycle cleanup, but it does not reveal its capability.
4. Run `npm ci --omit=dev` in this directory, then package `handler.js`,
   `package.json`, `package-lock.json`, and `node_modules/` at the ZIP root.
   Scaleway's ZIP upload does not install dependencies automatically. The
   frontend build deliberately excludes this service directory.
5. Verify with a fictional token: create, resolve, decrypt, reject an incorrect
   revocation token, revoke, and confirm the lookup fails. Also check foreign
   Origin rejection, no-store headers, and CORS from the deployed site and local
   development origins. Then set the verified HTTPS root URL in `invitations.js`.

## Lifetime and revocation

Both the service envelope and authenticated plaintext expire after 30 days.
Storage lifecycle cleanup is asynchronous; the API enforces expiration even if
an expired blob is still awaiting cleanup. No version history is retained.

Creation returns a separate random revocation credential. Only its SHA-256 digest
is stored in the bucket. The browser retains the receipt in local storage and
offers revocation in Share. It never persists the invitation decryption key.
Clearing browser storage loses these controls; automatic expiry still applies.
Revoking a link prevents new imports, **not use of tokens already imported**.
That requires revoking the repository token at its provider.

## Abuse and privacy boundaries

Only JSON `POST /` and CORS `OPTIONS /` are accepted. The operation schemas are
strict, ciphertext is bounded, IDs are server-generated, and neither the storage
path nor any upstream URL can be chosen by a client. Allowed browser origins are
`https://zeitberg.io`, `http://localhost:8000`, and `http://127.0.0.1:8000`.

CORS is not authentication. Warm-instance limits are 120 requests globally,
30 per client address, and 5 creates per client per minute. Creation stops at
1,000 stored invitations (including expired blobs awaiting cleanup). Cold starts
reset the request counters; deployment overlap may briefly exceed the storage
ceiling. These are abuse mitigations, not a billing guarantee. The existing €5
email alert is not a spending cap.

Do not enable body logging, tracing that captures payloads, or proxy caching.
Application code logs no request bodies, IDs, keys, tokens, or IP addresses;
Scaleway can still retain ordinary infrastructure metadata. Anyone with the
complete invitation URL has its embedded token authority until that token is
revoked. Browser compromise or malicious application code can expose it.

Run `node --test tests/invitations.test.mjs`, `npm test` and `npm run typecheck`
from the repository root before deployment.
