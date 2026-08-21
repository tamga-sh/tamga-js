---
"@tamga/sdk": patch
---

Add a documentation version guard. Nothing in this package's docs pins a version
on purpose — the install line, the Deno `npm:` import and the browser `esm.sh`
import all resolve whatever is current — and CI now fails if that stops being
true without the pin being annotated. Annotated versions are rewritten from
`package.json` inside the Version Packages PR.
