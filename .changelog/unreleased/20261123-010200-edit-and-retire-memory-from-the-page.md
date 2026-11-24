---
type: added
breaking: false
audience: user
commits:
---
The memory page can now rewrite a claim and retire one. An edit supersedes the old wording and inherits the record's layer, class, scope, and tags, so the supersede chain keeps the old wording readable and `/memory restore` rolls an edit back; retirement takes the same path as `/memory forget`. Project- and conversation-scoped claims stay under their session's authority: the page lists them, and the new routes refuse them.
