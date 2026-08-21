---
"@tamga/sdk": patch
---

Surface the `x-ratelimit-*` budget on `ResponseInfo`. The server sets all four
headers on every response it handles, throttled or not, so `remaining` read off
a successful call is what lets a caller slow down before it is throttled. The
transport documentation previously said these headers were "not set by any
server handler", which was wrong. Additive: `ResponseInfo` gains one optional
field and a new `RateLimitInfo` type is exported.
