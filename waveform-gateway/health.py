from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json, threading

def serve(port,status):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in ('/','/health','/stations'):
                self.send_response(404); self.end_headers(); return
            body=json.dumps({
                'ok':True,
                'service':'SISMO PERU WAVEFORM GATEWAY',
                'version':'2.3.0',
                'status':status
            },default=str).encode()
            self.send_response(200)
            self.send_header('content-type','application/json')
            self.send_header('cache-control','no-store')
            self.send_header('content-length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self,*a): pass
    s=ThreadingHTTPServer(('0.0.0.0',port),H)
    threading.Thread(target=s.serve_forever,daemon=True).start()
    return s
