from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json, os, time, wave, struct, math, uuid

HOST='127.0.0.1'
PORT=int(os.environ.get('NNIT_LOCAL_AI_PORT','8765'))

def wav_analysis(path):
    if not path or not os.path.exists(path):
        return {"error":"media path not found"}
    try:
        with wave.open(path,'rb') as w:
            n=w.getnframes(); ch=w.getnchannels(); rate=w.getframerate(); width=w.getsampwidth()
            if width != 2:
                return {"error":"basic V9 analyzer currently supports 16-bit PCM WAV"}
            raw=w.readframes(min(n, rate*120))
            vals=struct.unpack('<'+'h'*(len(raw)//2),raw)
            if not vals: return {"error":"empty WAV"}
            peak=max(abs(x) for x in vals)/32768.0
            rms=math.sqrt(sum((x/32768.0)**2 for x in vals)/len(vals))
            db=lambda x: 20*math.log10(max(x,1e-9))
            return {"channels":ch,"sampleRate":rate,"duration":n/rate,"peakDb":db(peak),"rmsDb":db(rms),"estimatedLufs":db(rms)-0.7}
    except Exception as e:
        return {"error":str(e)}

def process_job(job):
    typ=str(job.get('type',''))
    settings=job.get('settings') or {}
    media_path=settings.get('mediaPath') or job.get('mediaPath')
    if typ in ('mastering-assistant','mix-assistant'):
        analysis=wav_analysis(media_path) if media_path else {}
        return {"status":"completed","worker":"nnit-local-ai-v9","result":{"mode":"analysis-assistant","analysis":analysis,"recommendations":{"targetLufs":-14,"ceilingDbtp":-1.0,"note":"V9 local worker provides deterministic analysis/recommendations; neural mastering model is not bundled."}}}
    if typ in ('denoise','stem-separation','vocal-isolation','vocal-tuning'):
        return {"status":"needs-model","worker":"nnit-local-ai-v9","result":{"type":typ,"adapter":"model-required","message":"Connect an ONNX/PyTorch/local model adapter to execute this neural job. V9 does not fabricate output."}}
    return {"status":"completed","worker":"nnit-local-ai-v9","result":{"type":typ,"message":"Job accepted by local worker."}}

class H(BaseHTTPRequestHandler):
    def sendj(self,status,obj):
        raw=json.dumps(obj).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path=='/health': return self.sendj(200,{"ok":True,"service":"nnit-local-ai","version":"0.16.0","pid":os.getpid()})
        if self.path=='/capabilities': return self.sendj(200,{"reachable":True,"capabilities":[{"type":"mix-assistant","mode":"local-analysis"},{"type":"mastering-assistant","mode":"local-analysis"},{"type":"denoise","mode":"adapter-required"},{"type":"stem-separation","mode":"adapter-required"},{"type":"vocal-isolation","mode":"adapter-required"},{"type":"vocal-tuning","mode":"adapter-required"},{"type":"key-bpm","mode":"analysis-adapter"},{"type":"mix-assistant","mode":"local-analysis"},{"type":"mastering-assistant","mode":"local-analysis"}]})
        return self.sendj(404,{"error":"Not found"})
    def do_POST(self):
        if self.path!='/jobs': return self.sendj(404,{"error":"Not found"})
        try:
            length=int(self.headers.get('Content-Length','0')); job=json.loads(self.rfile.read(length) or b'{}')
            result=process_job(job); result["jobId"]=job.get("id") or str(uuid.uuid4()); result["finishedAt"]=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
            return self.sendj(200,result)
        except Exception as e:
            return self.sendj(400,{"error":str(e)})

if __name__=='__main__':
    print(f'NNIT Local AI Worker V9 listening on http://{HOST}:{PORT}')
    ThreadingHTTPServer((HOST,PORT),H).serve_forever()
