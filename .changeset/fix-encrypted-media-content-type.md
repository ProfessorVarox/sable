---
default: patch
---

Fix encrypted images and GIFs failing to render by sniffing the decrypted content type in the native media handler and skipping thumbnail requests for animated image formats.
