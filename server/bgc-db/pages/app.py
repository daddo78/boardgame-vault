"""Rulebook pages: holds an uploaded PDF only while Nathan reads it, and hands out one page at a time.

  PUT    /doc/<id>          body = the PDF  -> {"pages": 28, "sha256": "..."}
  GET    /doc/<id>/page/<n>                  -> {"text": "<the page's own text>", "jpeg_b64": "<the page as an image>"}
  DELETE /doc/<id>                           -> {"ok": true}   (the PDF is gone; only the text Nathan wrote is kept)
  GET    /health

Only n8n can reach it (the Docker network; no ports are published). PDFs live in /work and are never backed up.
"""
import base64, hashlib, io, json, os, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pypdfium2 as pdfium

WORK = os.environ.get('WORK', '/work')
MAX_BYTES = int(os.environ.get('MAX_BYTES', str(60 * 1024 * 1024)))
LOCK = threading.Lock()  # pdfium is not thread-safe
ID = re.compile(r'^[A-Za-z0-9-]{1,40}$')


def path(doc):
    return os.path.join(WORK, doc + '.pdf')


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        m = re.match(r'^/doc/([^/]+)(?:/page/(\d+))?$', self.path.split('?')[0])
        if not m or not ID.match(m.group(1)):
            return None, None
        return m.group(1), (int(m.group(2)) if m.group(2) else None)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        doc, page = self.route()
        if not doc or not page:
            return self.reply(404, {'error': 'not found'})
        if not os.path.exists(path(doc)):
            return self.reply(404, {'error': 'no such document'})
        try:
            with LOCK:
                pdf = pdfium.PdfDocument(path(doc))
                try:
                    if page > len(pdf):
                        return self.reply(404, {'error': 'no such page'})
                    p = pdf[page - 1]
                    tp = p.get_textpage()
                    text = tp.get_text_range()
                    tp.close()
                    bitmap = p.render(scale=1.6)
                    img = bitmap.to_pil().convert('RGB')
                    bitmap.close()
                    p.close()
                finally:
                    pdf.close()
            img.thumbnail((1400, 1800))
            buf = io.BytesIO()
            img.save(buf, 'JPEG', quality=82)
        except Exception as e:  # say what went wrong instead of dropping the connection
            print('page error', doc, page, repr(e), flush=True)
            return self.reply(500, {'error': 'could not read that page'})
        self.reply(200, {'text': text.replace('\r', ''), 'jpeg_b64': base64.b64encode(buf.getvalue()).decode()})

    def do_PUT(self):
        doc, page = self.route()
        if not doc or page:
            return self.reply(404, {'error': 'not found'})
        size = int(self.headers.get('Content-Length') or 0)
        if size <= 0 or size > MAX_BYTES:
            return self.reply(413, {'error': 'That PDF is too big (the limit is %d MB).' % (MAX_BYTES // 1048576)})
        data = self.rfile.read(size)
        try:
            with LOCK:
                pdf = pdfium.PdfDocument(data)
                pages = len(pdf)
                pdf.close()
        except Exception:
            return self.reply(400, {'error': 'That file isn’t a PDF we can read.'})
        with open(path(doc), 'wb') as f:
            f.write(data)
        self.reply(200, {'pages': pages, 'sha256': hashlib.sha256(data).hexdigest()})

    def do_DELETE(self):
        doc, page = self.route()
        if not doc or page:
            return self.reply(404, {'error': 'not found'})
        try:
            os.remove(path(doc))
        except FileNotFoundError:
            pass
        self.reply(200, {'ok': True})

    def log_message(self, fmt, *args):  # quiet: one line per request is plenty
        print(self.command, self.path.split('?')[0], flush=True)


if __name__ == '__main__':
    os.makedirs(WORK, exist_ok=True)
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
