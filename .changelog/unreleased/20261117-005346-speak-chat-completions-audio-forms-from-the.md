---
type: added
breaking: false
audience: user
commits: f5baf8f73f
draft: true
---
The config-driven HTTP speech provider can speak the audio-bearing chat-completions request form (mode: `chat-completions`) beside the OpenAI multipart transcription form, so chat-completions ASR endpoints such as MiMo-V2.5-ASR join voice input and the meetings page by configuration alone; recognition reads the answer's `choices[0].message.content`.
