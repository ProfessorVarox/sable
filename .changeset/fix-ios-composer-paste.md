---
default: patch
---

Fix pasting text into the message composer on iOS, where the webview hands the paste event an empty clipboard and nothing got inserted.
