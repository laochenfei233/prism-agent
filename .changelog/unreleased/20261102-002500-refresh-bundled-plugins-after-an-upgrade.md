---
type: fixed
breaking: false
audience: user
commits: 7d75059a67
---
After a Prism Agent desktop upgrade the plugin page no longer marks app-provided plugins as "Problem": the copies seeded into the profile now follow the installation's manifest and build, so a bundled plugin such as prism-meeting, aegis, or prism-memory loads again once the installation ships a compatible build. The bundled plugins prism-pocket, prism-local-models, and prism-session-autoarchive now ship with their built `lib/`. When the app provides a plugin's files, the incompatibility hint now says to update and restart the app instead of uninstall and reinstall.
