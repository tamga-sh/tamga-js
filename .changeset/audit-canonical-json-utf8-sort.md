---
"@tamga/sdk": patch
---

Fix canonical-JSON key sorting to use UTF-8 byte order instead of JS's default UTF-16 code-unit order, matching the server's serde_json BTreeMap ordering. Without this, an offline machine proof whose dataset has keys spanning certain non-ASCII Unicode ranges (BMP Private-Use vs supplementary-plane characters) could fail client-side verification even though it was legitimately signed server-side.
