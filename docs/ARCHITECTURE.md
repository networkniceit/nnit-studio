# Architecture

## Product surfaces
1. Desktop professional studio: low-latency production shell and future native audio host.
2. Web studio: projects, editing, collaboration, AI jobs, publishing, billing and administration.
3. Mobile companion: capture, remote review, approvals, collaboration and project management.
4. API: identity, projects, audio assets, AI orchestration, collaboration, subscription, marketplace and payments.

## Professional audio roadmap already represented in the project model
- Audio/MIDI/instrument/bus/master tracks
- Non-destructive clips and takes
- Inserts, sends, buses, automation
- Transport, tempo, key, metronome and recording states
- EQ/dynamics/spatial/color/mastering processor descriptors
- LUFS/true-peak mastering targets
- WAV/FLAC/MP3/stem export service boundary
- VST3/AU plugin host boundary for native desktop phase
- ASIO/CoreAudio/WASAPI device layer boundary for native desktop phase

## AI layer
AI runs as jobs so heavy inference can execute locally, on GPU workers, or through a licensed external provider. The API contract stays stable across providers.

## NNIT Enterprise integration
NNIT ID is the account authority. NNIT Pay is the billing/payment provider boundary. Country/currency/locale data belongs on the NNIT profile so Studio remains global-first.
