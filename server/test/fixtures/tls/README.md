# Test-only TLS certificate

`localhost.key` / `localhost.crt`: a self-signed P-256 certificate for `DNS:localhost`,
valid until 2126. Used only by `test/delivery/http-client.test.ts` to exercise the SSRF-safe
client's HTTPS path (untrusted cert → `tls`, hostname mismatch → `tls`, trusted → ok).

This key protects nothing and is never used outside tests. Regenerate with (Git Bash):

```
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout localhost.key -out localhost.crt -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
```
