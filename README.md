# oto

**oto** is an MCP app that turns text into speech. From any MCP host (e.g. Claude), you ask it to read the current text aloud — it converts the text to audio with the OpenAI text-to-speech API and renders an audio player right in the conversation.

## What it does

- **Text to audio** — a `text_to_speech` tool takes the current text and generates an audio file via OpenAI TTS.
- **Inline player** — the generated audio shows up as an interactive player UI inside the MCP host: play it, close it.
- **History** — every audio you generate is saved; browse and replay your previous generations.
- **Authenticated** — the server requires sign-in before use. Auth is handled by Supabase (used exclusively for authentication).

## Stack

- **TypeScript** end to end.
- **MCP server** (remote, Streamable HTTP) with an embedded UI for the audio player.
- **OpenAI API** for text-to-speech generation.
- **Supabase** for authentication only.
- **Railway** for hosting the backend, the database, and object storage for the audio files.

## Status

Early exploration — currently investigating the stack and setting up project configuration.
