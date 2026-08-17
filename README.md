# NNIT Studio

NNIT Studio is a global-first music creation platform inside the NNIT Enterprise ecosystem. This repository is a professional full-stack foundation for desktop, web, mobile, API, audio processing, AI assistance, collaboration, subscriptions, marketplace and NNIT ID / NNIT Pay integration.

## Included

- Multitrack project model, recording metadata, takes, clips, buses, sends and automation
- Mixer architecture with EQ, dynamics, reverb, delay, saturation, stereo, limiting and metering descriptors
- Mastering workflow with loudness targets and export profiles
- MIDI / piano roll / drum-machine / sampler project models
- AI jobs for stem separation, denoise, vocal isolation, BPM/key detection, mix assistance and mastering assistance
- Web studio dashboard
- Electron desktop host
- Expo mobile companion
- Fastify TypeScript API
- WebSocket-ready collaboration service interface and version-history API model
- Subscription, marketplace and NNIT Pay integration interfaces
- NNIT ID authentication integration points
- SQLite development database initializer and production database abstraction
- Docker compose, health checks and one-command bootstraps

## One-command setup

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; .\NNIT-STUDIO.ps1
```

### macOS/Linux

```bash
chmod +x ./nnit-studio.sh && ./nnit-studio.sh
```

The bootstrap copies `.env.example` to `.env`, installs dependencies, initializes the development database and starts API + web by default.

## Important engineering boundary

The repository provides a real runnable product foundation and DSP/API architecture. Commercial-grade real-time pitch correction, source separation, low-latency native audio drivers, proprietary codecs and mature DAW-grade DSP require specialized native DSP/ML implementations or licensed SDKs. Integration points are included so those engines can be added without redesigning the product.
