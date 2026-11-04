---
type: added
breaking: false
audience: user
commits: pending
---
Session rows now carry their own filing marks: favorite, review-later, a 1–5 priority, up to 20 tags, and a note, all set from the row menu's new entries or the Tags & note… dialog. The marks show in the row, View options can filter the list and search to favorites or review-later and order by priority, and search matches tag and note text. The dialog's Copy prompt and Import move an annotation through the clipboard without calling a model. A batch mode entered from the header's checklist button puts a checkbox on every row and runs archive, unarchive, favorite, unfavorite, review-later, priority, or clear-tags over the selection, then reports how many succeeded and failed. Annotations stay in this browser, and a Session still cannot be moved to another Workspace, because its working directory lives in the immutable Session header that decides Workspace membership.
