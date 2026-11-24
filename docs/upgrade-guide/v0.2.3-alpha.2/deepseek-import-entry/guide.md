---
kind: upgrade-guide
description: "The DeepSeek chat import entry moves from the sidebar's New-session row to the first source card of the cross-agent import page under Settings → Data."
---
# The DeepSeek chat import entry moved to the import page

English | [中文](guide.zh.md)

## Change

The `deepseek-chat-import` optional bundle no longer injects a button into the sidebar's New-session row (`sidebar.session.action`). The same import dialog now opens from the "DeepSeek web export (ZIP)" source card, the first card of the cross-agent import page under Settings → Data → Import conversations. The upload route, the limits pre-check, and the imported Sessions are unchanged.

## Migration

1. Open Settings → Data → Import conversations and use the "DeepSeek web export (ZIP)" card to import a `deepseek_data-*.zip` export.
2. Nothing else changes: bundle enablement, owner-only permissions, the upload route, and imported Sessions behave as before.
