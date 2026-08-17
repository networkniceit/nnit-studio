# NNIT Studio V2

Functional full-stack development build.

Implemented in V2:
- Persistent project create/read/update/delete (JSON local store)
- Track create/delete and persisted mixer state
- Browser microphone recording with MediaRecorder; clips persist through API as data URLs (development only)
- Clip playback in project timeline
- BPM/project editing
- Mastering analysis workflow endpoint
- AI job orchestration adapters (clearly marked provider-required, not fake inference)
- WebSocket collaboration channel foundation
- Cloud status + marketplace API endpoints
- Desktop/mobile workspaces retained
- NNIT ID / NNIT Pay integration architecture retained

## Windows one-command start
From the project root:

`Set-ExecutionPolicy -Scope Process Bypass -Force; .\NNIT-STUDIO-V2.ps1`

Open http://localhost:5173/

## Production note
The V2 browser recorder and JSON/data-URL persistence are functional development implementations. A commercial DAW release must replace them with native low-latency audio/DSP, binary object storage, waveform rendering, professional codec/export workers, licensed/provider-backed AI, hardened auth, billing, cloud storage and database services.
