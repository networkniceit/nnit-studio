import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const PORT = Number(process.env.PORT || process.env.NNIT_NATIVE_HOST_PORT || 8766);
const HOST = process.env.HOST || '0.0.0.0';

let config = {
  driverMode: 'WASAPI Shared',
  sampleRate: 48000,
  bufferSize: 256,
  exclusiveMode: false
};

let engine = {
  running: false,
  startedAt: null,
  xruns: 0,
  cpuLoad: 0,
  lastError: null
};

const json = (res, status, data) => {
  const responseBody = JSON.stringify(data);

  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(responseBody)
  });

  res.end(responseBody);
};

const body = async (req) =>
  new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });

function ps(script) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve([]);
    }

    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script
      ],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          return resolve([]);
        }

        try {
          const value = JSON.parse(stdout);
          resolve(Array.isArray(value) ? value : [value]);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function devices() {
  const audio = await ps(`
    Get-CimInstance Win32_SoundDevice |
    Select-Object Name,Manufacturer,Status,PNPDeviceID |
    ConvertTo-Json -Compress
  `);

  const endpoints = await ps(`
    Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue |
    Select-Object FriendlyName,Status,InstanceId |
    ConvertTo-Json -Compress
  `);

  return {
    audio,
    endpoints,
    midi: [],
    platform: process.platform,
    note: 'MIDI hardware enumeration is completed in Electron/Web MIDI; ASIO driver enumeration requires the compiled ASIO adapter.'
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || '127.0.0.1'}`
    );

    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, {
        ok: true,
        service: 'nnit-native-host',
        version: '0.39.0'
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'nnit-native-host',
        version: '0.39.0',
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        audioHost: 'service-boundary-ready',
        vst3HostLoaded: false,
        asioAdapterLoaded: false
      });
    }

    if (req.method === 'GET' && url.pathname === '/devices') {
      return json(res, 200, await devices());
    }

    if (req.method === 'GET' && url.pathname === '/audio/devices') {
      return json(res, 200, {
        backend: 'native-host-sandbox',
        inputs: [
          {
            id: 'input-default',
            name: 'System Default Input',
            channels: 2,
            sampleRates: [44100, 48000, 96000]
          }
        ],
        outputs: [
          {
            id: 'output-default',
            name: 'System Default Output',
            channels: 2,
            sampleRates: [44100, 48000, 96000]
          }
        ]
      });
    }

    if (req.method === 'GET' && url.pathname === '/audio/status') {
      return json(res, 200, {
        status: 'ready',
        backend: 'native-host-sandbox',
        lowLatencyNativeDriver: false,
        recordingAdapter: true
      });
    }

    if (req.method === 'GET' && url.pathname === '/render/status') {
      return json(res, 200, {
        status: 'ready',
        offlineRenderAdapter: true,
        formats: ['wav', 'flac', 'mp3'],
        realDspRender: false
      });
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      return json(res, 200, config);
    }

    if (req.method === 'POST' && url.pathname === '/configure') {
      const requestBody = await body(req);

      config = {
        ...config,
        ...requestBody
      };

      return json(res, 200, {
        ok: true,
        config
      });
    }

    if (req.method === 'POST' && url.pathname === '/plugins/validate') {
      const requestBody = await body(req);
      const pluginPath = String(requestBody.path || '');

      return json(res, 200, {
        path: pluginPath,
        exists: fs.existsSync(pluginPath),
        format: pluginPath.toLowerCase().endsWith('.vst3')
          ? 'VST3'
          : 'unknown',
        loadable: false,
        reason:
          'V39 validates and isolates plugin paths; Steinberg VST3 SDK native loader is not bundled.'
      });
    }

    if (req.method === 'GET' && url.pathname === '/engine/status') {
      return json(res, 200, {
        ...engine,
        driverMode: config.driverMode,
        sampleRate: config.sampleRate,
        bufferSize: config.bufferSize,
        estimatedBufferLatencyMs:
          (Number(config.bufferSize) / Number(config.sampleRate)) * 1000,
        estimatedRoundTripMs:
          (Number(config.bufferSize) / Number(config.sampleRate)) * 2000,
        nativeDsp: false
      });
    }

    if (req.method === 'POST' && url.pathname === '/engine/start') {
      engine = {
        ...engine,
        running: true,
        startedAt: new Date().toISOString(),
        lastError: null
      };

      return json(res, 200, {
        ok: true,
        ...engine,
        config
      });
    }

    if (req.method === 'POST' && url.pathname === '/engine/stop') {
      engine = {
        ...engine,
        running: false
      };

      return json(res, 200, {
        ok: true,
        ...engine
      });
    }

    if (req.method === 'POST' && url.pathname === '/render/offline') {
      const requestBody = await body(req);

      return json(res, 200, {
        status: 'adapter-ready',
        jobId: String(requestBody.jobId || ''),
        rendered: false,
        progress: 0,
        reason: 'Native offline DSP renderer not linked yet'
      });
    }

    if (req.method === 'POST' && url.pathname === '/render/cancel') {
      const requestBody = await body(req);

      return json(res, 200, {
        status: 'cancel-requested',
        jobId: String(requestBody.jobId || '')
      });
    }

    return json(res, 404, {
      error: 'Not found'
    });
  } catch (error) {
    console.error(error);

    return json(res, 500, {
      error: 'Internal server error'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `NNIT Native Host V39 listening on http://${HOST}:${PORT}`
  );
});