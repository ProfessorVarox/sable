---
default: patch
---

Fix outdated user display names in chats under sliding sync by force-refreshing room member state when the global profile suggests the per-room name is stale.
