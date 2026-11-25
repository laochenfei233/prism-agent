---
type: fixed
breaking: false
audience: user
commits: 31673ad8
---
The Meetings page loads its records again

The shipped base composition mounted the meeting service and its model-facing tools, and the client module roster therefore also served the Meetings page. Its browser routes came only from the separately installed plugin bundle, so every request from the page answered a plain-text 404 and the page showed the browser's JSON parser message, "The string did not match the expected pattern." The base bundle now composes the page's browser routes beside the service row, and an answer that carries no JSON envelope is reported by its HTTP status.
