---
type: removed
breaking: true
audience: user
commits:
---
The Cron scheduling stack is gone: the `cron_*` model tools, the `ctx.cron` and `ctx.remote.cron` APIs, the Session-header Cron panel, and the Cron overlay no longer exist. Scheduled tasks live in one place now, the Automation tasks page and the `schedule_*` tools, which already accept five-field cron timing in an explicit zone; recreate any Cron task there. Stored Cron records stay on disk and are no longer read.
